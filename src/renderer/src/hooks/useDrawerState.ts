import { useCallback, useEffect, useState } from 'react'

/**
 * Closed (handle only), half (the default open size), or full.
 *
 * Three states rather than two because the two-state version forces a choice
 * between "can see notes" and "can read transcript" on every toggle, and the
 * common case — glance at the transcript while still writing — wants neither
 * extreme (UI.md §3a).
 */
export type DrawerState = 'closed' | 'half' | 'full'

/** Fraction of the meeting pane the drawer occupies in each state. */
export const DRAWER_HEIGHT: Record<DrawerState, number> = {
  closed: 0,
  half: 0.5,
  full: 0.92,
}

/**
 * Drag is free-form, so a dragged height has to land in a state when released.
 * These are the midpoints between the canonical heights.
 */
function nearestState(fraction: number): DrawerState {
  if (fraction < 0.12) return 'closed'
  if (fraction < 0.71) return 'half'
  return 'full'
}

const CYCLE: DrawerState[] = ['closed', 'half', 'full']

/**
 * Persisted in localStorage, not in meta.json or Settings.
 *
 * meta.json is the recording's own record and is read by the transcription
 * queue on a later launch — putting view state there means the queue's input
 * changes when someone drags a divider. Settings is global, and this is
 * per-session. localStorage is the honest home for it: renderer-local,
 * per-session, and costless to lose. "Plain files are the source of truth"
 * governs content; a drawer height is not content.
 */
const KEY_PREFIX = 'oratio.drawer.'

function load(sessionId: string): DrawerState {
  try {
    const raw = localStorage.getItem(KEY_PREFIX + sessionId)
    if (raw === 'closed' || raw === 'half' || raw === 'full') return raw
  } catch {
    // Private-mode or quota failures are not worth surfacing — the drawer
    // just opens at its default instead.
  }
  return 'closed'
}

export interface DrawerHandle {
  state: DrawerState
  /** 0..1 of the available height. Tracks the pointer during a drag. */
  fraction: number
  dragging: boolean
  set: (next: DrawerState) => void
  /** closed → half → full → closed. Bound to double-click on the handle. */
  cycle: () => void
  /** ⌘T. Returns to the last open size rather than always to half. */
  toggle: () => void
  /** Live drag: `f` is 0..1, unsnapped. */
  drag: (f: number) => void
  /** Release: snaps to the nearest state and persists it. */
  endDrag: () => void
}

export function useDrawerState(sessionId: string): DrawerHandle {
  const [state, setState] = useState<DrawerState>(() => load(sessionId))
  const [dragFraction, setDragFraction] = useState<number | null>(null)
  /**
   * Where ⌘T reopens to. Without it, toggling a full-height drawer closed and
   * open again silently demotes it to half, which reads as the app forgetting
   * what you did one keystroke ago.
   */
  const [lastOpen, setLastOpen] = useState<DrawerState>('half')

  // Re-read on session change rather than remounting the whole drawer: the
  // <audio> elements live below and remounting them would drop playback.
  useEffect(() => {
    const restored = load(sessionId)
    setState(restored)
    if (restored !== 'closed') setLastOpen(restored)
    setDragFraction(null)
  }, [sessionId])

  const persist = useCallback(
    (next: DrawerState) => {
      setState(next)
      if (next !== 'closed') setLastOpen(next)
      try {
        localStorage.setItem(KEY_PREFIX + sessionId, next)
      } catch {
        // Ignored deliberately — see `load`.
      }
    },
    [sessionId],
  )

  const cycle = useCallback(() => {
    const at = CYCLE.indexOf(state)
    persist(CYCLE[(at + 1) % CYCLE.length] ?? 'half')
  }, [state, persist])

  const toggle = useCallback(() => {
    persist(state === 'closed' ? lastOpen : 'closed')
  }, [state, lastOpen, persist])

  const endDrag = useCallback(() => {
    if (dragFraction === null) return
    persist(nearestState(dragFraction))
    setDragFraction(null)
  }, [dragFraction, persist])

  return {
    state,
    fraction: dragFraction ?? DRAWER_HEIGHT[state],
    dragging: dragFraction !== null,
    set: persist,
    cycle,
    toggle,
    drag: setDragFraction,
    endDrag,
  }
}
