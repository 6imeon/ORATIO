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
    void window.oratio.settings.get().then((s) => setDiscardAudio(s.retention === 'transcript-only'))
  }, [])

  const recording = state?.active ?? false
  const muted = state?.muted ?? false

  /**
   * Fire-and-forget, with no local optimistic state.
   *
   * Main is the only owner of mute — the tray and the global shortcut can
   * change it with this window closed — so the button renders whatever the
   * pushed state says. Mirroring it locally would let the two disagree, and a
   * mute indicator that can lie about the microphone is worse than no
   * indicator at all.
   */
  function toggleMute(): void {
    void window.oratio.recording.setMuted(!muted)
  }

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
        className={`flex w-full items-center justify-center gap-2 rounded-lg px-4 py-2 text-[13px] font-medium transition-colors disabled:opacity-50 ${
          recording
            ? 'bg-(--color-live) text-white'
            : 'bg-(--color-ink) text-(--color-surface) hover:opacity-90'
        }`}
      >
        <span
          className={`size-2 rounded-full ${
            recording ? 'animate-pulse bg-white' : 'bg-(--color-live)'
          }`}
        />
        {recording ? `Recording ${format(state?.elapsedSeconds ?? 0)}` : 'Start recording'}
      </button>

      {recording ? (
        <>
          {/*
            Full width and stated in words, not a small icon toggle. This
            control decides whether the user's voice is being written to disk,
            so "is it on?" has to be answerable from across the room — an icon
            that changes subtly is how someone ends up believing they were
            muted when they were not.
          */}
          <button
            onClick={toggleMute}
            aria-pressed={muted}
            className={`flex w-full items-center justify-center gap-2 rounded-lg px-3 py-1.5 text-[12px] font-medium transition-colors ${
              muted
                ? 'bg-(--color-live)/15 text-(--color-live) ring-1 ring-(--color-live)/40'
                : 'bg-(--color-raised) text-(--color-ink-dim) hover:text-(--color-ink)'
            }`}
          >
            <MicIcon muted={muted} />
            {muted ? 'Microphone muted' : 'Mute microphone'}
          </button>

          <Levels
            mic={state?.micLevel ?? 0}
            system={state?.systemLevel ?? 0}
            micMuted={muted}
          />

          {/*
            The clarification that makes this safe to use. Oratio cannot mute
            Teams or Zoom — nothing on macOS can read or change another app's
            microphone state — and someone who assumes otherwise keeps talking
            while the call still hears every word.
          */}
          {muted && (
            <p className="px-1 text-[11px] leading-relaxed text-(--color-ink-dim)">
              Not recording your voice. The meeting can still hear you — mute there too.
            </p>
          )}
        </>
      ) : (
        /*
         * Only offered before recording starts, because that is the only time
         * it can be honoured: the choice is written into meta.json and read
         * when the transcript lands, possibly on a later launch. Discarding
         * after the fact is a separate, explicit action on the meeting itself.
         *
         * Phrased as what is KEPT, inverting the `discardAudio` state it
         * drives. With the default now transcript-only, a "delete the audio"
         * checkbox would sit pre-ticked on every recording — which reads as
         * this meeting being singled out, when it is just the default.
         */
        <label className="flex items-center gap-2 px-1 text-[11px] text-(--color-ink-dim)">
          <input
            type="checkbox"
            checked={!discardAudio}
            onChange={(e) => setDiscardAudio(!e.target.checked)}
            className="size-3.5 accent-(--color-me)"
          />
          Keep the audio for this meeting
        </label>
      )}

      {error && <p className="px-1 text-xs text-(--color-live)">{error}</p>}
    </div>
  )
}

/**
 * Two meters, never one. The tracks are separate all the way down, and a
 * single combined meter would hide exactly the failure this is here to catch:
 * one source dead while the other is fine.
 */
function Levels({
  mic,
  system,
  micMuted,
}: {
  mic: number
  system: number
  micMuted: boolean
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-1 px-1">
      {/* Same two accents as the transcript, so a track reads the same colour
          from the meter that captured it to the turn it produced. */}
      <Meter label="You" level={mic} tone="var(--color-me)" muted={micMuted} />
      <Meter label="Them" level={system} tone="var(--color-them)" />
    </div>
  )
}

function Meter({
  label,
  level,
  tone,
  muted = false,
}: {
  label: string
  level: number
  tone: string
  muted?: boolean
}): React.JSX.Element {
  return (
    <div className="flex items-center gap-2">
      <span className="w-8 shrink-0 text-[10px] text-(--color-ink-faint)">{label}</span>
      {/*
        A muted meter says "muted" rather than sitting flat.

        A dead microphone and a muted one produce the identical picture — a bar
        that never moves — and this meter exists precisely to make a dead track
        visible mid-meeting. Labelling the deliberate case is what keeps the
        alarming case alarming.
      */}
      {muted ? (
        <span className="flex-1 text-[10px] text-(--color-live)">muted</span>
      ) : (
        <div className="h-1 flex-1 overflow-hidden rounded-full bg-(--color-raised)">
          <div
            className="h-full rounded-full transition-[width] duration-75"
            // Amplitude is linear but hearing is not: a normal speaking voice
            // peaks around 0.1 and would barely move a linear bar. The cube root
            // approximates a perceptual scale closely enough for a level meter.
            style={{ width: `${Math.min(100, Math.cbrt(level) * 100)}%`, background: tone }}
          />
        </div>
      )}
    </div>
  )
}

function MicIcon({ muted }: { muted: boolean }): React.JSX.Element {
  return (
    <svg viewBox="0 0 20 20" className="size-3.5 shrink-0" fill="currentColor" aria-hidden="true">
      <path d="M10 2a2.5 2.5 0 0 1 2.5 2.5v5a2.5 2.5 0 0 1-5 0v-5A2.5 2.5 0 0 1 10 2Z" />
      <path d="M5 9a.75.75 0 0 1 1.5 0 3.5 3.5 0 0 0 7 0A.75.75 0 0 1 15 9a5 5 0 0 1-4.25 4.95V16h2a.75.75 0 0 1 0 1.5h-5.5a.75.75 0 0 1 0-1.5h2v-2.05A5 5 0 0 1 5 9Z" />
      {/* The slash is the whole message; drawn with a contrasting outline so it
          stays legible against the microphone body underneath. */}
      {muted && (
        <path
          d="M3 2.6 17.4 17"
          stroke="currentColor"
          strokeWidth="1.75"
          strokeLinecap="round"
          fill="none"
        />
      )}
    </svg>
  )
}

function format(s: number): string {
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  const pad = (n: number): string => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`
}
