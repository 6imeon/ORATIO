import { useMemo } from 'react'
import type { Session, SessionStatus } from '@shared/types'
import { formatSessionTime, groupByDate } from '../lib/dateGroups'

interface Props {
  sessions: Session[]
  selected: string | null
  onSelect: (id: string) => void
  /** Opens the confirmation; the list never deletes anything itself. */
  onDelete: (id: string) => void
}

export function SessionList({
  sessions,
  selected,
  onSelect,
  onDelete,
}: Props): React.JSX.Element {
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
            /*
              A wrapper rather than a single button, because the delete control
              has to be a button of its own and buttons cannot nest. `group`
              keeps it hidden until the row is hovered or something inside it
              is focused — a delete affordance on every row at rest turns the
              sidebar into a minefield, but one that appears only on hover is
              unreachable by keyboard, hence `focus-within` too.
            */
            <div key={s.id} className="group relative">
              <button
                // mousedown, not click: selection is not cancellable, and acting
                // on press saves ~50 ms of perceived latency (UI.md §9).
                onMouseDown={() => onSelect(s.id)}
                className={`mb-0.5 flex w-full flex-col gap-0.5 rounded-md py-1.5 pr-8 pl-2 text-left transition-colors ${
                  selected === s.id
                    ? 'bg-(--color-raised) text-(--color-ink)'
                    : 'hover:bg-(--color-raised)/60'
                }`}
              >
                <span className="truncate text-[13px] font-medium text-(--color-ink)">
                  {s.title}
                </span>
                <span className="flex items-center gap-1.5 text-[11px] text-(--color-ink-faint) tabular-nums">
                  {formatSessionTime(s.startedAt)}
                  <span aria-hidden>·</span>
                  {Math.max(1, Math.round(s.durationSeconds / 60))}m
                  <StatusBadge status={s.status} />
                </span>
              </button>

              {/*
                Absent entirely while this session is recording. Main refuses
                that delete anyway, but a control that exists only to produce
                an error is worse than no control — and mid-recording is
                exactly when a mis-click would cost the most.
              */}
              {s.status !== 'recording' && (
                <button
                  type="button"
                  aria-label={`Delete ${s.title}`}
                  title="Delete meeting"
                  // Click, not mousedown: this one IS cancellable, and it is
                  // the destructive control in the row.
                  onClick={() => onDelete(s.id)}
                  className="absolute top-1.5 right-1 rounded p-1 text-(--color-ink-faint) opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 hover:bg-(--color-ground) hover:text-(--color-live) focus-visible:opacity-100"
                >
                  <TrashIcon />
                </button>
              )}
            </div>
          ))}
        </section>
      ))}
    </nav>
  )
}

function TrashIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 20 20" className="size-3.5" fill="currentColor" aria-hidden="true">
      <path d="M8 2h4a1 1 0 0 1 1 1v1h3.5a.75.75 0 0 1 0 1.5h-.6l-.7 10.1A2.5 2.5 0 0 1 12.7 18H7.3a2.5 2.5 0 0 1-2.5-2.4L4.1 5.5h-.6a.75.75 0 0 1 0-1.5H7V3a1 1 0 0 1 1-1Zm.5 2h3v-.5h-3V4ZM6.3 15.5a1 1 0 0 0 1 .9h5.4a1 1 0 0 0 1-.9l.7-10H5.6l.7 10Z" />
    </svg>
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
