import { useCallback, useEffect, useRef, useState } from 'react'
import { findTurnAt, type Turn } from '../lib/turns'

/**
 * Playback across two never-mixed tracks.
 *
 * The two audio tracks are separate files by design — mic is "me", system is
 * "them", and that split is what gives speaker attribution for free. It also
 * means playback is not "press play on a file": at every handoff the sound has
 * to move to the other element, seeking it to the shared session clock.
 *
 * So there is one logical playhead, in session-clock milliseconds, and two
 * elements that take turns being the one that is actually running. Everything
 * below exists to keep that single playhead coherent.
 *
 * Only one element ever plays at a time. Playing both and muting one would
 * drift — two independent media clocks resynced only at handoffs — and would
 * also decode twice for no audible gain.
 */

export type Track = 'mic' | 'system'

export interface PlaybackHandle {
  /** True while sound is actually coming out. */
  playing: boolean
  /** Position on the shared session clock, or null when nothing is loaded. */
  positionMs: number | null
  /** Index of the turn under the playhead, -1 before the first turn. */
  activeIndex: number
  /** End of the last turn — the transcript's own duration, not a file's. */
  durationMs: number
  /** False when the audio was discarded; the UI must not offer transport. */
  available: boolean
  play: () => void
  pause: () => void
  toggle: () => void
  /** Seek on the shared clock. Keeps playing if it was playing. */
  seek: (ms: number) => void
  /** Jump to a turn and start playing from it. */
  playTurn: (turn: Turn) => void
  /** Move by ±n ms from where we are. */
  nudge: (ms: number) => void
  /** Previous/next speaker handoff, the natural unit for a transcript. */
  step: (direction: -1 | 1) => void
  rate: number
  setRate: (r: number) => void
  /** Attached to each <audio> by the view; the hook owns what they mean. */
  onTimeUpdate: (track: Track, el: HTMLAudioElement) => void
  onEnded: (track: Track) => void
}

/**
 * How far past a turn's end we allow the element to run before handing over.
 *
 * The tracks are continuous recordings, so the "them" track is still rolling
 * (as room tone) underneath a "me" turn. Cutting at exactly `endMs` would clip
 * the last syllable whenever ASR's end timestamp lands slightly early, which it
 * routinely does. A short tail is more forgiving than a hard cut and is
 * inaudible when the timestamps are accurate.
 */
const HANDOFF_TAIL_MS = 250

export function usePlayback(
  turns: Turn[],
  urls: { mic: string | null; system: string | null } | null,
  micRef: React.RefObject<HTMLAudioElement | null>,
  systemRef: React.RefObject<HTMLAudioElement | null>,
): PlaybackHandle {
  const [playing, setPlaying] = useState(false)
  const [positionMs, setPositionMs] = useState<number | null>(null)
  const [activeIndex, setActiveIndex] = useState(-1)
  const [rate, setRateState] = useState(1)

  /**
   * Which element owns the playhead right now.
   *
   * A ref, not state: it is read inside event handlers that fire many times a
   * second, and changing it must not re-render on its own — the position
   * update that accompanies it already does.
   */
  const currentTrack = useRef<Track>('mic')

  const available = Boolean(urls && (urls.mic || urls.system))
  const durationMs = turns.length > 0 ? (turns[turns.length - 1]?.endMs ?? 0) : 0

  const elementFor = useCallback(
    (track: Track): HTMLAudioElement | null =>
      track === 'mic' ? micRef.current : systemRef.current,
    [micRef, systemRef],
  )

  /**
   * Which track should be audible at a given moment on the session clock.
   *
   * Driven by the transcript rather than by the audio: the turn under the
   * playhead names its speaker, and that speaker names the track. Before the
   * first turn there is nothing to attribute, so we stay on whichever track is
   * already loaded rather than jumping.
   */
  const trackAt = useCallback(
    (ms: number): Track => {
      const index = findTurnAt(turns, ms)
      const turn = index >= 0 ? turns[index] : undefined
      if (!turn) return currentTrack.current
      return turn.speaker === 'me' ? 'mic' : 'system'
    },
    [turns],
  )

  /**
   * Put the playhead at `ms`, on the right track, and optionally start it.
   *
   * This is the single place a handoff happens. It pauses the outgoing element
   * before seeking the incoming one, so there is never a moment where both are
   * running — which would double up the room tone audibly.
   */
  const locate = useCallback(
    (ms: number, shouldPlay: boolean): void => {
      if (!available) return

      const clamped = Math.max(0, ms)
      let track = trackAt(clamped)

      // Fall back to whichever track actually exists. A session recorded with
      // no microphone has no mic.wav at all, and its "them" turns must still
      // play rather than silently doing nothing.
      if (!elementFor(track)) track = track === 'mic' ? 'system' : 'mic'
      const el = elementFor(track)
      if (!el) return

      if (currentTrack.current !== track) {
        elementFor(currentTrack.current)?.pause()
        currentTrack.current = track
      }

      el.playbackRate = rate
      el.currentTime = clamped / 1000
      setPositionMs(clamped)
      setActiveIndex(findTurnAt(turns, clamped))

      if (shouldPlay) {
        // `play()` rejects if the element is torn down mid-call (session
        // switch, drawer close). That is not an error worth surfacing.
        void el.play().catch(() => {})
        setPlaying(true)
      }
    },
    [available, trackAt, elementFor, rate, turns],
  )

  const play = useCallback((): void => {
    if (!available) return
    // Reaching the end and pressing play again restarts, rather than sitting
    // silently at a playhead that cannot advance.
    const from = positionMs !== null && positionMs < durationMs ? positionMs : 0
    locate(from, true)
  }, [available, positionMs, durationMs, locate])

  const pause = useCallback((): void => {
    micRef.current?.pause()
    systemRef.current?.pause()
    setPlaying(false)
  }, [micRef, systemRef])

  const toggle = useCallback((): void => {
    if (playing) pause()
    else play()
  }, [playing, pause, play])

  const seek = useCallback(
    (ms: number): void => {
      locate(Math.min(ms, durationMs), playing)
    },
    [locate, durationMs, playing],
  )

  const playTurn = useCallback(
    (turn: Turn): void => {
      locate(turn.startMs, true)
    },
    [locate],
  )

  const nudge = useCallback(
    (ms: number): void => {
      seek(Math.max(0, (positionMs ?? 0) + ms))
    },
    [seek, positionMs],
  )

  /**
   * Move a whole turn at a time.
   *
   * Back inside a turn means "restart this turn" rather than "go to the
   * previous one" — the same convention as skip-back in a music player, and
   * the one people already expect from that gesture.
   */
  const step = useCallback(
    (direction: -1 | 1): void => {
      const here = findTurnAt(turns, positionMs ?? 0)
      const current = here >= 0 ? turns[here] : undefined

      if (direction === -1 && current && (positionMs ?? 0) - current.startMs > 2_000) {
        locate(current.startMs, playing)
        return
      }

      const next = turns[here + direction]
      if (next) locate(next.startMs, playing)
      else if (direction === -1) locate(0, playing)
    },
    [turns, positionMs, locate, playing],
  )

  const setRate = useCallback(
    (r: number): void => {
      setRateState(r)
      // Applied to both elements, not just the running one: the idle element
      // is mid-handoff away from being the running one, and a rate that only
      // takes effect at the next speaker change reads as a broken control.
      if (micRef.current) micRef.current.playbackRate = r
      if (systemRef.current) systemRef.current.playbackRate = r
    },
    [micRef, systemRef],
  )

  /**
   * The clock tick, and the handoff.
   *
   * `timeupdate` fires up to 66×/s. The position lands in state because the
   * transport needs to render it, but the *highlight* is moved by class
   * mutation upstream — see TranscriptView — so this does not put transcript
   * reconciliation on that path.
   */
  const onTimeUpdate = useCallback(
    (track: Track, el: HTMLAudioElement): void => {
      // A stale element still draining its buffer after a handoff must not
      // drag the playhead backwards.
      if (track !== currentTrack.current) return

      const ms = el.currentTime * 1000
      setPositionMs(ms)

      const index = findTurnAt(turns, ms)
      setActiveIndex(index)

      if (!playing) return

      const turn = index >= 0 ? turns[index] : undefined
      if (!turn) return

      /**
       * The handoff.
       *
       * The rule is positional, not transitional: the turn under the playhead
       * names the speaker, the speaker names the track, and if that is not the
       * track currently sounding then we are on the wrong one and must move.
       *
       * Phrasing it as "did we run past the previous turn's end" instead is
       * wrong whenever there is a gap between turns — the playhead crosses
       * into the next turn while still inside the tail window, the check does
       * not fire, and the whole turn plays from the other speaker's track.
       * That is silence at best and the wrong voice at worst.
       */
      const wanted: Track = turn.speaker === 'me' ? 'mic' : 'system'
      if (wanted !== track) {
        // Seek to wherever we already are, not to the turn's start: the
        // playhead is legitimately mid-turn after a scrub, and restarting the
        // turn would fight the user's seek.
        locate(Math.max(ms, turn.startMs), true)
        return
      }

      // Past the last turn there is no more transcript, so stop rather than
      // playing out the remaining room tone on whichever file is longer.
      if (index === turns.length - 1 && ms > turn.endMs + HANDOFF_TAIL_MS) {
        pause()
        setPositionMs(durationMs)
      }
    },
    [turns, playing, pause, locate, durationMs],
  )

  /**
   * Element `ended` is the file running out, which is not the same as the
   * transcript ending — the two tracks are different lengths. If there is more
   * transcript after this point, continue on the other track.
   */
  const onEnded = useCallback(
    (track: Track): void => {
      if (track !== currentTrack.current) return
      const index = findTurnAt(turns, positionMs ?? 0)
      const next = turns[index + 1]
      if (next && playing) locate(next.startMs, true)
      else pause()
    },
    [turns, positionMs, playing, locate, pause],
  )

  // Reset when the session changes. Without this, opening a second meeting
  // shows the first one's playhead until something moves it.
  useEffect(() => {
    setPlaying(false)
    setPositionMs(null)
    setActiveIndex(-1)
    currentTrack.current = 'mic'
  }, [urls])

  return {
    playing,
    positionMs,
    activeIndex,
    durationMs,
    available,
    play,
    pause,
    toggle,
    seek,
    playTurn,
    nudge,
    step,
    rate,
    setRate,
    onTimeUpdate,
    onEnded,
  }
}
