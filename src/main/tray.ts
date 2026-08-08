import { Menu, Tray, nativeImage, app } from 'electron'
import { join } from 'node:path'
import type { MacAudioCapture } from './audio/MacAudioCapture'

/**
 * Menu-bar presence.
 *
 * While recording the title shows a running elapsed counter next to the icon,
 * so the user can always tell at a glance that capture is live. An always-
 * visible recording state is deliberate: a meeting recorder that hides what
 * it is doing is exactly the design that got other products into trouble.
 */

interface TrayDeps {
  capture: MacAudioCapture
  showMainWindow: () => void
}

let tray: Tray | null = null
let ticker: NodeJS.Timeout | null = null
let startedAt: number | null = null

export function createTray(deps: TrayDeps): Tray {
  const icon = nativeImage
    .createFromPath(join(__dirname, '../../resources/trayTemplate.png'))
    .resize({ width: 18, height: 18 })
  // Template images let macOS invert the icon automatically for light/dark
  // menu bars.
  icon.setTemplateImage(true)

  tray = new Tray(icon)
  tray.setToolTip('Oratio')
  render(deps)
  return tray
}

function render(deps: TrayDeps): void {
  if (!tray) return
  const recording = deps.capture.isRecording()

  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: recording ? 'Stop recording' : 'Start recording',
        accelerator: 'CommandOrControl+Shift+R',
        click: () => void toggle(deps),
      },
      { type: 'separator' },
      { label: 'Open Oratio', click: () => deps.showMainWindow() },
      { type: 'separator' },
      { label: 'Quit', role: 'quit' },
    ]),
  )

  tray.setTitle(recording ? ` ${elapsed()}` : '')
}

async function toggle(deps: TrayDeps): Promise<void> {
  // Wired to the recording controller in ipc/recording.ts; the tray only
  // reflects state rather than owning it.
  render(deps)
}

export function setRecordingState(active: boolean, deps: TrayDeps): void {
  startedAt = active ? Date.now() : null

  if (ticker) {
    clearInterval(ticker)
    ticker = null
  }
  if (active) {
    ticker = setInterval(() => tray?.setTitle(` ${elapsed()}`), 1000)
  }
  render(deps)
}

function elapsed(): string {
  if (!startedAt) return '0:00'
  const total = Math.floor((Date.now() - startedAt) / 1000)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const pad = (n: number) => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`
}

app.on('before-quit', () => {
  if (ticker) clearInterval(ticker)
  tray?.destroy()
})
