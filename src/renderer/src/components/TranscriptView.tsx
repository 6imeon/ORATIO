import { memo, useCallback, useEffect, useRef, useState } from 'react'
import { formatClock, type Turn } from '../lib/turns'
import { computeBalance } from '../lib/balance'
import { usePlayback } from '../hooks/usePlayback'
import { TransportBar } from './TransportBar'

interface Props {
  sessionId: string
  /**
   * Already merged into speaker turns by the caller, so a two-hour transcript
   * is folded once rather than on every open of the drawer (UI.md §4).
   */
  turns: Turn[]
  /**
   * Turn to scroll to when the drawer opens. The drawer is a *targeted*
   * reveal, not a dumb toggle — that is the mitigation that makes layout J's
   * one real cost (notes and transcript not both full size) acceptable
   * (UI.md §3a).
   */
  revealTurn?: number | null
  /** Active timestamp, so the collapsed handle can show it while playing. */
  onActiveTime?: (ms: number | null) => void
}

/**
 * The transcript, as speaker turns with click-to-play.
 *
 * Clicking any line seeks the audio to that moment — the feature users most
 * often say is missing from the commercial tools, and one Granola
 * structurally cannot offer because it keeps no audio at all.
 *
 * Two <audio> elements, one per track, played TOGETHER and mixed by the
 * browser — so the meeting is heard as it happened, including the overlaps.
 * The files are never modified and attribution never depends on this; see
 * `usePlayback` for why single-track playback was wrong.
 */
export function TranscriptView({
  sessionId,
  turns,
  revealTurn,
  onActiveTime,
}: Props): React.JSX.Element {
  const micRef = useRef<HTMLAudioElement>(null)
  const systemRef = useRef<HTMLAudioElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const [urls, setUrls] = useState<{ mic: string | null; system: string | null } | null>(null)

  /**
   * Row DOM nodes, for the highlight path below. A ref map rather than state
   * because writing it must not re-render.
   */
  const rowRefs = useRef(new Map<number, HTMLElement>())
  const activeRef = useRef(-1)

  useEffect(() => {
    void (async () => {
      const [mic, system] = await Promise.all([
        window.oratio.session.audioUrl(sessionId, 'mic'),
        window.oratio.session.audioUrl(sessionId, 'system'),
      ])
      setUrls({ mic, system })
    })()
  }, [sessionId])

  /**
   * Level-match the two tracks, once per session.
   *
   * The system track is a digital tap near full scale and the mic is an acoustic
   * capture, so mixing them raw buries the near-end speaker — measured at 18-27
   * dB apart depending on the microphone, and the gap is device-dependent, so
   * this is derived per session rather than fixed.
   *
   * ## Why `element.volume` and not a WebAudio gain graph
   *
   * Boosting the quiet track would be the better correction — it keeps the mix
   * at a normal listening level instead of pulling everything down to meet the
   * mic. It needs WebAudio, because `volume` is capped at 1.0 and can only
   * attenuate.
   *
   * That was built and **it silences playback**. `createMediaElementSource`
   * reroutes an element into the graph permanently, and in this renderer the
   * audio then never reaches the output: measured with both elements at
   * `readyState: 4`, unmuted, `volume: 1`, no media error, and the context
   * `running` with unity gain — every observable healthy, and no sound. The
   * cause was not identified; what is recorded here is that the approach does
   * not work in this environment, so that it is not attempted again blind.
   *
   * So the loud track is attenuated instead. The cost is real and known: the
   * whole mix sits at the quieter track's level (about -46 dBFS on a headset
   * recording), so the user turns their system volume up. Audible and quiet
   * beats balanced and silent.
   */
  useEffect(() => {
    if (!urls?.mic || !urls.system) return
    let cancelled = false

    void (async () => {
      const ctx = new AudioContext()
      try {
        const [mic, system] = await Promise.all(
          [urls.mic, urls.system].map(async (url) =>
            ctx.decodeAudioData(await (await fetch(url!)).arrayBuffer()),
          ),
        )
        if (cancelled) return

        const balance = computeBalance(mic ?? null, system ?? null)
        if (micRef.current) micRef.current.volume = balance.mic
        if (systemRef.current) systemRef.current.volume = balance.system
      } catch {
        // Leave both at full volume — an unbalanced mix beats no audio, and a
        // decode failure must not take the transcript view down with it.
        if (micRef.current) micRef.current.volume = 1
        if (systemRef.current) systemRef.current.volume = 1
      } finally {
        // Only ever used to read samples, never for playback, so it is closed
        // immediately rather than holding an audio unit open.
        void ctx.close()
      }
    })()

    return () => {
      cancelled = true
    }
  }, [urls])

  /**
   * All transport state lives in the hook: one playhead on the shared session
   * clock, two elements taking turns being the one that runs. This view owns
   * only the rendering of it.
   */
  const playback = usePlayback(turns, urls, micRef, systemRef)

  // Null for both tracks means the audio was discarded — this session was
  // recorded with "don't keep audio", so there is nothing to play and the
  // lines must not pretend to be clickable.
  const hasAudio = playback.available

  /**
   * Move the highlight.
   *
   * This is the Vibe crash class in the exact place it bites: `timeupdate`
   * fires up to 66×/s, and doing this through React state would put
   * reconciliation on that path. Four separate Vibe issues are titled "UI
   * crashes with a removeChild DOM error" from mutating the tree here
   * instead (UI.md §1).
   *
   * So this only ever adds and removes a class on an already-rendered node.
   * It never inserts, never removes, never reorders. Adding and removing
   * nodes stays React's job exclusively.
   */
  const setActive = useCallback(
    (index: number) => {
      if (index === activeRef.current) return

      rowRefs.current.get(activeRef.current)?.classList.remove('turn-active')
      const node = rowRefs.current.get(index)
      node?.classList.add('turn-active')
      activeRef.current = index

      // Only on *change*, never on every tick, and `nearest` so a turn already
      // on screen doesn't yank the view while the user is reading it.
      node?.scrollIntoView({ block: 'nearest' })
      onActiveTime?.(index >= 0 ? (turns[index]?.startMs ?? null) : null)
    },
    [turns, onActiveTime],
  )

  /**
   * Mirror the hook's active turn onto the DOM.
   *
   * The hook computes the index (binary search, off `timeupdate`); this moves
   * the class. Keeping the two separate is what keeps React reconciliation off
   * a path that fires 66×/s — see `setActive` above.
   */
  useEffect(() => {
    setActive(playback.activeIndex)
  }, [playback.activeIndex, setActive])

  /**
   * Clicking a line plays from it — unless it is the line already playing, in
   * which case it pauses. Clicking the playing line and having it jump back to
   * its own start is the behaviour that made pausing impossible before.
   *
   * Read through a ref rather than closed over directly: `playback` gets a new
   * identity on every `timeupdate`, so a plain dependency here would hand
   * every row a fresh `onPlay` 66×/s and re-render the entire transcript.
   * The ref keeps `play` stable for the life of the view.
   */
  const playbackRef = useRef(playback)
  playbackRef.current = playback

  const play = useCallback((turn: Turn): void => {
    const p = playbackRef.current
    if (!p.available) return
    if (p.playing && p.activeIndex === turn.index) p.pause()
    else p.playTurn(turn)
  }, [])

  /**
   * Row registration, stable for the life of the view.
   *
   * `TurnRow` is memoised, so every prop it receives has to keep its identity
   * across renders or the memo does nothing — an inline `register` closure
   * per row would defeat it on the very first re-render.
   */
  const register = useCallback((index: number, node: HTMLElement | null): void => {
    if (node) rowRefs.current.set(index, node)
    else rowRefs.current.delete(index)
  }, [])

  // Targeted reveal. Runs after paint so the row exists; `center` rather than
  // `nearest` because arriving here means the user asked to be taken
  // somewhere, and landing at the very edge of the viewport doesn't read as
  // an answer.
  useEffect(() => {
    if (revealTurn == null) return
    const node = rowRefs.current.get(revealTurn)
    node?.scrollIntoView({ block: 'center' })
    setActive(revealTurn)
  }, [revealTurn, setActive])

  return (
    <div className="flex h-full flex-col">
      {urls?.mic && (
        <audio
          ref={micRef}
          src={urls.mic}
          /* Both tracks play together, so both must be buffered before the
             first play — "metadata" leaves the second one stalling audibly at
             the start. These are local files, so there is no bandwidth cost. */
          preload="auto"
          onTimeUpdate={(e) => playback.onTimeUpdate('mic', e.currentTarget)}
          onEnded={() => playback.onEnded('mic')}
        />
      )}
      {urls?.system && (
        <audio
          ref={systemRef}
          src={urls.system}
          /* Both tracks play together, so both must be buffered before the
             first play — "metadata" leaves the second one stalling audibly at
             the start. These are local files, so there is no bandwidth cost. */
          preload="auto"
          onTimeUpdate={(e) => playback.onTimeUpdate('system', e.currentTarget)}
          onEnded={() => playback.onEnded('system')}
        />
      )}

      {hasAudio && turns.length > 0 && <TransportBar playback={playback} />}

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-3">
        {urls && !hasAudio && (
          <p className="mb-2 text-xs text-(--color-ink-faint)">
            Audio was discarded for this meeting. The transcript is all that was kept.
          </p>
        )}

        {turns.map((turn) => (
          <TurnRow
            key={turn.index}
            turn={turn}
            hasAudio={hasAudio}
            onPlay={play}
            register={register}
          />
        ))}

        {turns.length === 0 && (
          <p className="py-4 text-sm text-(--color-ink-dim)">
            No speech was detected in this recording.
          </p>
        )}
      </div>
    </div>
  )
}

/**
 * One turn, as a paragraph with a hanging indent.
 *
 * Not a chat bubble. Granola uses grey-left/green-right bubbles, which maps
 * neatly onto our two tracks — but the same review called the result "a
 * one-sided WhatsApp", and bubbles halve horizontal text density, which over
 * two hours is a great deal of scrolling for no information gained (UI.md §4).
 *
 * A <div> with an explicit click handler rather than a <button>: a button
 * containing a paragraph of prose fights text selection, and selecting across
 * the whole transcript is one of the four things we do that Granola doesn't.
 * Keyboard access is restored with role/tabIndex/Enter rather than given up.
 */
const TurnRow = memo(function TurnRow({
  turn,
  hasAudio,
  onPlay,
  register,
}: {
  turn: Turn
  hasAudio: boolean
  onPlay: (t: Turn) => void
  register: (index: number, node: HTMLElement | null) => void
}): React.JSX.Element {
  const mine = turn.speaker === 'me'

  return (
    <div
      ref={(node) => register(turn.index, node)}
      // `mousedown`, not click: the action is not cancellable, and acting on
      // press rather than release saves ~50 ms of perceived latency — VS
      // Code's measurement (UI.md §9).
      onMouseDown={() => onPlay(turn)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onPlay(turn)
        }
      }}
      role={hasAudio ? 'button' : undefined}
      tabIndex={hasAudio ? 0 : undefined}
      /*
       * Deliberately static — "Play from 2:14" rather than flipping to
       * "Pause". A label that tracked playback would have to be a prop, and a
       * prop that changes on every play/pause re-renders every row in the
       * transcript, which is exactly the cost `content-visibility` is here to
       * avoid. The transport bar carries the live play/pause state instead.
       */
      aria-label={hasAudio ? `Play from ${formatClock(turn.startMs)}` : undefined}
      // `turn` carries content-visibility; see styles.css.
      className={`turn group -mx-2 rounded-md px-2 py-2 transition-colors focus-visible:ring-2 focus-visible:ring-(--color-me) focus-visible:outline-none ${
        hasAudio ? 'cursor-pointer hover:bg-(--color-raised)' : ''
      }`}
    >
      <p className="mb-0.5 flex items-baseline gap-2">
        <span
          className={`text-xs font-semibold ${mine ? 'text-(--color-me)' : 'text-(--color-them)'}`}
        >
          {turn.speakerLabel ?? (mine ? 'You' : 'Them')}
        </span>
        {/*
          One timestamp per turn, at the handoff — not one per ASR segment.
          W3C: timestamps "only when useful"; the useful moment is the change
          of speaker (UI.md §4).
        */}
        <time className="font-mono text-[11px] tabular-nums text-(--color-ink-faint)">
          {formatClock(turn.startMs)}
        </time>
      </p>
      {/*
        Hanging indent: the speaker label sits proud and the prose aligns in a
        single column, so the eye tracks one left edge down a long transcript.
      */}
      <p className="pl-3 text-[13px] leading-relaxed text-(--color-ink)">{turn.text}</p>
    </div>
  )
})
