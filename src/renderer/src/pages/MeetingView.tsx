import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Session, Transcript } from '@shared/types'
import { TranscriptDrawer } from '../components/TranscriptDrawer'
import { useDrawerState } from '../hooks/useDrawerState'
import { findTurnAt, mergeTurns } from '../lib/turns'

interface Props {
  session: Session
}

/**
 * Layout J: notes at full width, transcript in a drawer at the bottom.
 *
 * The notes pane is the primary surface, not an afterthought — what the user
 * types during the meeting is what steers the AI summary later. Closed, this
 * view *is* the notebook: the widest writing column available and the calmest
 * page. Opening the drawer is purely additive (UI.md §3a).
 */
export function MeetingView({ session }: Props): React.JSX.Element {
  const sessionId = session.id
  const [notes, setNotes] = useState('')
  const [transcript, setTranscript] = useState<Transcript | null>(null)
  const [activeMs, setActiveMs] = useState<number | null>(null)
  const [revealTurn, setRevealTurn] = useState<number | null>(null)
  const drawer = useDrawerState(sessionId)

  /**
   * Merged once per transcript and shared with the drawer below.
   *
   * The memo lives here rather than in TranscriptView because both this
   * component (for the reveal) and the view (for rendering) need turns, and
   * merging a few thousand segments twice per transcript is exactly the kind
   * of avoidable work UI.md §4 says to memoise rather than repeat.
   */
  const turns = useMemo(
    () => (transcript ? mergeTurns(transcript.segments) : []),
    [transcript],
  )

  /**
   * Guards the autosave below. Without it, the effect fires once with the
   * empty initial state before the load resolves and overwrites the file with
   * "" — silently destroying the notes of every session you click into.
   */
  const loadedFor = useRef<string | null>(null)

  useEffect(() => {
    let cancelled = false
    loadedFor.current = null
    setActiveMs(null)
    setRevealTurn(null)

    void (async () => {
      const [n, t] = await Promise.all([
        window.oratio.session.getNotes(sessionId),
        window.oratio.session.transcript(sessionId),
      ])
      // A fast click through the sidebar can land two loads out of order;
      // without this the later session shows the earlier one's notes.
      if (cancelled) return
      setNotes(n)
      setTranscript(t)
      loadedFor.current = sessionId
    })()

    return () => {
      cancelled = true
    }
  }, [sessionId])

  // Debounced autosave — notes are plain markdown on disk, so every save is
  // just a file write the user could have made themselves.
  useEffect(() => {
    if (loadedFor.current !== sessionId) return
    const t = setTimeout(() => {
      void window.oratio.session.setNotes(sessionId, notes)
    }, 600)
    return () => clearTimeout(t)
  }, [notes, sessionId])

  // Transcription finishing while the session is open must fill the drawer;
  // otherwise a meeting recorded a minute ago reads "Transcribing…" until you
  // click away and back.
  useEffect(() => {
    return window.oratio.on.sessionChanged((id) => {
      if (id !== sessionId) return
      void window.oratio.session.transcript(sessionId).then(setTranscript)
    })
  }, [sessionId])

  const onActiveTime = useCallback((ms: number | null) => setActiveMs(ms), [])
  const onRevealDone = useCallback(() => setRevealTurn(null), [])

  /**
   * The targeted reveal (UI.md §3a). The drawer is not a dumb toggle — it
   * opens *at* something.
   *
   * Reopening while audio is playing lands on the turn being played rather
   * than at the top of a two-hour transcript, which is the difference between
   * "checking what was just said" and "scrolling to find it". Search-hit and
   * citation reveals will hang off the same prop.
   *
   * `openedFrom` tracks the previous drawer state so this fires on the
   * closed → open edge only. Firing on every render would fight the user's
   * own scrolling.
   */
  const wasClosed = useRef(true)
  useEffect(() => {
    const open = drawer.state !== 'closed'
    if (open && wasClosed.current && activeMs !== null && turns.length > 0) {
      setRevealTurn(findTurnAt(turns, activeMs))
    }
    wasClosed.current = !open
  }, [drawer.state, activeMs, turns])

  return (
    <div className="relative flex h-full flex-col bg-(--color-ground)">
      <header
        className="flex h-11 shrink-0 items-center justify-between gap-3 px-5"
        style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
      >
        <div className="min-w-0">
          <h1 className="truncate text-sm font-semibold text-(--color-ink)">{session.title}</h1>
          <p className="truncate text-[11px] text-(--color-ink-faint) tabular-nums">
            {summaryLine(session, turns.length)}
          </p>
        </div>
      </header>

      {/*
        The notes textarea keeps its full height whatever the drawer is doing.
        The drawer is absolutely positioned over it rather than a flex sibling
        on purpose: a sibling would reflow the textarea on every pointer event
        of a drag, and reflowing a large text field at pointer rate is exactly
        the kind of work UI.md §0 says never to put on a drag path.
      */}
      <div className="min-h-0 flex-1">
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Jot down what matters. Your notes guide the summary."
          spellCheck
          className="h-full w-full resize-none bg-transparent px-5 pb-12 text-[13px] leading-relaxed text-(--color-ink) outline-none placeholder:text-(--color-ink-faint)"
          style={{
            // Reserve the closed handle's height so the last line of notes is
            // never hidden behind it.
            paddingBottom: `calc(${(drawer.fraction * 100).toFixed(2)}% + 3rem)`,
          }}
        />
      </div>

      <TranscriptDrawer
        sessionId={sessionId}
        turns={turns}
        transcribed={transcript !== null}
        drawer={drawer}
        activeMs={activeMs}
        onActiveTime={onActiveTime}
        revealTurn={revealTurn}
      />

      {/* Reset after the reveal lands so the same turn can be revealed twice. */}
      <RevealReset revealTurn={revealTurn} onDone={onRevealDone} />
    </div>
  )
}

function RevealReset({
  revealTurn,
  onDone,
}: {
  revealTurn: number | null
  onDone: () => void
}): null {
  useEffect(() => {
    if (revealTurn === null) return
    const t = setTimeout(onDone, 400)
    return () => clearTimeout(t)
  }, [revealTurn, onDone])
  return null
}

function summaryLine(session: Session, turnCount: number): string {
  const when = new Date(session.startedAt)
  const parts = [
    Number.isNaN(when.getTime())
      ? ''
      : when.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }),
    `${Math.max(1, Math.round(session.durationSeconds / 60))} min`,
  ].filter(Boolean)
  if (turnCount > 0) parts.push(`${turnCount} turns`)
  else if (session.status === 'pending' || session.status === 'transcribing') {
    parts.push('transcribing')
  }
  return parts.join(' · ')
}
