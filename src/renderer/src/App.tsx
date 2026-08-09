import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Session, ThemePreference } from '@shared/types'
import { DeleteSessionDialog } from './components/DeleteSessionDialog'
import { SessionList } from './components/SessionList'
import { RecordButton } from './components/RecordButton'
import { MeetingView } from './pages/MeetingView'
import { SettingsView } from './pages/SettingsView'
import { FirstRunView } from './pages/FirstRunView'
import { useMicCapture } from './hooks/useMicCapture'
import { useNavigation } from './hooks/useNavigation'
import { useFirstRun } from './hooks/useFirstRun'
import { useTheme } from './hooks/useTheme'

export function App(): React.JSX.Element {
  const [sessions, setSessions] = useState<Session[]>([])
  const [micError, setMicError] = useState<string | null>(null)

  /**
   * The session the sidebar's trash button is asking about.
   *
   * Held here rather than in SessionList because a delete started from the
   * sidebar must be able to move the selection, and because the same dialog
   * serves the meeting header — one confirmation, two entry points.
   */
  const [pendingDelete, setPendingDelete] = useState<string | null>(null)

  // Selection is navigation, not local UI state: the tray can point this
  // window at a session that was recorded with nothing open.
  const nav = useNavigation()
  const selected = nav.sessionId

  const firstRun = useFirstRun()

  /**
   * Appearance lives here rather than in SettingsView because it styles the
   * whole window, and SettingsView is unmounted the moment it is closed — a
   * theme owned there would revert on Done. SettingsView reports changes back
   * up through `onThemeChange`.
   */
  const [theme, setTheme] = useState<ThemePreference>('system')
  useTheme(theme)

  useEffect(() => {
    void window.oratio.settings.get().then((s) => setTheme(s.theme))
  }, [])

  // Mounted at the root, not inside the record button: main decides when to
  // record, and this window's mic must keep running whatever the UI is showing.
  useMicCapture((err) => setMicError(err.message))

  const refresh = useCallback(async (): Promise<void> => {
    setSessions(await window.oratio.session.list())
  }, [])

  useEffect(() => {
    void refresh()
    return window.oratio.on.sessionChanged(() => void refresh())
  }, [refresh])

  /**
   * The selected session object, not just its id.
   *
   * MeetingView needs the title, duration and status for its header, and
   * looking them up here means the list is the single source for them — a
   * second fetch would let the header and the sidebar disagree about a
   * session that is still transcribing.
   */
  const current = useMemo(
    () => sessions.find((s) => s.id === selected) ?? null,
    [sessions, selected],
  )

  const sidebarDelete = useMemo(
    () => (pendingDelete ? (sessions.find((s) => s.id === pendingDelete) ?? null) : null),
    [sessions, pendingDelete],
  )

  /**
   * Where the selection goes when the selected meeting is deleted.
   *
   * Falling to the empty state would be technically correct and feel like the
   * app lost its place — you delete one meeting from a list of thirty and the
   * whole pane empties. Selecting the neighbour keeps you where you were, and
   * matches what Mail and Notes do. The list is already in display order, so
   * the neighbour is the next row, or the previous one when the last was
   * deleted.
   */
  const handleDeleted = useCallback(
    (id: string) => {
      setPendingDelete(null)
      if (id === selected) {
        const i = sessions.findIndex((s) => s.id === id)
        const next = sessions[i + 1] ?? sessions[i - 1] ?? null
        nav.select(next?.id ?? null)
      }
      // The main-process broadcast refreshes every window including this one,
      // but doing it here too means the row disappears on the same frame as
      // the dialog rather than one IPC round-trip later.
      void refresh()
    },
    [selected, sessions, nav, refresh],
  )

  /*
   * Setup replaces the whole window rather than appearing beside it.
   *
   * Without a model there is nothing the main UI can usefully do: recording
   * would succeed and transcription would fail afterwards, which is the worst
   * possible place to discover it. `checking` renders nothing at all — it
   * resolves in a single tick, and a flash of the empty state before the setup
   * screen would look like a bug.
   */
  if (firstRun.step === 'checking') return <div className="h-screen bg-(--color-ground)" />
  if (firstRun.step === 'model') {
    return (
      <FirstRunView
        settings={firstRun.settings}
        onReady={firstRun.recheck}
        onSkip={firstRun.skip}
      />
    )
  }

  return (
    <div className="flex h-screen bg-(--color-ground) text-(--color-ink)">
      <aside className="flex w-64 shrink-0 flex-col border-r border-(--color-line)">
        {/* Sits below the traffic lights — titleBarStyle is hiddenInset. */}
        <div className="h-11 shrink-0" style={{ WebkitAppRegion: 'drag' } as React.CSSProperties} />
        <div className="px-3 pb-3">
          <RecordButton onStopped={refresh} />
          {/*
            A denied mic prompt is a normal outcome, not a crash — the system
            track keeps recording, so the meeting is still captured minus your
            own voice. Saying so beats a silent half-recording.
          */}
          {micError && (
            <p className="mt-2 px-1 text-xs text-(--color-them)">
              Microphone unavailable — recording the other side only. {micError}
            </p>
          )}
        </div>
        <SessionList
          sessions={sessions}
          selected={selected}
          onSelect={nav.select}
          onDelete={setPendingDelete}
        />

        {/*
          The in-window path to Settings. The tray has the same item, but the
          tray can be hidden when the menu bar is crowded (Apple HIG), and the
          rule is that no action is reachable only from there.
        */}
        <button
          type="button"
          onClick={nav.openSettings}
          className="flex shrink-0 items-center gap-2 border-t border-(--color-line) px-4 py-2.5 text-left text-xs text-(--color-ink-dim) hover:bg-(--color-raised) hover:text-(--color-ink)"
        >
          Settings
          <span className="ml-auto font-mono text-[11px] text-(--color-ink-faint)">⌘,</span>
        </button>
      </aside>

      <main className="min-w-0 flex-1 overflow-hidden">
        {nav.settingsOpen ? (
          <SettingsView onClose={nav.closeSettings} onThemeChange={setTheme} />
        ) : current ? (
          // Keyed so switching sessions remounts: the drawer, the notes buffer
          // and the <audio> elements are all per-session state, and carrying
          // them across would show one meeting's audio under another's title.
          <MeetingView key={current.id} session={current} onDeleted={handleDeleted} />
        ) : (
          <EmptyState hasSessions={sessions.length > 0} />
        )}
      </main>

      {/*
        The sidebar's own confirmation. Looked up from `sessions` rather than
        held as an object so a session that changes underneath — transcription
        finishing while the dialog is open — is described accurately, and so a
        session deleted in another window closes this dialog instead of
        confirming against a row that is already gone.
      */}
      {sidebarDelete && (
        <DeleteSessionDialog
          session={sidebarDelete}
          hasAudio={sidebarDelete.hasAudio}
          onClose={() => setPendingDelete(null)}
          onDeleted={handleDeleted}
        />
      )}
    </div>
  )
}

function EmptyState({ hasSessions }: { hasSessions: boolean }): React.JSX.Element {
  return (
    <div className="flex h-full items-center justify-center p-8 text-center">
      <div className="max-w-sm">
        <h2 className="text-sm font-semibold text-(--color-ink)">
          {hasSessions ? 'Select a meeting' : 'No recordings yet'}
        </h2>
        <p className="mt-2 text-[13px] leading-relaxed text-(--color-ink-dim)">
          {hasSessions
            ? 'Choose a meeting from the sidebar to read its notes and transcript.'
            : 'Press record when your meeting starts. Audio and transcription stay on this machine.'}
        </p>
      </div>
    </div>
  )
}
