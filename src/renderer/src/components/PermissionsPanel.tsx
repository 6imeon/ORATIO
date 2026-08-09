import { useCallback, useEffect, useState } from 'react'
import type { PermissionState } from '@shared/ipc'

const MIC_PANE = 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone'
const AUDIO_PANE = 'x-apple.systempreferences:com.apple.preference.security?Privacy_AudioCapture'

/**
 * Microphone and system audio, described as honestly as each can be.
 *
 * The two halves are not symmetrical and the UI must not pretend they are.
 * `getMediaAccessStatus` answers the microphone question directly. There is no
 * equivalent for a Core Audio process tap — macOS exposes no way to read that
 * TCC state, and the only way to test it is to start a tap, which is a side
 * effect rather than a query (ARCHITECTURE §6).
 *
 * So system audio reports what the last finished recording *captured*, dated,
 * and never with a green tick. UI.md §7 is explicit that this must read as
 * "appears to be working", because a status light here would be asserting
 * something we did not check.
 */
export function PermissionsPanel(): React.JSX.Element {
  const [state, setState] = useState<PermissionState | null>(null)
  const [asking, setAsking] = useState(false)

  const refresh = useCallback(async (): Promise<void> => {
    setState(await window.oratio.permissions.check())
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  async function requestMic(): Promise<void> {
    setAsking(true)
    try {
      await window.oratio.permissions.requestMic()
      await refresh()
    } finally {
      setAsking(false)
    }
  }

  if (!state) return <p className="text-[13px] text-(--color-ink-dim)">Checking…</p>

  return (
    <div className="flex flex-col gap-3">
      <Item
        label="Microphone"
        tone={micTone(state.microphone)}
        status={micStatus(state.microphone)}
        detail="Records your side of the meeting. Without it, only the other side is captured."
        action={
          state.microphone === 'not-determined' ? (
            <button
              type="button"
              onClick={() => void requestMic()}
              disabled={asking}
              className="rounded-md bg-(--color-ink) px-2 py-1 text-[11px] font-medium text-(--color-surface) hover:opacity-90 disabled:opacity-50"
            >
              Ask for access
            </button>
          ) : state.microphone === 'denied' || state.microphone === 'restricted' ? (
            // Once denied, the prompt never appears again — macOS only asks
            // once. The only route back is System Settings, so send them there
            // rather than offering a button that would do nothing.
            <PaneLink url={MIC_PANE} />
          ) : null
        }
      />

      <Item
        label="System audio"
        tone={systemTone(state.systemAudio)}
        status={systemStatus(state.systemAudio)}
        detail={systemDetail(state)}
        action={state.systemAudio === 'likely-denied' ? <PaneLink url={AUDIO_PANE} /> : null}
      />
    </div>
  )
}

function PaneLink({ url }: { url: string }): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={() => void window.oratio.settings.openExternal(url)}
      className="rounded-md border border-(--color-line) px-2 py-1 text-[11px] text-(--color-ink-dim) hover:bg-(--color-raised) hover:text-(--color-ink)"
    >
      Open System Settings
    </button>
  )
}

function Item({
  label,
  status,
  tone,
  detail,
  action,
}: {
  label: string
  status: string
  tone: 'good' | 'bad' | 'unknown'
  detail: string
  action: React.ReactNode
}): React.JSX.Element {
  // Never a bare colour: a dot alone is unreadable in greyscale and to the ~8%
  // of men with red-green deficiency, and the words carry the meaning anyway.
  const dot =
    tone === 'good'
      ? 'bg-(--color-me)'
      : tone === 'bad'
        ? 'bg-(--color-live)'
        : 'bg-(--color-ink-faint)'

  return (
    <div className="rounded-lg border border-(--color-line) bg-(--color-surface) px-3 py-2.5">
      <div className="flex items-center gap-2">
        <span className={`size-1.5 shrink-0 rounded-full ${dot}`} />
        <span className="text-[13px] font-medium text-(--color-ink)">{label}</span>
        <span className="text-[13px] text-(--color-ink-dim)">— {status}</span>
        {action && <span className="ml-auto">{action}</span>}
      </div>
      <p className="mt-1 ml-3.5 text-xs leading-relaxed text-(--color-ink-faint)">{detail}</p>
    </div>
  )
}

function micStatus(s: PermissionState['microphone']): string {
  switch (s) {
    case 'granted':
      return 'allowed'
    case 'denied':
      return 'not allowed'
    case 'restricted':
      return 'blocked by this Mac'
    case 'not-determined':
      return 'not asked yet'
    default:
      return 'unknown'
  }
}

function micTone(s: PermissionState['microphone']): 'good' | 'bad' | 'unknown' {
  if (s === 'granted') return 'good'
  if (s === 'denied' || s === 'restricted') return 'bad'
  return 'unknown'
}

/**
 * Hedged on purpose. "Appears to be working" is the strongest claim the
 * evidence supports — we saw audio arrive once, which is not the same as
 * holding a permission now.
 */
function systemStatus(s: PermissionState['systemAudio']): string {
  switch (s) {
    case 'likely-granted':
      return 'appears to be working'
    case 'likely-denied':
      return 'appears to be blocked'
    default:
      return 'not known yet'
  }
}

function systemTone(s: PermissionState['systemAudio']): 'good' | 'bad' | 'unknown' {
  if (s === 'likely-granted') return 'good'
  if (s === 'likely-denied') return 'bad'
  return 'unknown'
}

function systemDetail(state: PermissionState): string {
  const when = state.systemAudioObservedAt
    ? new Date(state.systemAudioObservedAt).toLocaleString()
    : null

  switch (state.systemAudio) {
    case 'likely-granted':
      return `macOS provides no way to check this directly, so this is based on your last recording${
        when ? ` on ${when}` : ''
      }, which did capture the other side.`
    case 'likely-denied':
      return `Your last recording${
        when ? ` on ${when}` : ''
      } captured no system audio at all, which usually means System Audio Recording is turned off for Oratio.`
    default:
      return 'macOS provides no way to check this without recording, so this stays unknown until you finish your first meeting.'
  }
}
