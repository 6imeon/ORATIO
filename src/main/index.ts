import { app, BrowserWindow, shell } from 'electron'
import { join } from 'node:path'
import { mkdir } from 'node:fs/promises'
import log from 'electron-log/main'
import { loadSettings } from './storage/settings'
import { SearchIndex } from './storage/searchIndex'
import { TranscriptionQueue } from './transcription/TranscriptionQueue'
import { MacAudioCapture } from './audio/MacAudioCapture'
import { ModelManager } from './models/ModelManager'
import { registerIpc } from './ipc'
import { createTray } from './tray'

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

  const queue = new TranscriptionQueue(settings.vaultPath, () => {
    throw new Error('TODO: construct SherpaEngine for settings.activeModel')
  })

  registerIpc({ capture, queue, searchIndex, models, showMainWindow })
  createTray({ capture, showMainWindow })

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
