import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ProviderConfig, ProviderId, Session, Transcript } from '@shared/types'
import { DeleteSessionDialog } from '../components/DeleteSessionDialog'
import { ExportMenu } from '../components/ExportMenu'
import { SummaryPane } from '../components/SummaryPane'
import { TranscriptDrawer } from '../components/TranscriptDrawer'
import { useDrawerState } from '../hooks/useDrawerState'
import { useSummary } from '../hooks/useSummary'
import { findTurnAt, mergeTurns } from '../lib/turns'

/** Shown in the button tooltip and the provenance line, so it has to be a name
 * the user would recognise from the outside world, not our internal id. */
const PROVIDER_LABELS: Record<ProviderId, string> = {
  ollama: 'Ollama',
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  openrouter: 'OpenRouter',
}

/**
 * The provider that would actually run, or null if none would.
 *
 * Re-read whenever a summary run ends, because auto-detect can select Ollama
 * in the background after this window has already loaded — without that, a
 * user who starts Ollama and comes back finds the button still disabled with
 * no way to discover why.
 */
function useActiveProvider(): ProviderConfig | null {
  const [provider, setProvider] = useState<ProviderConfig | null>(null)

  useEffect(() => {
    let cancelled = false
    const load = async (): Promise<void> => {
      const [providers, settings] = await Promise.all([
        window.oratio.ai.providers(),
        window.oratio.settings.get(),
      ])
      if (cancelled) return
      const active = providers.find((p) => p.id === settings.activeProvider && p.enabled)
      // A cloud provider with no key in the Keychain cannot run, and offering
      // the button anyway would produce an error at click time instead of an
      // explanation now.
      const usable = active && (active.id === 'ollama' || active.hasApiKey) ? active : null
      setProvider(usable ?? null)
    }

    void load()
    const off = window.oratio.on.aiDone(() => void load())
    return () => {
      cancelled = true
      off()
    }
  }, [])

  return provider
}

interface Props {
  session: Session
  /** Clear the selection once this meeting no longer exists. */
  onDeleted: (id: string) => void
}

/**
 * Layout J: notes at full width, transcript in a drawer at the bottom.
 *
 * The notes pane is the primary surface, not an afterthought — what the user
 * types during the meeting is what steers the AI summary later. Closed, this
 * view *is* the notebook: the widest writing column available and the calmest
 * page. Opening the drawer is purely additive (UI.md §3a).
 */
export function MeetingView({ session, onDeleted }: Props): React.JSX.Element {
  const sessionId = session.id
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [notes, setNotes] = useState('')
  const [transcript, setTranscript] = useState<Transcript | null>(null)
  const [activeMs, setActiveMs] = useState<number | null>(null)
  const [revealTurn, setRevealTurn] = useState<number | null>(null)
  const drawer = useDrawerState(sessionId)
  const summary = useSummary(sessionId)
  const provider = useActiveProvider()

  const cloud = provider !== null && provider.id !== 'ollama'
  const providerLabel = provider ? PROVIDER_LABELS[provider.id] : null
  const canSummarize = provider !== null && transcript !== null

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

  // ⌘E — the shortcut shown on the button. Bound on window rather than the
  // textarea so it works while the transcript drawer has focus.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'e' || !(e.metaKey || e.ctrlKey)) return
      e.preventDefault()
      if (summary.status === 'running') summary.cancel()
      else if (canSummarize) summary.summarize()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [summary, canSummarize])

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

        {/*
          Disabled rather than hidden when there is nothing to summarise. A
          button that appears once transcription finishes would be a control
          the user never learns exists; one that is visibly unavailable, with
          the reason in its tooltip, teaches the sequence.
        */}
        <div
          className="flex items-center gap-2"
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        >
          <ExportMenu sessionId={sessionId} hasTranscript={transcript !== null} />

          {/*
            Plain text, not an icon. A trash can beside Export would be the
            most dangerous control in the window rendered as the least
            legible one, and it is not used often enough to earn the
            ambiguity. Never disabled — deleting a failed or still-queued
            meeting is a normal thing to want, and main refuses the one case
            that is unsafe (the session being recorded right now).
          */}
          <button
            type="button"
            onClick={() => setConfirmDelete(true)}
            className="rounded-md border border-transparent px-2.5 py-1 text-[11px] text-(--color-ink-faint) hover:border-(--color-line) hover:bg-(--color-raised) hover:text-(--color-live)"
          >
            Delete
          </button>

          {summary.status === 'running' ? (
            <button
              type="button"
              onClick={summary.cancel}
              className="rounded-md border border-(--color-line) px-2.5 py-1 text-[11px] text-(--color-ink-dim) hover:bg-(--color-raised)"
            >
              Stop
            </button>
          ) : (
            <button
              type="button"
              onClick={summary.summarize}
              disabled={!canSummarize}
              title={
                canSummarize
                  ? cloud
                    ? `Sends this transcript to ${providerLabel}`
                    : `Summarises locally with ${providerLabel}`
                  : transcript
                    ? 'No summariser configured — see Settings'
                    : 'Available once this meeting has been transcribed'
              }
              className="rounded-md border border-(--color-line) px-2.5 py-1 text-[11px] text-(--color-ink-dim) hover:bg-(--color-raised) disabled:opacity-40 disabled:hover:bg-transparent"
            >
              {summary.hasSummary ? 'Summarise again' : 'Summarise'}
              <span className="ml-1.5 text-(--color-ink-faint)">⌘E</span>
            </button>
          )}
        </div>
      </header>

      {/*
        The notes textarea keeps its full height whatever the drawer is doing.
        The drawer is absolutely positioned over it rather than a flex sibling
        on purpose: a sibling would reflow the textarea on every pointer event
        of a drag, and reflowing a large text field at pointer rate is exactly
        the kind of work UI.md §0 says never to put on a drag path.

        The column scrolls only once a summary exists. Without one the textarea
        fills the pane and behaves exactly as it did before — the writing
        surface does not shrink to make room for a feature the user has not
        used.
      */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Jot down what matters. Your notes guide the summary."
          spellCheck
          className="w-full resize-none bg-transparent px-5 text-[13px] leading-relaxed text-(--color-ink) outline-none placeholder:text-(--color-ink-faint)"
          style={{
            // Grows with the text once there is a summary below it, so the
            // two read as one document rather than a box above a panel.
            height: summary.hasSummary || summary.status === 'running' ? 'auto' : '100%',
            minHeight: summary.hasSummary ? '8rem' : undefined,
            // Reserve the closed handle's height so the last line of notes is
            // never hidden behind it.
            paddingBottom: summary.hasSummary
              ? '1rem'
              : `calc(${(drawer.fraction * 100).toFixed(2)}% + 3rem)`,
          }}
        />

        <SummaryPane summary={summary} cloud={cloud} providerLabel={providerLabel} />

        {/* Clears the drawer handle at the foot of the scrolled column. */}
        {summary.hasSummary && (
          <div style={{ height: `calc(${(drawer.fraction * 100).toFixed(2)}% + 3rem)` }} />
        )}
      </div>

      <TranscriptDrawer
        sessionId={sessionId}
        turns={turns}
        transcribed={transcript !== null}
        drawer={drawer}
        activeMs={activeMs}
        onActiveTime={onActiveTime}
        revealTurn={revealTurn}
        mutedRanges={session.mutedRanges}
      />

      {/* Reset after the reveal lands so the same turn can be revealed twice. */}
      <RevealReset revealTurn={revealTurn} onDone={onRevealDone} />

      {confirmDelete && (
        <DeleteSessionDialog
          session={session}
          hasAudio={session.hasAudio}
          onClose={() => setConfirmDelete(false)}
          onDeleted={onDeleted}
        />
      )}
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
