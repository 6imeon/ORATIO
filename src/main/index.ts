import { app, BrowserWindow, shell, ipcMain } from 'electron'
import { join } from 'node:path'
import { mkdir } from 'node:fs/promises'
import log from 'electron-log/main'
import { EVENTS, IPC, type NavTarget, type TranscriptionProgress } from '@shared/ipc'
import { loadSettings, saveSettings } from './storage/settings'
import { autoDetectProvider } from './ai/Summarizer'
import { IndexClient, type IndexableSession } from './storage/IndexClient'
import { TranscriptionQueue } from './transcription/TranscriptionQueue'
import { MacAudioCapture } from './audio/MacAudioCapture'
import { registerMicPort } from './audio/micPort'
import { RecordingController } from './recording/RecordingController'
import { ModelManager } from './models/ModelManager'
import { WorkerEngine } from './transcription/WorkerEngine'
import { registerIpc } from './ipc'
import { readMeta, readTranscript, listSessions, sessionDir } from './storage/vault'
import { createTray, setRecordingState, setTranscribing } from './tray'

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
 * Module-scope so the `before-quit` handler below — registered outside
 * `whenReady` — can shut the worker down. Null until the app is ready.
 */
let indexClient: IndexClient | null = null

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

/**
 * Where a freshly-created window should go once it is listening.
 *
 * The tray can ask for a session with no window open, and the window that then
 * gets created is not subscribed yet — a push at that moment would land
 * nowhere. Main parks the request here and the renderer collects it on mount
 * via `NAV_PENDING`, which turns a race into a handshake.
 *
 * Only ever one: a second click before the window is up replaces the first,
 * which is what the user asked for most recently.
 */
let pendingNav: NavTarget | null = null

/**
 * Show the window, pointed at something specific.
 *
 * A live window is told directly. A window that does not exist yet gets the
 * target parked for it — see `pendingNav`. Either way the window is shown and
 * focused, because every path here is a user asking to see something.
 */
function navigate(target: NavTarget): void {
  const live = mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()

  // Parked unconditionally, not just when there is no window. The renderer
  // clears it on collection, and a window that is live but mid-reload has the
  // same problem a missing one does.
  pendingNav = target
  showMainWindow()

  if (live) {
    mainWindow?.webContents.send(EVENTS.NAVIGATE, target)
  }
}

void app.whenReady().then(async () => {
  const settings = await loadSettings()
  await mkdir(settings.vaultPath, { recursive: true })

  // Lives in its own process: better-sqlite3 is synchronous, and a heavy query
  // on main's thread freezes the tray — the one surface always on screen.
  const searchIndex = new IndexClient(join(app.getPath('userData'), 'index.sqlite'))
  indexClient = searchIndex
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

  // Before any handler can query it. A search arriving at a worker that has not
  // opened its database would fail with a real error rather than empty results,
  // which is correct but is not a state the user should ever be able to reach.
  await searchIndex.start()

  registerIpc({
    capture,
    recording,
    queue,
    searchIndex,
    models,
    showMainWindow,
    claimMic,
    rebuildIndex: () => reconcileIndex(true),
  })

  // Registered once, not per recording: the renderer opens a fresh port for
  // each session, and a page reload would otherwise leave main listening to a
  // port nobody is writing to.
  registerMicPort(capture)

  // Registered here rather than in registerIpc because it reads `pendingNav`,
  // which is window state and lives in this module.
  ipcMain.handle(IPC.NAV_PENDING, () => {
    const target = pendingNav
    // Collected exactly once: leaving it set would send the window back to the
    // same session on every subsequent reload.
    pendingNav = null
    return target
  })

  createTray({
    recording,
    showMainWindow,
    openSession: (sessionId) => navigate({ kind: 'session', sessionId }),
    openSettings: () => navigate({ kind: 'settings' }),
    // Read on menu open rather than cached: the vault is the source of truth
    // and a session can appear from a recording started in another window.
    // listSessions already sorts newest-first, and the tray takes the head.
    recentSessions: async () => listSessions((await loadSettings()).vaultPath),
  })

  // The tray shows a live elapsed counter, so it needs to know when recording
  // starts and stops regardless of who asked — window, tray, or shortcut.
  recording.on('started', () => setRecordingState(true))
  recording.on('stopped', () => setRecordingState(false))

  // The tray's third state. "Transcribing" is the one users forget exists and
  // the one that says the app is still working after a meeting ends — without
  // it, a long ASR job looks like the app has gone idle and eaten the
  // recording.
  queue.on('progress', (p: TranscriptionProgress) => {
    // `queued` counts jobs still waiting; the one being worked on is not in it.
    const active = p.stage === 'done' || p.stage === 'failed' ? 0 : 1
    setTranscribing(p.queued + active)
    broadcast(EVENTS.TRANSCRIPTION_PROGRESS, p)
  })

  // A session becomes searchable when its transcript lands, not when it is
  // recorded. The index is derived, so failing to index is not fatal — it can
  // always be rebuilt by rescanning the vault.
  queue.on('completed', (sessionId: string) => {
    void indexSession(sessionId).catch((err) =>
      log.warn('[app] could not index session', sessionId, err),
    )
    broadcast(EVENTS.SESSION_CHANGED, sessionId)
  })

  async function indexSession(sessionId: string): Promise<void> {
    const current = await loadSettings()
    const dir = sessionDir(current.vaultPath, sessionId)
    const [meta, transcript] = await Promise.all([readMeta(dir), readTranscript(dir)])
    if (!meta || !transcript) return
    await searchIndex.indexSession(sessionId, meta, transcript)
  }

  /**
   * Read a session off disk in the shape the index wants, or null if it has
   * nothing to index yet.
   */
  async function loadIndexable(
    vaultPath: string,
    sessionId: string,
  ): Promise<IndexableSession | null> {
    const dir = sessionDir(vaultPath, sessionId)
    const [meta, transcript] = await Promise.all([readMeta(dir), readTranscript(dir)])
    if (!meta || !transcript) return null
    return { sessionId, meta, transcript }
  }

  /**
   * Reconcile the index against the vault.
   *
   * The vault is the truth and the index is derived, so this is one-directional
   * repair: sessions on disk that the index has never seen get added, and
   * sessions the index still holds that are gone from disk get dropped. That
   * second half matters because a user can delete a session folder in Finder —
   * these are their files, which is the whole promise — and a stale hit that
   * opens nothing is worse than no hit.
   *
   * `full` skips the diff and re-indexes everything, which is the answer to
   * "the index is wrong and I do not know why". Nothing else can rebuild it,
   * because nothing else is stored: delete index.sqlite and this restores it
   * completely from the files.
   */
  async function reconcileIndex(full = false): Promise<number> {
    const current = await loadSettings()
    const sessions = await listSessions(current.vaultPath)
    // Only transcribed sessions have anything to index. A pending one arrives
    // via queue.on('completed') the moment its transcript lands.
    const onDisk = sessions.filter((s) => s.status === 'ready')

    if (full) {
      const loaded = await Promise.all(
        onDisk.map((s) => loadIndexable(current.vaultPath, s.id)),
      )
      const indexed = await searchIndex.rebuild(loaded.filter((s) => s !== null))
      log.info('[index] rebuilt from vault', { sessions: indexed })
      return indexed
    }

    const known = new Set(await searchIndex.indexedIds())
    const missing = onDisk.filter((s) => !known.has(s.id))
    const present = new Set(onDisk.map((s) => s.id))

    for (const id of known) {
      if (!present.has(id)) await searchIndex.removeSession(id)
    }

    for (const s of missing) {
      const loadable = await loadIndexable(current.vaultPath, s.id)
      if (loadable) {
        await searchIndex.indexSession(loadable.sessionId, loadable.meta, loadable.transcript)
      }
    }

    if (missing.length > 0 || known.size !== present.size) {
      log.info('[index] reconciled', { added: missing.length, indexed: present.size })
    }
    return missing.length
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

  // Catch the index up to the vault, in the background: it is not needed until
  // the user types in the search box, and blocking startup on a scan of every
  // session would delay the tray appearing. Deleting index.sqlite is a
  // supported repair, so this path has to be able to rebuild from nothing.
  void reconcileIndex().catch((err) => log.warn('[index] catch-up failed', err))

  // Look for a local Ollama, also in the background and for the same reason:
  // when it is absent the probe waits out a 1.5 s connect timeout, and that
  // would be 1.5 s of the tray not existing on every launch of a machine
  // without it. Only ever selects the LOCAL provider — a cloud summariser is
  // opt-in, never something the user discovers after the fact.
  void (async () => {
    const current = await loadSettings()
    const detected = await autoDetectProvider(current)
    if (detected !== current) await saveSettings(detected)
  })().catch((err) => log.warn('[ai] provider auto-detect failed', err))

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
  // The index worker is long-lived, so unlike the ASR worker nothing else ever
  // kills it. Left running it would outlive the app as an orphan holding a WAL
  // lock on the database.
  indexClient?.close()
})
