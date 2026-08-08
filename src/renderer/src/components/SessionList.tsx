import type { Session } from '@shared/types'

interface Props {
  sessions: Session[]
  selected: string | null
  onSelect: (id: string) => void
}

export function SessionList({ sessions, selected, onSelect }: Props): React.JSX.Element {
  return (
    <nav className="flex-1 overflow-y-auto px-2 pb-2">
      {sessions.map((s) => (
        <button
          key={s.id}
          onClick={() => onSelect(s.id)}
          className={`mb-0.5 flex w-full flex-col gap-0.5 rounded-md px-2 py-2 text-left transition-colors ${
            selected === s.id
              ? 'bg-neutral-200 dark:bg-neutral-800'
              : 'hover:bg-neutral-100 dark:hover:bg-neutral-900'
          }`}
        >
          <span className="truncate text-sm font-medium">{s.title}</span>
          <span className="flex items-center gap-1.5 text-xs text-neutral-500">
            {formatDate(s.startedAt)}
            <span aria-hidden>·</span>
            {Math.max(1, Math.round(s.durationSeconds / 60))}m
            {s.status === 'pending' && (
              <span className="text-amber-600 dark:text-amber-500">· transcribing</span>
            )}
          </span>
        </button>
      ))}
    </nav>
  )
}

function formatDate(iso: string): string {
  const d = new Date(iso)
  const today = new Date()
  const sameDay = d.toDateString() === today.toDateString()
  return sameDay
    ? d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
    : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}
