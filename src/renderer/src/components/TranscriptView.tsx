import { useCallback, useEffect, useRef, useState } from 'react'
import { findTurnAt, formatClock, type Turn } from '../lib/turns'

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
 * Two <audio> elements, one per track, because the tracks are never mixed:
 * a "me" line plays from mic.wav, a "them" line from system.wav.
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

  // Null for both tracks means the audio was discarded — this session was
  // recorded with "don't keep audio", so there is nothing to play and the
  // lines must not pretend to be clickable.
  const hasAudio = Boolean(urls && (urls.mic || urls.system))

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

  const onTimeUpdate = useCallback(
    (el: HTMLAudioElement) => {
      // Binary search, not a linear scan — 66×/s over a few thousand turns
      // (UI.md §4).
      setActive(findTurnAt(turns, el.currentTime * 1000))
    },
    [turns, setActive],
  )

  function play(turn: Turn): void {
    if (!hasAudio) return
    const el = turn.speaker === 'me' ? micRef.current : systemRef.current
    const other = turn.speaker === 'me' ? systemRef.current : micRef.current
    if (!el) return

    other?.pause()
    // Timestamps are on a shared clock across both tracks, so seeking is a
    // direct conversion with no per-track offset maths here.
    el.currentTime = turn.startMs / 1000
    void el.play()
    setActive(turn.index)
  }

  function stopAll(): void {
    micRef.current?.pause()
    systemRef.current?.pause()
    setActive(-1)
  }

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
    <div ref={scrollRef} className="h-full overflow-y-auto overscroll-contain px-5 py-3">
      {urls?.mic && (
        <audio
          ref={micRef}
          src={urls.mic}
          preload="metadata"
          onTimeUpdate={(e) => onTimeUpdate(e.currentTarget)}
          onEnded={stopAll}
        />
      )}
      {urls?.system && (
        <audio
          ref={systemRef}
          src={urls.system}
          preload="metadata"
          onTimeUpdate={(e) => onTimeUpdate(e.currentTarget)}
          onEnded={stopAll}
        />
      )}

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
          register={(node) => {
            if (node) rowRefs.current.set(turn.index, node)
            else rowRefs.current.delete(turn.index)
          }}
        />
      ))}

      {turns.length === 0 && (
        <p className="py-4 text-sm text-(--color-ink-dim)">
          No speech was detected in this recording.
        </p>
      )}
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
function TurnRow({
  turn,
  hasAudio,
  onPlay,
  register,
}: {
  turn: Turn
  hasAudio: boolean
  onPlay: (t: Turn) => void
  register: (node: HTMLElement | null) => void
}): React.JSX.Element {
  const mine = turn.speaker === 'me'

  return (
    <div
      ref={register}
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
}
