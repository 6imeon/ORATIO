import { useEffect, useState } from 'react'
import type { Transcript } from '@shared/types'
import { TranscriptView } from '../components/TranscriptView'

interface Props {
  sessionId: string
}

type Tab = 'notes' | 'transcript'

/**
 * Notes on the left, transcript on the right.
 *
 * The notes pane is the primary surface, not an afterthought: what the user
 * types during the meeting is what steers the AI summary later. Sparse
 * bullets in, focused summary out.
 */
export function MeetingView({ sessionId }: Props): React.JSX.Element {
  const [notes, setNotes] = useState('')
  const [transcript, setTranscript] = useState<Transcript | null>(null)
  const [tab, setTab] = useState<Tab>('notes')

  useEffect(() => {
    void (async () => {
      const [n, t] = await Promise.all([
        window.oratio.session.getNotes(sessionId),
        window.oratio.session.transcript(sessionId),
      ])
      setNotes(n)
      setTranscript(t)
    })()
  }, [sessionId])

  // Debounced autosave — notes are plain markdown on disk, so every save is
  // just a file write the user could have made themselves.
  useEffect(() => {
    const t = setTimeout(() => {
      void window.oratio.session.setNotes(sessionId, notes)
    }, 600)
    return () => clearTimeout(t)
  }, [notes, sessionId])

  return (
    <div className="flex h-full flex-col">
      <header
        className="flex h-11 shrink-0 items-center gap-1 border-b border-neutral-200 px-3 dark:border-neutral-800"
        style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
      >
        <div className="flex gap-1" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
          <TabButton active={tab === 'notes'} onClick={() => setTab('notes')}>
            Notes
          </TabButton>
          <TabButton active={tab === 'transcript'} onClick={() => setTab('transcript')}>
            Transcript
          </TabButton>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto p-4">
        {tab === 'notes' ? (
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Jot down what matters. Your notes guide the summary."
            className="h-full w-full resize-none bg-transparent font-mono text-sm leading-relaxed outline-none placeholder:text-neutral-400"
          />
        ) : transcript ? (
          <TranscriptView sessionId={sessionId} transcript={transcript} />
        ) : (
          <p className="text-sm text-neutral-500">
            Transcribing… this runs locally and takes a moment.
          </p>
        )}
      </div>
    </div>
  )
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <button
      onClick={onClick}
      className={`rounded px-2.5 py-1 text-sm transition-colors ${
        active
          ? 'bg-neutral-200 font-medium dark:bg-neutral-800'
          : 'text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-900'
      }`}
    >
      {children}
    </button>
  )
}
