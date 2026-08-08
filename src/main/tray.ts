import { Menu, Tray, nativeImage, app, powerMonitor } from 'electron'
import { join } from 'node:path'
import log from 'electron-log/main'
import type { RecordingController } from './recording/RecordingController'

/**
 * Menu-bar presence.
 *
 * While recording the title shows a running elapsed counter next to the icon,
 * so the user can always tell at a glance that capture is live. An always-
 * visible recording state is deliberate: a meeting recorder that hides what
 * it is doing is exactly the design that got other products into trouble.
 */

interface TrayDeps {
  recording: RecordingController
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

  // A double-click would otherwise fire the menu item twice, and the second
  // fire is a *stop* on a recording the first just started.
  tray.setIgnoreDoubleClickEvents(true)

  // The interval that drives the counter does not run while the machine is
  // asleep, so the title is frozen at whatever it said when the lid closed.
  // Redraw on wake rather than waiting up to a second for the next tick.
  powerMonitor.on('resume', () => {
    if (startedAt !== null) tray?.setTitle(` ${elapsed()}`)
  })

  render(deps)
  return tray
}

function render(deps: TrayDeps): void {
  if (!tray) return
  const recording = deps.recording.isRecording()

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

/**
 * The tray reflects state rather than owning it: this calls the controller and
 * lets its `started`/`stopped` events drive the redraw, so the menu says the
 * same thing whether the recording was toggled from here, the window, or a
 * shortcut.
 */
async function toggle(deps: TrayDeps): Promise<void> {
  try {
    if (deps.recording.isRecording()) await deps.recording.stop()
    else await deps.recording.start()
  } catch (err) {
    log.error('[tray] could not toggle recording', err)
    // Resync: a failed start leaves the menu claiming a state that never
    // happened.
    render(deps)
  }
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
