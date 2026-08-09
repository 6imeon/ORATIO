import {
  app,
  ipcMain,
  dialog,
  shell,
  systemPreferences,
  nativeTheme,
  BrowserWindow,
} from 'electron'
import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import log from 'electron-log/main'
import {
  IPC,
  EVENTS,
  type AIDoneEvent,
  type AITokenEvent,
  type ExportRequest,
  type PermissionState,
  type StartRecordingOptions,
  type StoredSummary,
  type SummarySection,
} from '@shared/ipc'
import { MODELS } from '@shared/models'
import type { KeyedProviderId, ModelId, Settings } from '@shared/types'
import type { AudioCapture } from '../audio/AudioCapture'
import type { RecordingController } from '../recording/RecordingController'
import type { TranscriptionQueue } from '../transcription/TranscriptionQueue'
import type { IndexClient } from '../storage/IndexClient'
import type { ModelManager } from '../models/ModelManager'
import {
  listSessions,
  readTranscript,
  readMeta,
  readNotes,
  writeNotes,
  deleteSession,
  discardSessionAudio,
  sessionDir,
} from '../storage/vault'
import { parseNotes, renderNotesDoc } from '../storage/notesDoc'
import { FORMATS, suggestedFilename } from '../export/formats'
import { writeExport } from '../export/exporter'
import { readCaptureHealth, inferTrackAccess } from '../storage/captureHealth'
import { resolveProvider, runSummarize } from '../ai/Summarizer'
import { listRunningApps } from '../audio/excludedApps'
import { loadSettings, saveSettings, setApiKey, hasApiKey } from '../storage/settings'

interface Deps {
  capture: AudioCapture
  recording: RecordingController
  queue: TranscriptionQueue
  searchIndex: IndexClient
  models: ModelManager
  showMainWindow: () => void
  /** Drop the index and re-derive it from the vault. Returns sessions indexed. */
  rebuildIndex: () => Promise<number>
  /**
   * Grant the microphone to a WebContents that opened mid-recording, if no
   * other window already holds it. Main owns this decision because only main
   * knows how many windows there are.
   */
  claimMic: (webContentsId: number) => boolean
  /**
   * Settings were written. Lets main apply the ones that own live resources —
   * currently meeting detection, which runs a child process that has to start
   * or stop when the toggle moves rather than at the next launch.
   */
  onSettingsChanged?: (settings: Settings) => void
  /**
   * Tell every window a session changed on disk. Main owns this because only
   * main knows how many windows there are — see `broadcast` in index.ts.
   */
  sessionChanged: (sessionId: string) => void
}

/**
 * All main↔renderer handlers.
 *
 * The renderer has no Node access and no direct filesystem reach — every
 * privileged operation goes through a named channel declared in shared/ipc.ts.
 */
export function registerIpc(deps: Deps): void {
  // -- Recording -----------------------------------------------------------

  /**
   * Start is idempotent from the caller's point of view but not silently so:
   * a second start while recording is a bug in the caller, and returning the
   * running session rather than throwing would hide it. The tray and the
   * window can both reach this, so it has to be explicit about the collision.
   */
  ipcMain.handle(IPC.RECORDING_START, (_e, opts: StartRecordingOptions = {}) =>
    deps.recording.start(opts),
  )

  ipcMain.handle(IPC.RECORDING_STOP, () => deps.recording.stop())

  /**
   * Pull, for a window that opens mid-recording. State is normally pushed on
   * EVENTS.RECORDING_STATE at ~30 Hz, but a renderer that starts late has
   * missed every push so far and would otherwise show "not recording" until
   * the next frame.
   */
  ipcMain.handle(IPC.RECORDING_STATE, () => deps.recording.state())

  /**
   * Answers "should I open the mic?" for a window that appeared mid-recording.
   *
   * False means another window already has it, and this one must stay quiet —
   * two live streams would interleave into one WAV. True means it joins late,
   * which meta.json already expresses through `startOffsetMs`.
   */
  ipcMain.handle(IPC.RECORDING_CLAIM_MIC, (e) => {
    if (!deps.recording.isRecording()) return false
    return deps.claimMic(e.sender.id)
  })

  // -- Sessions ------------------------------------------------------------

  ipcMain.handle(IPC.SESSION_GET, async (_e, sessionId: string) => {
    const settings = await loadSettings()
    return readMeta(sessionDir(settings.vaultPath, sessionId))
  })

  ipcMain.handle(IPC.SESSION_LIST, async () => {
    const settings = await loadSettings()
    return listSessions(settings.vaultPath)
  })

  ipcMain.handle(IPC.SESSION_TRANSCRIPT, async (_e, sessionId: string) => {
    const settings = await loadSettings()
    return readTranscript(sessionDir(settings.vaultPath, sessionId))
  })

  /**
   * The user's half of notes.md — never the summary.
   *
   * Both sides of this pair go through `parseNotes`/`renderNotesDoc` rather
   * than reading and writing the file whole. That is load-bearing: the
   * renderer autosaves the textarea 600 ms after every keystroke, so a `SET`
   * that wrote its argument over the entire file would erase the AI summary
   * the moment the user touched a key after generating one — and, because the
   * write succeeds, with no error anywhere.
   */
  ipcMain.handle(IPC.SESSION_NOTES_GET, async (_e, sessionId: string) => {
    const settings = await loadSettings()
    const doc = parseNotes(await readNotes(sessionDir(settings.vaultPath, sessionId)))
    return doc.userNotes
  })

  ipcMain.handle(IPC.SESSION_NOTES_SET, async (_e, sessionId: string, markdown: string) => {
    const settings = await loadSettings()
    const dir = sessionDir(settings.vaultPath, sessionId)
    const [meta, doc] = await Promise.all([readMeta(dir), readNotes(dir).then(parseNotes)])

    await writeNotes(
      dir,
      renderNotesDoc({
        title: meta?.title ?? sessionId,
        startedAt: meta?.startedAt ?? new Date().toISOString(),
        durationSeconds: meta?.durationSeconds ?? 0,
        doc: { ...doc, userNotes: markdown },
      }),
    )
  })

  ipcMain.handle(IPC.SESSION_DELETE, async (_e, sessionId: string) => {
    /**
     * Refuse to delete the session being recorded right now.
     *
     * The capture pipeline holds open WAV writers into that directory, so the
     * delete would either lose the race (the writers recreate the files and
     * half a meeting survives as an orphan with no meta.json) or win it and
     * leave the controller writing into a removed path for the rest of the
     * meeting. Neither is recoverable, and both look to the user like the app
     * corrupted a recording rather than like a request that was refused.
     *
     * Stopping first is one click, and the UI does not offer the control
     * here — this guard is for the tray, a second window, and anything that
     * reaches the channel while the sidebar is stale.
     */
    if (deps.recording.state().sessionId === sessionId) {
      throw new Error('Stop the recording before deleting it.')
    }

    const settings = await loadSettings()
    await deleteSession(sessionDir(settings.vaultPath, sessionId))

    // Best-effort: the files are already gone, which is what the user asked
    // for. A failure here leaves a stale hit that the next launch's reconcile
    // clears, so it must not turn a successful delete into an error.
    await deps.searchIndex
      .removeSession(sessionId)
      .catch((err) => log.warn('[ipc] could not unindex deleted session', sessionId, err))

    // Every window, not just the one that asked. The deleting window could
    // refresh itself, but a second window showing the same vault would keep a
    // dead session in its sidebar until something else happened to change.
    deps.sessionChanged(sessionId)
  })

  ipcMain.handle(IPC.SESSION_REVEAL, async (_e, sessionId: string) => {
    const settings = await loadSettings()
    shell.showItemInFolder(join(sessionDir(settings.vaultPath, sessionId), 'notes.md'))
  })

  /**
   * Export one meeting to a file the user chooses.
   *
   * The whole operation lives in main because the renderer has no filesystem
   * access — it names a session and a format, and gets back the path that was
   * written. A cancelled dialog resolves null rather than rejecting: closing a
   * save sheet is not an error, and treating it as one would put an error
   * message on screen every time someone changed their mind.
   */
  ipcMain.handle(IPC.SESSION_EXPORT, async (event, req: ExportRequest) => {
    const settings = await loadSettings()
    const dir = sessionDir(settings.vaultPath, req.sessionId)

    const meta = await readMeta(dir)
    if (!meta) throw new Error('That meeting could not be found.')

    const notes = parseNotes(await readNotes(dir))
    const transcript = await readTranscript(dir)
    const source = { meta, notes, transcript }
    const spec = FORMATS[req.format]

    // Parented to the requesting window so the save sheet slides out of it
    // rather than appearing as a detached dialog — and so it is modal to that
    // window only, leaving a recording in another one usable.
    const parent = BrowserWindow.fromWebContents(event.sender)
    const result = await dialog.showSaveDialog(parent ?? undefined!, {
      title: `Export as ${spec.label}`,
      defaultPath: suggestedFilename(meta, req.format),
      filters: [{ name: spec.label, extensions: [spec.extension] }],
    })

    if (result.canceled || !result.filePath) return null

    await writeExport(source, req.format, result.filePath, {
      includeTranscript: req.includeTranscript,
    })

    log.info('[export] wrote meeting', {
      sessionId: req.sessionId,
      format: req.format,
      path: result.filePath,
    })

    return result.filePath
  })

  /**
   * Returns ids and snippets only — never whole transcripts (UI.md §0).
   *
   * `SearchHit` carries a bounded snippet built by FTS5 around the match, so a
   * query matching a two-hour meeting costs a few hundred bytes rather than the
   * megabyte its transcript.json occupies. The renderer fetches the full
   * transcript through SESSION_TRANSCRIPT once the user picks a result.
   *
   * A dead index worker returns no results rather than rejecting: the search
   * box going quiet is a better failure than an error dialog on every
   * keystroke, and the reason is already in the log.
   */
  ipcMain.handle(IPC.SESSION_SEARCH, async (_e, query: string) => {
    try {
      return await deps.searchIndex.search(query)
    } catch (err) {
      log.warn('[ipc] search failed', err)
      return []
    }
  })

  /**
   * Rebuild the index from the vault.
   *
   * The escape hatch that keeps "SQLite is derived" an honest claim rather than
   * an aspiration — if the index is ever wrong, this is the fix, and it needs
   * nothing but the files.
   */
  ipcMain.handle(IPC.SESSION_REINDEX, () => deps.rebuildIndex())

  /**
   * Discard a session's audio after the fact.
   *
   * Irreversible, and the renderer is expected to confirm before calling —
   * the transcript is not a substitute for the recording, since ASR is
   * imperfect and a garbled name is only recoverable from the audio.
   */
  ipcMain.handle(IPC.SESSION_DISCARD_AUDIO, async (_e, sessionId: string) => {
    const settings = await loadSettings()
    const dir = sessionDir(settings.vaultPath, sessionId)

    // Refuse while the session is still the only copy. Deleting audio for a
    // session that has not been transcribed destroys the meeting outright.
    if (!existsSync(join(dir, 'transcript.json'))) {
      throw new Error('Cannot discard audio before the session has been transcribed')
    }

    await discardSessionAudio(dir)
    log.info(`[ipc] audio discarded for ${sessionId}`)

    // The transport bar is still showing a player for files that no longer
    // exist until something re-reads the session.
    deps.sessionChanged(sessionId)
  })

  /**
   * Local file URL for a session's audio track.
   *
   * This is what powers click-a-transcript-line-to-hear-it — the single most
   * requested feature missing from the commercial tools, and one they cannot
   * offer because they delete the audio. We keep it, so it costs us nothing.
   */
  ipcMain.handle(
    IPC.SESSION_AUDIO_URL,
    async (_e, sessionId: string, track: 'mic' | 'system') => {
      const settings = await loadSettings()
      const dir = sessionDir(settings.vaultPath, sessionId)
      const file = track === 'mic' ? 'mic.wav' : 'system.wav'
      const path = join(dir, file)

      // Null rather than a URL when the audio is gone — a session recorded
      // with "don't keep audio" has a transcript but no WAVs, and handing the
      // renderer a URL to a deleted file produces a silent, broken <audio>
      // element instead of an explanation.
      if (!existsSync(path)) return null

      /*
       * Deliberately NOT `file://`. Chromium blocks file:// subresources in the
       * dev renderer, which is served over http — playback failed silently in
       * dev and worked when packaged. The custom scheme behaves identically in
       * both; it is registered in `index.ts`, which also rebuilds the path from
       * the vault root so a crafted URL cannot escape it.
       */
      return `oratio-audio://${encodeURIComponent(sessionId)}/${file}`
    },
  )

  // -- Settings ------------------------------------------------------------

  ipcMain.handle(IPC.SETTINGS_GET, () => loadSettings())

  ipcMain.handle(IPC.SETTINGS_SET, async (_e, patch: Partial<Settings>) => {
    const next = { ...(await loadSettings()), ...patch }
    await saveSettings(next)

    /**
     * `launchAtLogin` is the one setting that lives outside our own file.
     *
     * Storing the boolean is not the feature — macOS keeps the real login-item
     * registration, and until now nothing told it. Applied on every write
     * rather than only on change, because the OS is the source of truth and
     * they can drift: a user who removes Oratio from Login Items in System
     * Settings leaves our JSON saying `true`, and a comparison against the
     * stored value would then skip the fix forever.
     */
    if (app.isPackaged) {
      app.setLoginItemSettings({ openAtLogin: next.launchAtLogin })
    }

    /**
     * The window's vibrancy is drawn by AppKit, not by our CSS.
     *
     * `body` is transparent so the `vibrancy: 'sidebar'` layer shows through,
     * and that layer follows the *system* appearance — so setting `data-theme`
     * in the renderer alone gives a light UI sitting on a dark blurred
     * backdrop, or the reverse. `themeSource` is what actually moves it, and
     * it also fixes the native scrollbars, the traffic lights and any system
     * dialog. Set here so the renderer and the frame can never disagree.
     */
    nativeTheme.themeSource = next.theme

    // Meeting detection owns a child process, so turning it off has to reach
    // the detector rather than only the JSON — see `refresh`.
    deps.onSettingsChanged?.(next)

    return next
  })

  ipcMain.handle(IPC.SETTINGS_PICK_VAULT, async () => {
    const res = await dialog.showOpenDialog({
      title: 'Choose where Oratio stores your recordings',
      properties: ['openDirectory', 'createDirectory'],
      buttonLabel: 'Use this folder',
    })
    if (res.canceled || !res.filePaths[0]) return null

    const next = { ...(await loadSettings()), vaultPath: res.filePaths[0] }
    await saveSettings(next)
    return next.vaultPath
  })

  /**
   * "Reveal in Finder", for the vault root.
   *
   * Creates the directory first if it is missing. That is not defensive
   * tidiness — the vault is created lazily by the first recording, so on a
   * fresh install this button would otherwise point at a path that does not
   * exist yet, and `showItemInFolder` on a missing path fails silently. A
   * button that does nothing when pressed is the anarlog complaint verbatim
   * (UI.md §7), so the folder is made real rather than the failure explained.
   *
   * `openPath` on the directory itself, not `showItemInFolder` — we want the
   * folder opened and its contents shown, not the folder selected inside its
   * parent.
   */
  ipcMain.handle(IPC.SETTINGS_REVEAL_VAULT, async () => {
    const { vaultPath } = await loadSettings()
    await mkdir(vaultPath, { recursive: true })

    // Resolves with an error STRING rather than rejecting — an empty string
    // means success. Surfaced as a real rejection so the UI can say something.
    const err = await shell.openPath(vaultPath)
    if (err) throw new Error(`Could not open ${vaultPath}: ${err}`)
  })

  /**
   * Deep links only: `x-apple.systempreferences:` panes and https URLs.
   *
   * Allow-listed by scheme because this is a renderer-reachable channel that
   * hands a string to the OS handler. `file:` is deliberately excluded — the
   * renderer has no filesystem reach anywhere else in this bridge, and this
   * must not become the exception that gives it one.
   */
  ipcMain.handle(IPC.SETTINGS_OPEN_EXTERNAL, async (_e, url: string) => {
    const allowed = ['x-apple.systempreferences:', 'https:']
    if (!allowed.some((scheme) => url.startsWith(scheme))) {
      throw new Error(`Refusing to open ${url}`)
    }
    await shell.openExternal(url)
  })

  ipcMain.handle(IPC.SETTINGS_RUNNING_APPS, () => listRunningApps())

  // -- Models --------------------------------------------------------------

  ipcMain.handle(IPC.MODEL_LIST, () => Object.values(MODELS))

  ipcMain.handle(IPC.MODEL_STATES, () => deps.models.list())

  /**
   * Downloads report progress on an event channel rather than resolving with
   * it, so the renderer can show a live bar. The promise still settles on
   * completion or failure — a UI that only listened to events would have no
   * way to distinguish "finished" from "stalled".
   */
  ipcMain.handle(IPC.MODEL_DOWNLOAD, async (e, id: ModelId) => {
    await deps.models.download(id, (state) => {
      // The window can be closed mid-download — this is a menu-bar app and
      // that is normal, not an error. Sending to a destroyed WebContents
      // throws, which would fail the whole download for no reason.
      if (!e.sender.isDestroyed()) e.sender.send(EVENTS.MODEL_PROGRESS, state)
    })
  })

  ipcMain.handle(IPC.MODEL_CANCEL, (_e, id: ModelId) => deps.models.cancel(id))

  ipcMain.handle(IPC.MODEL_DELETE, (_e, id: ModelId) => deps.models.remove(id))

  // -- AI providers --------------------------------------------------------

  ipcMain.handle(IPC.AI_SET_KEY, async (_e, provider: KeyedProviderId, key: string) => {
    await setApiKey(provider, key)
  })

  ipcMain.handle(IPC.AI_PROVIDERS, async () => {
    const settings = await loadSettings()
    return Promise.all(
      settings.providers.map(async (p) => ({
        ...p,
        hasApiKey: p.id === 'ollama' ? undefined : await hasApiKey(p.id),
      })),
    )
  })

  /**
   * One summary run per session, tracked so it can be cancelled.
   *
   * Keyed by session rather than a single global: summarising one meeting
   * while reading another is ordinary use, and a single slot would silently
   * abort the first when the second started.
   */
  const running = new Map<string, AbortController>()

  ipcMain.handle(IPC.AI_SUMMARIZE, async (e, sessionId: string) => {
    // Claimed SYNCHRONOUSLY, before the first await.
    //
    // A check followed by an awaited setup would not exclude anything: `async`
    // yields at its first await, so two calls a millisecond apart — a
    // double-click, or the window and the tray both asking — would both pass
    // the check before either registered, then stream into the same file and
    // race on the write. The slot has to be taken in the same synchronous turn
    // as the test.
    if (running.has(sessionId)) throw new Error('This meeting is already being summarised')
    const controller = new AbortController()
    running.set(sessionId, controller)

    try {
      return await summarizeSession(sessionId, controller)
    } finally {
      running.delete(sessionId)
    }
  })

  /**
   * The body of AI_SUMMARIZE, split out so the handler above stays synchronous
   * up to the point where it claims the session.
   */
  async function summarizeSession(sessionId: string, controller: AbortController): Promise<void> {
    const settings = await loadSettings()
    const provider = await resolveProvider(settings)
    if (!provider) {
      throw new Error(
        'No summariser is configured. Install Ollama for a fully local summary, or add an API key in Settings.',
      )
    }
    if (!(await provider.isAvailable())) {
      throw new Error(
        provider.id === 'ollama'
          ? 'Ollama is not responding. Start it and try again.'
          : `${provider.id} is not reachable. Check the API key in Settings.`,
      )
    }

    const dir = sessionDir(settings.vaultPath, sessionId)
    const [meta, transcript, raw] = await Promise.all([
      readMeta(dir),
      readTranscript(dir),
      readNotes(dir),
    ])

    // The transcript is the input, so there is nothing to summarise without
    // one. This is reachable: the button is live on a session still in the
    // transcription queue.
    if (!transcript || transcript.segments.length === 0) {
      throw new Error('This meeting has not been transcribed yet.')
    }

    const doc = parseNotes(raw)

    // Sent to every window, not just the caller's. A summary started from one
    // window and watched from another is normal in a menu-bar app, and the
    // sender may well be closed before the stream finishes.
    const emit = (channel: string, payload: unknown): void => {
      for (const w of BrowserWindow.getAllWindows()) {
        if (!w.webContents.isDestroyed()) w.webContents.send(channel, payload)
      }
    }

    /**
     * Accumulated outside the try, so a cancel can still persist what arrived.
     *
     * Aborting a `fetch` rejects the in-flight read, so `runSummarize` throws
     * rather than returning — its return value is unreachable on exactly the
     * path where the user stopped a summary they were watching fill in. Held
     * here, the partial survives that throw.
     */
    const sections: Partial<Record<SummarySection, string>> = {}

    const persist = async (): Promise<void> => {
      await writeNotes(
        dir,
        renderNotesDoc({
          title: meta?.title ?? sessionId,
          startedAt: meta?.startedAt ?? new Date().toISOString(),
          durationSeconds: meta?.durationSeconds ?? 0,
          doc: {
            ...doc,
            summary: sections,
            generatedAt: new Date().toISOString(),
            provider: provider.id,
          },
        }),
      )
    }

    try {
      await runSummarize(
        provider,
        {
          title: meta?.title ?? sessionId,
          transcript,
          userNotes: doc.userNotes,
        },
        {
          onDelta: (section, delta) => {
            sections[section] = (sections[section] ?? '') + delta
            emit(EVENTS.AI_TOKEN, { sessionId, section, delta } satisfies AITokenEvent)
          },
        },
        controller.signal,
      )

      for (const key of Object.keys(sections) as SummarySection[]) {
        sections[key] = sections[key]?.trim()
      }

      await persist()
      emit(EVENTS.AI_DONE, { sessionId, status: 'complete' } satisfies AIDoneEvent)
      log.info(`[ai] summary complete for ${sessionId} via ${provider.id}`)
    } catch (err) {
      // An abort surfaces as a thrown DOMException from fetch rather than a
      // clean return, so it has to be classified here or a deliberate cancel
      // would be reported to the user as a failure.
      if (controller.signal.aborted) {
        // A partial summary the user stopped is still theirs, and throwing
        // away work they watched arrive would be worse than keeping it.
        // "Reset to my notes" removes it in one click.
        for (const key of Object.keys(sections) as SummarySection[]) {
          sections[key] = sections[key]?.trim()
        }
        if (Object.keys(sections).length > 0) await persist()
        emit(EVENTS.AI_DONE, { sessionId, status: 'cancelled' } satisfies AIDoneEvent)
        log.info(`[ai] summary cancelled for ${sessionId}`)
        return
      }

      const message = err instanceof Error ? err.message : String(err)
      emit(EVENTS.AI_DONE, { sessionId, status: 'failed', error: message } satisfies AIDoneEvent)
      log.warn(`[ai] summary failed for ${sessionId}`, err)
      throw err
    }
  }

  ipcMain.handle(IPC.AI_CANCEL, (_e, sessionId: string) => {
    running.get(sessionId)?.abort()
  })

  ipcMain.handle(IPC.AI_SUMMARY_GET, async (_e, sessionId: string): Promise<StoredSummary> => {
    const settings = await loadSettings()
    const doc = parseNotes(await readNotes(sessionDir(settings.vaultPath, sessionId)))
    return { sections: doc.summary, generatedAt: doc.generatedAt, provider: doc.provider }
  })

  /**
   * "Reset to my notes" — drop the summary, keep everything the user wrote.
   *
   * Non-destructive by construction rather than by care: the summary and the
   * notes are separate fields of the parsed document, so clearing one cannot
   * reach the other even if this code is wrong.
   */
  ipcMain.handle(IPC.AI_SUMMARY_CLEAR, async (_e, sessionId: string) => {
    const settings = await loadSettings()
    const dir = sessionDir(settings.vaultPath, sessionId)
    const [meta, doc] = await Promise.all([
      readMeta(dir),
      readNotes(dir).then(parseNotes),
    ])

    await writeNotes(
      dir,
      renderNotesDoc({
        title: meta?.title ?? sessionId,
        startedAt: meta?.startedAt ?? new Date().toISOString(),
        durationSeconds: meta?.durationSeconds ?? 0,
        doc: { ...doc, summary: {}, generatedAt: null, provider: null },
      }),
    )
  })

  // -- Permissions ---------------------------------------------------------

  /**
   * Mic status is queried; system-audio status is inferred.
   *
   * The asymmetry is macOS's, not ours. `getMediaAccessStatus` answers for the
   * microphone directly, but there is no equivalent for a Core Audio process
   * tap and no way to test one without starting it — so the system-audio
   * answer comes from what the last completed recording actually captured
   * (ARCHITECTURE §6). That evidence is written at stop() and read here, which
   * is why this reports `likely-` rather than a definite state, and why it
   * carries the observation date: the UI has to be able to say *when* it saw
   * this work rather than implying it is checking now.
   */
  ipcMain.handle(IPC.PERMISSION_CHECK, async (): Promise<PermissionState> => {
    const health = await readCaptureHealth()
    return {
      microphone: systemPreferences.getMediaAccessStatus('microphone'),
      systemAudio: inferTrackAccess(health?.systemPeak),
      systemAudioObservedAt: health?.observedAt ?? null,
    }
  })

  ipcMain.handle(IPC.PERMISSION_REQUEST_MIC, async () => {
    return systemPreferences.askForMediaAccess('microphone')
  })

  log.info('[ipc] handlers registered')
}
