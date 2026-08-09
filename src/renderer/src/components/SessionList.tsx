import { useMemo } from 'react'
import type { Session, SessionStatus } from '@shared/types'
import { formatSessionTime, groupByDate } from '../lib/dateGroups'

interface Props {
  sessions: Session[]
  selected: string | null
  onSelect: (id: string) => void
}

export function SessionList({ sessions, selected, onSelect }: Props): React.JSX.Element {
  /**
   * `now` is captured per grouping rather than read inside the grouper so the
   * bucket boundaries don't shift mid-render. Recomputing only when the
   * session array changes is right: the cost of a heading being one bucket
   * stale until the next recording is nil, and a timer that regrouped the
   * sidebar at midnight would be more machinery than the problem deserves.
   */
  const groups = useMemo(() => groupByDate(sessions, new Date()), [sessions])

  if (sessions.length === 0) {
    return (
      <nav className="flex-1 px-4 pt-2">
        <p className="text-xs text-(--color-ink-faint)">Recordings appear here.</p>
      </nav>
    )
  }

  return (
    <nav className="flex-1 overflow-y-auto px-2 pb-2">
      {groups.map((group) => (
        <section key={group.key} className="mb-1">
          {/*
            Date headings, not folders. Meetily #424 — "a flat list… becomes
            difficult to manage as the number of meetings grows" — is a real
            complaint, but folders imply move/rename, drag-and-drop and an
            "unfiled" concept, which is a lot of v1 surface for a problem
            grouping mostly solves (UI.md §5).
          */}
          <h2 className="sticky top-0 z-10 bg-(--color-ground)/85 px-2 py-1.5 text-[11px] font-semibold text-(--color-ink-faint) backdrop-blur">
            {group.label}
          </h2>

          {group.sessions.map((s) => (
            <button
              key={s.id}
              // mousedown, not click: selection is not cancellable, and acting
              // on press saves ~50 ms of perceived latency (UI.md §9).
              onMouseDown={() => onSelect(s.id)}
              className={`mb-0.5 flex w-full flex-col gap-0.5 rounded-md px-2 py-1.5 text-left transition-colors ${
                selected === s.id
                  ? 'bg-(--color-raised) text-(--color-ink)'
                  : 'hover:bg-(--color-raised)/60'
              }`}
            >
              <span className="truncate text-[13px] font-medium text-(--color-ink)">{s.title}</span>
              <span className="flex items-center gap-1.5 text-[11px] text-(--color-ink-faint) tabular-nums">
                {formatSessionTime(s.startedAt)}
                <span aria-hidden>·</span>
                {Math.max(1, Math.round(s.durationSeconds / 60))}m
                <StatusBadge status={s.status} />
              </span>
            </button>
          ))}
        </section>
      ))}
    </nav>
  )
}

/**
 * Status per row (UI.md §5).
 *
 * A session mid-transcription must say so — otherwise a recording that is
 * merely queued is indistinguishable from one that came back empty, and the
 * user concludes the app lost their meeting. `ready` gets no badge at all:
 * the normal case should be quiet.
 */
function StatusBadge({ status }: { status: SessionStatus }): React.JSX.Element | null {
  if (status === 'ready') return null

  const label: Record<Exclude<SessionStatus, 'ready'>, string> = {
    recording: 'recording',
    pending: 'queued',
    transcribing: 'transcribing',
    failed: 'failed',
  }

  const tone =
    status === 'failed'
      ? 'text-(--color-live)'
      : status === 'recording'
        ? 'text-(--color-live)'
        : 'text-(--color-them)'

  return (
    <>
      <span aria-hidden>·</span>
      <span className={tone}>{label[status]}</span>
    </>
  )
}
