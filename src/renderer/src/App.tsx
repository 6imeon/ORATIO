import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Session } from '@shared/types'
import { SessionList } from './components/SessionList'
import { RecordButton } from './components/RecordButton'
import { MeetingView } from './pages/MeetingView'
import { useMicCapture } from './hooks/useMicCapture'

export function App(): React.JSX.Element {
  const [sessions, setSessions] = useState<Session[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [micError, setMicError] = useState<string | null>(null)

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
        <SessionList sessions={sessions} selected={selected} onSelect={setSelected} />
      </aside>

      <main className="min-w-0 flex-1 overflow-hidden">
        {current ? (
          // Keyed so switching sessions remounts: the drawer, the notes buffer
          // and the <audio> elements are all per-session state, and carrying
          // them across would show one meeting's audio under another's title.
          <MeetingView key={current.id} session={current} />
        ) : (
          <EmptyState hasSessions={sessions.length > 0} />
        )}
      </main>
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
