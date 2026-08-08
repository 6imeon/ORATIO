import { useEffect, useState } from 'react'
import type { RecordingState } from '@shared/types'

interface Props {
  onStopped: () => void | Promise<void>
}

/**
 * Start/stop, the elapsed counter, and the per-meeting audio choice.
 *
 * Elapsed time is READ from `RecordingState`, never accumulated locally. A
 * `setInterval` in a renderer is throttled to once a minute when the window is
 * backgrounded — which, for a menu-bar app during a meeting, is most of the
 * time — so a tick counter drifts badly and always undercounts. Main owns the
 * clock; this displays it.
 */
export function RecordButton({ onStopped }: Props): React.JSX.Element {
  const [state, setState] = useState<RecordingState | null>(null)
  const [busy, setBusy] = useState(false)
  const [discardAudio, setDiscardAudio] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    // Pull once for a window that opened mid-recording, then follow the push.
    void window.oratio.recording.state().then(setState)
    return window.oratio.on.recordingState(setState)
  }, [])

  useEffect(() => {
    void window.oratio.settings.get().then((s) => setDiscardAudio(s.discardAudioByDefault))
  }, [])

  const recording = state?.active ?? false

  async function toggle(): Promise<void> {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      if (recording) {
        await window.oratio.recording.stop()
        await onStopped()
      } else {
        await window.oratio.recording.start({ discardAudio })
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-2">
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
        {recording ? `Recording ${format(state?.elapsedSeconds ?? 0)}` : 'Start recording'}
      </button>

      {recording ? (
        <Levels mic={state?.micLevel ?? 0} system={state?.systemLevel ?? 0} />
      ) : (
        /*
         * Only offered before recording starts, because that is the only time
         * it can be honoured: the choice is written into meta.json and read
         * when the transcript lands, possibly on a later launch. Discarding
         * after the fact is a separate, explicit action on the meeting itself.
         */
        <label className="flex items-center gap-2 px-1 text-xs text-neutral-500">
          <input
            type="checkbox"
            checked={discardAudio}
            onChange={(e) => setDiscardAudio(e.target.checked)}
            className="size-3.5 accent-neutral-900 dark:accent-neutral-100"
          />
          Delete audio after transcribing
        </label>
      )}

      {error && <p className="px-1 text-xs text-red-500">{error}</p>}
    </div>
  )
}

/**
 * Two meters, never one. The tracks are separate all the way down, and a
 * single combined meter would hide exactly the failure this is here to catch:
 * one source dead while the other is fine.
 */
function Levels({ mic, system }: { mic: number; system: number }): React.JSX.Element {
  return (
    <div className="flex flex-col gap-1 px-1">
      <Meter label="You" level={mic} />
      <Meter label="Them" level={system} />
    </div>
  )
}

function Meter({ label, level }: { label: string; level: number }): React.JSX.Element {
  return (
    <div className="flex items-center gap-2">
      <span className="w-8 shrink-0 text-[10px] text-neutral-400">{label}</span>
      <div className="h-1 flex-1 overflow-hidden rounded-full bg-neutral-200 dark:bg-neutral-800">
        <div
          className="h-full rounded-full bg-green-500 transition-[width] duration-75"
          // Amplitude is linear but hearing is not: a normal speaking voice
          // peaks around 0.1 and would barely move a linear bar. The cube root
          // approximates a perceptual scale closely enough for a level meter.
          style={{ width: `${Math.min(100, Math.cbrt(level) * 100)}%` }}
        />
      </div>
    </div>
  )
}

function format(s: number): string {
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  const pad = (n: number): string => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`
}
