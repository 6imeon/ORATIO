import { useEffect, useState } from 'react'
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

  useEffect(() => {
    void refresh()
    return window.oratio.on.sessionChanged(() => void refresh())
  }, [])

  async function refresh(): Promise<void> {
    setSessions(await window.oratio.session.list())
  }

  return (
    <div className="flex h-screen bg-neutral-50 text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100">
      <aside className="flex w-72 shrink-0 flex-col border-r border-neutral-200 dark:border-neutral-800">
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
            <p className="mt-2 px-1 text-xs text-amber-600 dark:text-amber-500">
              Microphone unavailable — recording the other side only. {micError}
            </p>
          )}
        </div>
        <SessionList sessions={sessions} selected={selected} onSelect={setSelected} />
      </aside>

      <main className="flex-1 overflow-hidden">
        {selected ? (
          <MeetingView sessionId={selected} />
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
        <h2 className="text-lg font-medium">
          {hasSessions ? 'Select a meeting' : 'No recordings yet'}
        </h2>
        <p className="mt-2 text-sm text-neutral-500">
          {hasSessions
            ? 'Choose a meeting from the sidebar to read its notes and transcript.'
            : 'Press record when your meeting starts. Audio and transcription stay on this machine.'}
        </p>
      </div>
    </div>
  )
}
