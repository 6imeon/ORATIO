import { useEffect, useState } from 'react'
import type { NavTarget } from '@shared/ipc'

/**
 * Where the window is pointed, driven by the tray.
 *
 * Two sources, because a tray click can arrive on either side of the window
 * existing: a live window is pushed `navigate`, while a window created *by*
 * that click was not listening yet and collects the parked target on mount.
 * Both land here so the rest of the UI has one answer to "what am I showing".
 */
export interface Navigation {
  /** The session to show, or null for the empty state. */
  sessionId: string | null
  settingsOpen: boolean
  select: (sessionId: string | null) => void
  openSettings: () => void
  closeSettings: () => void
}

export function useNavigation(): Navigation {
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)

  const apply = (target: NavTarget): void => {
    if (target.kind === 'settings') {
      setSettingsOpen(true)
      return
    }
    setSessionId(target.sessionId)
    // A Recent click means "show me this meeting", so a Settings pane left
    // open from earlier has to get out of the way — otherwise the sidebar
    // selection moves behind a panel and the click looks like it did nothing.
    setSettingsOpen(false)
  }

  useEffect(() => {
    // Collect first: this window may have been created by the very tray click
    // being handled, in which case the push already happened and was missed.
    void window.oratio.pendingNav().then((target) => {
      if (target) apply(target)
    })

    return window.oratio.on.navigate(apply)
  }, [])

  // ⌘, is the macOS convention and users reach for it without being told. The
  // tray carries the same accelerator, but the tray can be hidden when the
  // menu bar is crowded — this is the in-window path to the same place.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === ',' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        setSettingsOpen(true)
      }
      if (e.key === 'Escape') setSettingsOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return {
    sessionId,
    settingsOpen,
    select: setSessionId,
    openSettings: () => setSettingsOpen(true),
    closeSettings: () => setSettingsOpen(false),
  }
}
