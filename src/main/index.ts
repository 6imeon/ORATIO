import { app, BrowserWindow, shell, ipcMain, nativeTheme } from 'electron'
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
import { recoverOrphanedSessions } from './recording/recoverOrphans'
import { ModelManager } from './models/ModelManager'
import { WorkerEngine } from './transcription/WorkerEngine'
import { registerIpc } from './ipc'
import { readMeta, readTranscript, listSessions, sessionDir } from './storage/vault'
import {
  createTray,
  registerTrayLifecycle,
  setRecordingState,
  setTranscribing,
  suggestRecording,
  clearSuggestion,
} from './tray'
import { MeetingDetector } from './audio/meetingDetector'

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

/**
 * Last-resort handlers, so an unexpected throw is written down somewhere.
 *
 * Both workers have had these since they were written; main never did, which
 * meant the one process holding a live recording was the one process that
 * could die without explanation. Electron's default for an uncaught exception
 * in main is a dialog and exit, and the log file is the only thing left
 * afterwards to say what happened.
 *
 * Deliberately does NOT try to save the recording. Finalizing a WAV from an
 * unknown-broken state means running the same async writer machinery that may
 * be what just failed, and a hang here would replace a crash with an app that
 * cannot be quit. The 30-second header patch is what makes that acceptable:
 * the audio on disk is already playable, and `recoverOrphanedSessions` rebuilds
 * the meta.json on next launch.
 */
process.on('uncaughtException', (err) => {
  log.error('[app] uncaught exception in main', err)
})

process.on('unhandledRejection', (reason) => {
  log.error('[app] unhandled rejection in main', reason)
})

/** Set once `before-quit` has begun finalizing, so the second pass can proceed. */
let quitting = false

/**
 * Module-scope so the `before-quit` handler below — registered outside
 * `whenReady` — can shut the worker down. Null until the app is ready.
 */
let indexClient: IndexClient | null = null

/**
 * Module-scope for the same reason as `indexClient`: `claimMic` is called from
 * a window that may finish loading before or after any given point in startup,
 * and it has to be able to ask whether a recording is actually in progress.
 * Null until the app is ready.
 */
let recordingController: RecordingController | null = null

/**
 * The meeting detector, and the setting that gates it.
 *
 * Module-scope so `before-quit` can stop the probe process: it is a child of
 * this one, and leaving it running past quit would keep a process polling the
 * microphone state of a machine whose recorder has exited — precisely the
 * behaviour this app exists not to have.
 *
 * The setting is a holder for the same reason as `excludedBundleIds`: the
 * `settings` snapshot is read once at launch, and toggling this in Settings has
 * to take effect immediately rather than at the next app start.
 */
let detector: MeetingDetector | null = null
const meetingSuggestions = { current: false }

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
 * A window that exists only to hold the microphone.
 *
 * `getUserMedia` is the only mic API Electron exposes without a second native
 * dependency, and it lives in a renderer. So a recording started from the tray
 * with nothing open used to capture system audio ONLY: the mic track came back
 * empty, the meeting lost the user's own voice, and the sole evidence was a
 * line in the log. For a menu-bar app whose entire purpose is starting a
 * meeting from the menu bar, that is the common path, not the edge case.
 *
 * Never shown, so it is not the "opening a window unbidden" behaviour a
 * recorder should not have — nothing appears on screen and nothing steals
 * focus. It is a host for an audio context, and it is closed the moment the
 * recording stops.
 */
let micHostWindow: BrowserWindow | null = null

/**
 * A window the user can actually see, if there is one.
 *
 * The mic host is a real `BrowserWindow` to Electron, so anything asking "is a
 * window open?" has to exclude it explicitly or it will get the wrong answer —
 * the Dock-click handler did exactly that and silently stopped opening the
 * window during a tray-started recording. Defined once so that exclusion cannot
 * be forgotten at one of the call sites.
 */
function firstVisibleWindow(): BrowserWindow | undefined {
  return BrowserWindow.getAllWindows().find(
    (w) => w !== micHostWindow && !w.isDestroyed() && !w.webContents.isDestroyed(),
  )
}

function hasVisibleWindow(): boolean {
  return firstVisibleWindow() !== undefined
}

function createMicHost(): BrowserWindow {
  const win = new BrowserWindow({
    show: false,
    // Not just hidden: skipTaskbar and a zero-opacity offscreen frame keep it
    // out of Mission Control and the window cycler, so ⌘` never lands on a
    // window the user cannot see. `show: false` alone leaves it addressable.
    skipTaskbar: true,
    width: 1,
    height: 1,
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      // A hidden window is throttled by Chromium after a few seconds —
      // timers are clamped and rAF stops entirely. AudioWorklet runs on the
      // audio thread and survives that, but the message pump feeding chunks
      // to the port does not, and the mic track would arrive in stutters.
      backgroundThrottling: false,
    },
  })

  win.on('closed', () => {
    micHostWindow = null
  })

  // `?michost` selects the mic-only entry in main.tsx. Passed as a query rather
  // than a hash so it survives both loadURL and loadFile — loadFile takes the
  // query as a separate option and would silently drop it from the path string.
  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (!app.isPackaged && devUrl) {
    void win.loadURL(`${devUrl}?michost`)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'), { search: 'michost' })
  }

  return win
}

/**
 * Close the mic host, if that is what was holding the mic.
 *
 * A real window that happened to own the mic must obviously survive; only the
 * invisible one is disposable. Keeping it alive between recordings would leave
 * an idle renderer — and, on some macOS routes, the orange microphone
 * indicator — running with no meeting in progress.
 */
function closeMicHost(): void {
  const win = micHostWindow
  micHostWindow = null
  if (win && !win.isDestroyed()) win.destroy()
}

/**
 * Ask the renderer to open or close the microphone.
 *
 * Prefers a window the user actually has open and falls back to creating the
 * hidden host above. Always returns true for a start request now: the mic is no
 * longer contingent on the window, which is what it always should have been —
 * main owns recording, and "did anyone happen to leave a window open" is not a
 * property a meeting should depend on.
 */
function requestMic(start: boolean): boolean {
  if (!start) {
    const owner = micOwnerId
    micOwnerId = null
    if (owner === null) {
      closeMicHost()
      return false
    }
    const win = BrowserWindow.getAllWindows().find((w) => w.webContents.id === owner)
    if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
      win.webContents.send(EVENTS.MIC_STOP)
    }
    // Deferred past the drain: MIC_STOP has to reach the renderer and the
    // worklet's tail has to flush through the port before the WebContents is
    // torn down. Destroying it here would drop the last words of the meeting —
    // exactly the loss RecordingController's #waitForMicDrain exists to avoid.
    setTimeout(closeMicHost, MIC_HOST_CLOSE_DELAY_MS)
    return true
  }

  const visible = firstVisibleWindow()
  if (visible) {
    micOwnerId = visible.webContents.id
    visible.webContents.send(EVENTS.MIC_START)
    return true
  }

  // Nothing open — host the mic ourselves. The renderer claims the mic when it
  // finishes loading (`claimMic` via useMicCapture), so there is no MIC_START
  // to send here: sending one now would race the preload bridge and be lost.
  if (!micHostWindow || micHostWindow.isDestroyed()) {
    log.info('[recording] no window open — starting a hidden host for the microphone')
    micHostWindow = createMicHost()
  }
  return true
}

/**
 * How long the mic host outlives the stop request.
 *
 * Covers the MIC_STOP hop, `MicRecorder.stop()`'s 60 ms tail wait, and the
 * final port flush. Comfortably longer than RecordingController's own 250 ms
 * drain so the window is never the reason a track ends early.
 */
const MIC_HOST_CLOSE_DELAY_MS = 1_500

/**
 * Hand the mic to a window that is ready for it.
 *
 * This is how the hidden host acquires the mic: it loads, `useMicCapture` asks,
 * and it gets the mic no window was holding. It is also how a real window
 * opened mid-meeting joins in — the mic simply starts late, and `startOffsetMs`
 * in meta.json already carries exactly that kind of gap between the tracks.
 *
 * Refused when nothing is recording. Otherwise every window would open its mic
 * on load, lighting the orange macOS microphone indicator on an idle app —
 * which, for a recorder, is precisely the accusation you never want to be open
 * to.
 */
function claimMic(id: number): boolean {
  if (!recordingController?.isRecording()) return false
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

  // Before the first window exists. `vibrancy` is sampled when the window is
  // created, so a saved Light theme applied after that point would leave the
  // frame dark until something forced it to redraw.
  nativeTheme.themeSource = settings.theme

  // Lives in its own process: better-sqlite3 is synchronous, and a heavy query
  // on main's thread freezes the tray — the one surface always on screen.
  const searchIndex = new IndexClient(join(app.getPath('userData'), 'index.sqlite'))
  indexClient = searchIndex
  /**
   * The exclusion list, refreshed by the recording controller on each start.
   *
   * A holder rather than the `settings` snapshot above, which is read once at
   * launch: a user who excludes an app in Settings expects it to apply to the
   * next recording, not the next app launch. The controller already calls
   * `loadSettings()` in `start()`, so this stays current without a second read
   * or a settings dependency inside the capture implementation.
   */
  const excludedBundleIds = { current: settings.excludedBundleIds }
  const capture = new MacAudioCapture(() => excludedBundleIds.current)
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

  const recording = (recordingController = new RecordingController({
    capture,
    onSessionComplete: (dir) => queue.enqueue(dir),
    broadcastState: (state) => broadcast(EVENTS.RECORDING_STATE, state),
    requestMic: (start) => requestMic(start),
    /*
     * Any installed model, not specifically the active one — the same rule the
     * setup screen uses. Someone who downloaded a different model and switched
     * to it is ready to record, and refusing because the default is absent
     * would block a perfectly working install.
     */
    hasModel: async () => (await models.list()).some((s) => s.status === 'ready'),
    onExcludedBundleIds: (ids) => {
      excludedBundleIds.current = ids
    },
  }))

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
    onSettingsChanged: (next) => {
      meetingSuggestions.current = next.meetingSuggestions
      detector?.refresh()
    },
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

  // Inside whenReady(), never at module scope — see registerTrayLifecycle.
  registerTrayLifecycle()

  createTray({
    recording,
    showMainWindow,
    openSession: (sessionId) => navigate({ kind: 'session', sessionId }),
    openSettings: () => navigate({ kind: 'settings' }),
    // Read on menu open rather than cached: the vault is the source of truth
    // and a session can appear from a recording started in another window.
    // listSessions already sorts newest-first, and the tray takes the head.
    recentSessions: async () => listSessions((await loadSettings()).vaultPath),
    dismissSuggestion: () => detector?.dismiss(),
  })

  /**
   * Meeting detection.
   *
   * Started after the tray exists, because a suggestion with nowhere to appear
   * is worse than a slightly later one — the probe would otherwise be able to
   * fire in the window between spawning and `createTray`.
   *
   * `isRecording` is read from the controller rather than tracked here so the
   * suppression is correct no matter who started the recording.
   */
  meetingSuggestions.current = settings.meetingSuggestions
  detector = new MeetingDetector({
    isRecording: () => recording.isRecording(),
    enabled: () => meetingSuggestions.current,
    onMeetingStarted: (app) => {
      log.info('[detect] meeting app opened the microphone', app)
      suggestRecording(app.name)
    },
    onMeetingEnded: () => clearSuggestion(),
  })
  detector.start()

  // A recording started by any route answers the suggestion, so the banner and
  // the menu row must go — including when the user ignored both and used the
  // shortcut.
  recording.on('started', () => clearSuggestion())

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

  /**
   * Rescue recordings the app died in the middle of.
   *
   * Strictly before resumePending: recovery works by writing the meta.json the
   * crashed process never got to write, which is exactly what turns a
   * directory the queue ignores into one it transcribes. Run in the other
   * order, the recovered sessions would sit until the next launch.
   *
   * Failure here is not fatal — the audio stays on disk either way, and a
   * vault that cannot be scanned is a problem the queue will report anyway.
   */
  try {
    const recovered = await recoverOrphanedSessions(settings.vaultPath)
    if (recovered.length > 0) {
      log.info('[app] recovered interrupted recordings', { count: recovered.length })
    }
  } catch (err) {
    log.warn('[app] orphan recovery failed', err)
  }

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
    // Counts real windows only. The invisible mic host is a window as far as
    // Electron is concerned, so a plain length check would see it, conclude a
    // window already exists, and leave clicking the Dock icon mid-recording
    // doing nothing at all.
    if (!hasVisibleWindow()) showMainWindow()
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
  // Same reasoning: the probe is a child process that polls forever, and an
  // orphaned one would keep watching the microphone after the recorder exits.
  detector?.stop()
})
