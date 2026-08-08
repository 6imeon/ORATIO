import { useEffect, useState } from 'react'

interface Props {
  onStopped: () => void | Promise<void>
}

export function RecordButton({ onStopped }: Props): React.JSX.Element {
  const [recording, setRecording] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!recording) return
    const t = setInterval(() => setElapsed((e) => e + 1), 1000)
    return () => clearInterval(t)
  }, [recording])

  async function toggle(): Promise<void> {
    if (busy) return
    setBusy(true)
    try {
      if (recording) {
        await window.oratio.recording.stop()
        setRecording(false)
        setElapsed(0)
        await onStopped()
      } else {
        await window.oratio.recording.start()
        setRecording(true)
        setElapsed(0)
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <button
      onClick={() => void toggle()}
      disabled={busy}
      className={`flex w-full items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-sm font-medium transition-colors disabled:opacity-50 ${
        recording
          ? 'bg-red-500 text-white hover:bg-red-600'
          : 'bg-neutral-900 text-white hover:bg-neutral-700 dark:bg-neutral-100 dark:text-neutral-900'
      }`}
    >
      <span
        className={`size-2 rounded-full ${recording ? 'animate-pulse bg-white' : 'bg-red-500'}`}
      />
      {recording ? `Recording ${format(elapsed)}` : 'Start recording'}
    </button>
  )
}

function format(s: number): string {
  const m = Math.floor(s / 60)
  return `${m}:${String(s % 60).padStart(2, '0')}`
}
