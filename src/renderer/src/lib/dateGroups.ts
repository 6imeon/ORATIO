import type { Session } from '@shared/types'

/**
 * Sessions bucketed by recency, for the sidebar.
 *
 * Meetily #424: "all recordings and notes are displayed in a flat list, which
 * becomes difficult to manage as the number of meetings grows" (UI.md §5).
 * Date headings make a long list navigable without any folder feature —
 * folders imply move/rename UI, drag-and-drop, and an "unfiled" concept, which
 * is a lot of v1 surface for a problem grouping mostly solves.
 */
export interface SessionGroup {
  /** Stable across renders for a given bucket; used as the React key. */
  key: string
  label: string
  sessions: Session[]
}

/**
 * `now` is a parameter rather than a `Date.now()` call so the boundaries are
 * testable and so a component can pass a value that only changes when it
 * intends a regroup — recomputing "Today" mid-render on every keystroke would
 * make the group list a new array identity every time.
 */
export function groupByDate(sessions: readonly Session[], now: Date): SessionGroup[] {
  const startOfToday = new Date(now)
  startOfToday.setHours(0, 0, 0, 0)

  const dayMs = 86_400_000
  const yesterday = startOfToday.getTime() - dayMs
  // "This week" means the last seven days, not the calendar week: on a Monday
  // a calendar week is one day long, which puts last Friday's meeting under a
  // month heading and looks broken.
  const weekAgo = startOfToday.getTime() - 6 * dayMs
  const monthAgo = startOfToday.getTime() - 29 * dayMs

  const buckets = new Map<string, SessionGroup>()
  const order: string[] = []

  const push = (key: string, label: string, session: Session): void => {
    let group = buckets.get(key)
    if (!group) {
      group = { key, label, sessions: [] }
      buckets.set(key, group)
      order.push(key)
    }
    group.sessions.push(session)
  }

  // Newest first, so the buckets come out in order and no sort is needed after.
  const sorted = [...sessions].sort((a, b) => b.startedAt.localeCompare(a.startedAt))

  for (const s of sorted) {
    const t = new Date(s.startedAt).getTime()
    // An unparseable date must not silently vanish from the sidebar — a
    // session the user can't see is a session they think we lost.
    if (Number.isNaN(t)) {
      push('unknown', 'Undated', s)
      continue
    }

    if (t >= startOfToday.getTime()) push('today', 'Today', s)
    else if (t >= yesterday) push('yesterday', 'Yesterday', s)
    else if (t >= weekAgo) push('week', 'This week', s)
    else if (t >= monthAgo) push('month', 'This month', s)
    else {
      // Older than a month collapses to month-and-year headings, which keeps
      // a two-year vault navigable without a folder tree.
      const d = new Date(t)
      const key = `${d.getFullYear()}-${d.getMonth()}`
      push(key, d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' }), s)
    }
  }

  return order.map((k) => buckets.get(k)).filter((g): g is SessionGroup => g !== undefined)
}

/** Time for today's sessions, date for everything older. */
export function formatSessionTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const today = new Date()
  return d.toDateString() === today.toDateString()
    ? d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
    : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}
