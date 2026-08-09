import { useCallback, useEffect, useRef, useState } from 'react'
import { findTurnAt, type Turn } from '../lib/turns'

/**
 * Playback across two never-mixed tracks.
 *
 * The two audio tracks are separate files by design — mic is "me", system is
 * "them", and that split is what gives speaker attribution for free. **That
 * invariant is about storage and attribution, not monitoring.** Both elements
 * play together here and the browser mixes them; the files are never modified
 * and the speaker labels never depend on this.
 *
 * ## Why this used to play one track at a time, and why that was wrong
 *
 * Playback previously followed the transcript: mic.wav during a "me" turn,
 * system.wav during a "them" turn, one element ever running. The stated reason
 * was drift — two media clocks resynced only at handoffs — plus decoding twice.
 *
 * It made the meeting impossible to hear as it happened. Reported from a
 * headset recording: the far end plays, the user interjects, and the video
 * *disappears* for the length of the interjection, then resumes having skipped
 * that stretch. All three behaviours were correct in isolation — a headset mic
 * genuinely contains no far-end audio (measured: median -74.9 dB, 3.7 dB above
 * its own noise floor), and the handoff seeks to the shared clock, so whatever
 * played underneath the interjection is simply never heard.
 *
 * The moment that destroys is exactly the moment worth reviewing: overlapping
 * speech is where the transcript is least reliable, so it is where a user most
 * needs the audio, and it was the one thing single-track playback could not
 * reproduce. Every comparable tool (Zoom, Riverside, Descript) records separate
 * tracks and plays back mixed for the same reason.
 *
 * ## How the two elements stay together
 *
 * One element owns the clock and the other follows it. The **system** track
 * owns it: it is the full-length continuous recording, and a session may have
 * no mic track at all, while the reverse is far rarer.
 *
 * Drift is handled by correction rather than by avoidance — the follower is
 * nudged back whenever it strays past `MAX_DRIFT_MS`, checked on `timeupdate`,
 * which already fires. Seeking a playing element is audible, so the threshold
 * has to sit above normal jitter; see `MAX_DRIFT_MS`.
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
 * How far the follower may drift from the clock owner before being resynced.
 *
 * A correction is a seek on a playing element, which is audible — so this must
 * sit above ordinary jitter or it would chatter constantly and sound worse than
 * the drift it fixes. `timeupdate` fires only ~4-66×/s and its timestamps are
 * quantised, so tens of milliseconds of apparent error are normal and mean
 * nothing.
 *
 * 120 ms is below the ~150-200 ms where an offset between two voices starts to
 * read as an echo, and well above that jitter. The tracks come from independent
 * Core Audio clients with free-running clocks — the same fact that makes AEC
 * impossible (see `bleed.ts`) — so real drift does accumulate and does need
 * correcting; it just accumulates slowly enough that corrections are rare.
 */
const MAX_DRIFT_MS = 120

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

  const available = Boolean(urls && (urls.mic || urls.system))
  const durationMs = turns.length > 0 ? (turns[turns.length - 1]?.endMs ?? 0) : 0

  /**
   * Every element that actually exists. A session recorded with no microphone
   * has no mic.wav, and one whose audio was partly discarded may have either.
   */
  const elements = useCallback(
    (): HTMLAudioElement[] =>
      [micRef.current, systemRef.current].filter((el): el is HTMLAudioElement => el !== null),
    [micRef, systemRef],
  )

  /**
   * The element driving the shared clock.
   *
   * The system track by preference: it is the full-length continuous recording,
   * and the mic track is the one that can be missing entirely. Falls back to the
   * mic so a system-less session still plays.
   */
  const clockOwner = useCallback(
    (): HTMLAudioElement | null => systemRef.current ?? micRef.current,
    [micRef, systemRef],
  )

  /**
   * Put every track at `ms` and optionally start them.
   *
   * Both elements are seeked, not just the audible one — there is no "audible
   * one" any more. Each element's own file may be shorter than the session
   * (the mic track routinely is), and seeking past the end of a file is
   * harmless: it simply sits at its end contributing silence, which is exactly
   * what that track contains at that moment.
   */
  const locate = useCallback(
    (ms: number, shouldPlay: boolean): void => {
      if (!available) return

      const clamped = Math.max(0, ms)

      for (const el of elements()) {
        el.playbackRate = rate
        el.currentTime = clamped / 1000
      }

      setPositionMs(clamped)
      setActiveIndex(findTurnAt(turns, clamped))

      if (shouldPlay) {
        for (const el of elements()) {
          // `play()` rejects if the element is torn down mid-call (session
          // switch, drawer close). That is not an error worth surfacing.
          void el.play().catch(() => {})
        }
        setPlaying(true)
      }
    },
    [available, elements, rate, turns],
  )

  const play = useCallback((): void => {
    if (!available) return
    // Reaching the end and pressing play again restarts, rather than sitting
    // silently at a playhead that cannot advance.
    const from = positionMs !== null && positionMs < durationMs ? positionMs : 0
    locate(from, true)
  }, [available, positionMs, durationMs, locate])

  const pause = useCallback((): void => {
    for (const el of elements()) el.pause()
    setPlaying(false)
  }, [elements])

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
      // Both elements, always: they play together, so a rate applied to one
      // would pull them apart at a rate no drift correction could keep up with.
      for (const el of elements()) el.playbackRate = r
    },
    [elements],
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
    (_track: Track, el: HTMLAudioElement): void => {
      // Only the clock owner moves the playhead. Both elements fire this, and
      // letting the follower write the position would make the playhead jitter
      // between two slightly different clocks.
      const owner = clockOwner()
      if (!owner || el !== owner) return

      const ms = el.currentTime * 1000
      setPositionMs(ms)

      const index = findTurnAt(turns, ms)
      setActiveIndex(index)

      if (!playing) return

      /*
       * Drift correction.
       *
       * Only ever corrects the follower, never the owner — moving the owner
       * would move the playhead itself and fight the user's own seeks. A
       * follower whose file has already ended is left alone: it is legitimately
       * parked at its end contributing silence, and seeking it would be both
       * pointless and audible.
       */
      for (const other of elements()) {
        if (other === owner || other.ended) continue
        if (Math.abs(other.currentTime - el.currentTime) * 1000 > MAX_DRIFT_MS) {
          other.currentTime = el.currentTime
        }
      }

      // Past the last turn there is no more transcript, so stop rather than
      // playing out the remaining room tone on whichever file is longer.
      if (index === turns.length - 1 && ms > durationMs) {
        pause()
        setPositionMs(durationMs)
      }
    },
    [turns, playing, pause, durationMs, clockOwner, elements],
  )

  /**
   * Element `ended` is one file running out, which is not the transcript
   * ending — the tracks are different lengths, and the mic track is routinely
   * the shorter one.
   *
   * So the shorter file simply stops contributing and the other plays on. Only
   * the clock owner running out ends playback, and even then the transcript may
   * genuinely continue past it, which `onTimeUpdate` handles by position.
   */
  const onEnded = useCallback(
    (track: Track): void => {
      const owner = clockOwner()
      const el = track === 'mic' ? micRef.current : systemRef.current
      if (!owner || el !== owner) return
      pause()
    },
    [clockOwner, micRef, systemRef, pause],
  )

  // Reset when the session changes. Without this, opening a second meeting
  // shows the first one's playhead until something moves it.
  useEffect(() => {
    setPlaying(false)
    setPositionMs(null)
    setActiveIndex(-1)
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
