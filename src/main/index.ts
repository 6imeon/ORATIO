import { app, BrowserWindow, shell } from 'electron'
import { join } from 'node:path'
import { mkdir } from 'node:fs/promises'
import log from 'electron-log/main'
import { EVENTS } from '@shared/ipc'
import { loadSettings } from './storage/settings'
import { SearchIndex } from './storage/searchIndex'
import { TranscriptionQueue } from './transcription/TranscriptionQueue'
import { MacAudioCapture } from './audio/MacAudioCapture'
import { registerMicPort } from './audio/micPort'
import { RecordingController } from './recording/RecordingController'
import { ModelManager } from './models/ModelManager'
import { WorkerEngine } from './transcription/WorkerEngine'
import { registerIpc } from './ipc'
import { readMeta, readTranscript } from './storage/vault'
import { createTray, setRecordingState } from './tray'

log.initialize()
log.transports.file.level = 'info'

/**
 * Oratio — local-first meeting recorder.
 *
 * Menu-bar app: LSUIElement is set in electron-builder.yml, so there is no
 * Dock icon and no window on launch. The tray is the primary surface; the
 * main window opens on demand.
 */

let mainWindow: BrowserWindow | null = null

/** Set once `before-quit` has begun finalizing, so the second pass can proceed. */
let quitting = false

/**
 * Push an event to every live renderer.
 *
 * Every window, not just `mainWindow`: state has to be correct in whatever
 * window the user is looking at, and a destroyed WebContents throws on send
 * rather than being a no-op.
 */
function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
      win.webContents.send(channel, payload)
    }
  }
}

/**
 * The WebContents currently responsible for the microphone.
 *
 * Exactly one, tracked explicitly rather than derived from window order.
 * Two windows both running `getUserMedia` would push interleaved PCM down one
 * port and produce a WAV that is silently wrong rather than loudly broken, and
 * "the first window in the list" is not stable across a window being closed
 * and reopened mid-meeting.
 */
let micOwnerId: number | null = null

/**
 * Ask the renderer to open or close the microphone.
 *
 * Returns false when there is no window to ask. That is a normal state for a
 * menu-bar app — the tray can start a recording with nothing open — and it is
 * reported rather than repaired: opening a window unbidden to capture audio is
 * exactly the behaviour a meeting recorder should not have. System audio still
 * records; the mic track is simply absent, and meta.json says so.
 */
function requestMic(start: boolean): boolean {
  if (!start) {
    const owner = micOwnerId
    micOwnerId = null
    if (owner === null) return false
    const win = BrowserWindow.getAllWindows().find((w) => w.webContents.id === owner)
    if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
      win.webContents.send(EVENTS.MIC_STOP)
    }
    return true
  }

  const target = BrowserWindow.getAllWindows().find(
    (w) => !w.isDestroyed() && !w.webContents.isDestroyed(),
  )
  if (!target) {
    micOwnerId = null
    return false
  }

  micOwnerId = target.webContents.id
  target.webContents.send(EVENTS.MIC_START)
  return true
}

/**
 * Hand the mic to a window that opened mid-recording.
 *
 * A meeting started from the tray with nothing open has no mic track. Opening
 * the window then is a reasonable moment to start capturing one — the mic
 * simply joins late, and `startOffsetMs` in meta.json already carries exactly
 * that kind of gap between the two tracks.
 */
function claimMic(id: number): boolean {
  if (micOwnerId !== null) return micOwnerId === id
  micOwnerId = id
  return true
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 720,
    minHeight: 500,
    show: false,
    titleBarStyle: 'hiddenInset',
    vibrancy: 'sidebar',
    visualEffectState: 'active',
    webPreferences: {
      // Must match the filename emitted by electron.vite.config.ts
      // (out/preload/index.cjs). A wrong path here fails SILENTLY: the
      // window loads, `window.oratio` is undefined, and every IPC call
      // breaks with no error in the main process.
      preload: join(__dirname, '../preload/index.cjs'),
      sandbox: false, // required: preload imports Node built-ins
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  win.on('ready-to-show', () => win.show())

  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  // electron-vite serves the renderer over HTTP in dev and emits a static
  // bundle for production.
  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (!app.isPackaged && devUrl) {
    void win.loadURL(devUrl)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return win
}

export function showMainWindow(): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show()
    mainWindow.focus()
  } else {
    mainWindow = createWindow()
  }
}

void app.whenReady().then(async () => {
  const settings = await loadSettings()
  await mkdir(settings.vaultPath, { recursive: true })

  const searchIndex = new SearchIndex(join(app.getPath('userData'), 'index.sqlite'))
  const capture = new MacAudioCapture()
  const models = new ModelManager()

  // An install interrupted by a crash leaves a .tmp- directory behind. It is
  // never a valid model, and clearing it here keeps a failed download from
  // costing disk space indefinitely.
  await models.sweep()

  // Built fresh per drain so a model change in Settings takes effect on the
  // next job rather than requiring a restart. Both lookups have to happen
  // here rather than at startup: the model may not be downloaded yet when the
  // app launches, and reporting that as a real error at transcribe time is
  // better than failing to boot.
  const queue = new TranscriptionQueue(settings.vaultPath, async () => {
    const current = await loadSettings()
    const files = await models.resolve(current.activeModel)
    if (!files) {
      throw new Error(`Model ${current.activeModel} is not downloaded`)
    }
    // VAD is mandatory, so its weights are a prerequisite of every job.
    const vadModelPath = await models.ensureVad()

    return new WorkerEngine(
      current.activeModel,
      files,
      vadModelPath,
      current.vadEnabled,
    )
  })

  const recording = new RecordingController({
    capture,
    onSessionComplete: (dir) => queue.enqueue(dir),
    broadcastState: (state) => broadcast(EVENTS.RECORDING_STATE, state),
    requestMic: (start) => requestMic(start),
  })

  registerIpc({ capture, recording, queue, searchIndex, models, showMainWindow, claimMic })

  // Registered once, not per recording: the renderer opens a fresh port for
  // each session, and a page reload would otherwise leave main listening to a
  // port nobody is writing to.
  registerMicPort(capture)

  const trayDeps = { recording, showMainWindow }
  createTray(trayDeps)

  // The tray shows a live elapsed counter, so it needs to know when recording
  // starts and stops regardless of who asked — window, tray, or shortcut.
  recording.on('started', () => setRecordingState(true, trayDeps))
  recording.on('stopped', () => setRecordingState(false, trayDeps))

  // A session becomes searchable when its transcript lands, not when it is
  // recorded. The index is derived, so failing to index is not fatal — it can
  // always be rebuilt by rescanning the vault.
  queue.on('completed', (sessionId: string) => {
    void indexSession(sessionId).catch((err) =>
      log.warn('[app] could not index session', sessionId, err),
    )
    broadcast(EVENTS.SESSION_CHANGED, sessionId)
  })

  queue.on('progress', (p) => broadcast(EVENTS.TRANSCRIPTION_PROGRESS, p))

  async function indexSession(sessionId: string): Promise<void> {
    const current = await loadSettings()
    const dir = join(current.vaultPath, sessionId)
    const [meta, transcript] = await Promise.all([readMeta(dir), readTranscript(dir)])
    if (!meta || !transcript) return
    searchIndex.indexSession(sessionId, meta, transcript)
  }

  app.on('before-quit', (e) => {
    // Quitting mid-meeting would otherwise leave two WAVs and no meta.json —
    // a directory the queue is right to ignore, so the recording would be
    // silently orphaned. Defer the quit just long enough to write it.
    if (!recording.isRecording() || quitting) return
    e.preventDefault()
    quitting = true
    void recording.shutdown().finally(() => app.quit())
  })

  // Anything recorded but not transcribed — because the app quit or crashed
  // mid-job — is picked up here. The filesystem is the queue, so this needs
  // no persisted state.
  await queue.resumePending()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) showMainWindow()
  })

  log.info('[app] ready', { vault: settings.vaultPath, model: settings.activeModel })
})

// Menu-bar app: closing the window must not quit. Recording has to survive
// the user tidying their desktop.
app.on('window-all-closed', () => {
  // Intentionally empty on all platforms while macOS-only.
})

app.on('before-quit', () => {
  log.info('[app] quitting')
})
