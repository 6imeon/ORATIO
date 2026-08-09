import { contextBridge, ipcRenderer } from 'electron'
import { IPC, EVENTS } from '@shared/ipc'
import { AUDIO_PORT_CHANNEL, type AudioPortMessage } from '@shared/audioPort'
import type {
  AIDoneEvent,
  AITokenEvent,
  ExportRequest,
  NavTarget,
  PermissionState,
  StoredSummary,
  TranscriptionProgress,
  StartRecordingOptions,
  StartRecordingResult,
} from '@shared/ipc'
import type {
  KeyedProviderId,
  ModelId,
  ModelInfo,
  ModelState,
  ProviderConfig,
  RecordingState,
  SearchHit,
  Session,
  SessionMeta,
  Settings,
  Transcript,
} from '@shared/types'

/**
 * The renderer's handle on the PCM port. Deliberately three plain functions:
 * contextBridge can pass functions but not MessagePorts, so the port stays in
 * the preload realm and the renderer only ever holds callables.
 */
export interface AudioPortHandle {
  /**
   * Mono Float32 PCM at 16 kHz. A TypedArray, deliberately: a bare
   * ArrayBuffer does not survive contextBridge, and fails silently when it
   * doesn't (see `send` below).
   */
  send: (pcm: Float32Array) => void
  control: (msg: AudioPortMessage) => void
  close: () => void
}

/**
 * The only bridge between renderer and main.
 *
 * contextIsolation is on and nodeIntegration is off, so the renderer gets
 * exactly this surface — no `require`, no filesystem, no child processes.
 * Every capability the UI has is enumerated here.
 */
const api = {
  session: {
    list: (): Promise<Session[]> => ipcRenderer.invoke(IPC.SESSION_LIST),
    transcript: (id: string): Promise<Transcript | null> =>
      ipcRenderer.invoke(IPC.SESSION_TRANSCRIPT, id),
    getNotes: (id: string): Promise<string> => ipcRenderer.invoke(IPC.SESSION_NOTES_GET, id),
    setNotes: (id: string, md: string): Promise<void> =>
      ipcRenderer.invoke(IPC.SESSION_NOTES_SET, id, md),
    remove: (id: string): Promise<void> => ipcRenderer.invoke(IPC.SESSION_DELETE, id),
    reveal: (id: string): Promise<void> => ipcRenderer.invoke(IPC.SESSION_REVEAL, id),
    /**
     * Write this meeting to a file the user picks. Resolves with the path, or
     * null when they cancelled the save dialog — which is a normal outcome, not
     * an error, so the caller checks for null rather than catching.
     */
    exportTo: (req: ExportRequest): Promise<string | null> =>
      ipcRenderer.invoke(IPC.SESSION_EXPORT, req),
    /** Ids and snippets only — never whole transcripts (UI.md §0). */
    search: (q: string): Promise<SearchHit[]> => ipcRenderer.invoke(IPC.SESSION_SEARCH, q),
    /**
     * Rebuild the search index by rescanning the vault. Resolves with the
     * number of sessions indexed.
     */
    reindex: (): Promise<number> => ipcRenderer.invoke(IPC.SESSION_REINDEX),
    /** Local file:// URL, so an <audio> element can seek to any transcript line. */
    /** Null when the session's audio was discarded — see SESSION_AUDIO_URL. */
    audioUrl: (id: string, track: 'mic' | 'system'): Promise<string | null> =>
      ipcRenderer.invoke(IPC.SESSION_AUDIO_URL, id, track),
    /**
     * Delete this session's audio now, keeping the transcript. The
     * after-the-fact counterpart to recording with `discardAudio`.
     */
    discardAudio: (id: string): Promise<void> =>
      ipcRenderer.invoke(IPC.SESSION_DISCARD_AUDIO, id),
  },

  recording: {
    /**
     * `discardAudio` deletes both WAVs as soon as the transcript exists.
     *
     * It has to be chosen HERE, before recording, not afterwards: the choice
     * is written into meta.json so it survives a crash and is honoured even if
     * transcription only happens on the next launch.
     */
    start: (opts?: StartRecordingOptions): Promise<StartRecordingResult> =>
      ipcRenderer.invoke(IPC.RECORDING_START, opts ?? {}),
    stop: (): Promise<SessionMeta | null> => ipcRenderer.invoke(IPC.RECORDING_STOP),
    /**
     * Current state, for a window that opens mid-recording. State is otherwise
     * pushed at ~30 Hz, and a renderer that starts late has missed every push.
     */
    state: (): Promise<RecordingState> => ipcRenderer.invoke(IPC.RECORDING_STATE),
    /**
     * Ask main whether this window should run the mic — for a window opened
     * mid-recording, which missed the MIC_START push. False means another
     * window already holds it.
     */
    claimMic: (): Promise<boolean> => ipcRenderer.invoke(IPC.RECORDING_CLAIM_MIC),

    /**
     * Hand main one end of a MessagePort for mic PCM.
     *
     * This is the only part of the bridge that uses `postMessage` rather than
     * `invoke`, and it has to: `invoke` and `send` cannot transfer, so audio
     * sent through them is structured-cloned on every chunk. The port is
     * transferred once and all PCM rides it afterwards, bypassing the IPC
     * router entirely.
     *
     * The MessageChannel is constructed here rather than in the renderer
     * because contextBridge cannot pass a MessagePort across the isolated
     * world boundary — only the preload realm can hand one to ipcRenderer.
     * The renderer gets back a plain function to feed it.
     */
    openAudioPort: (): AudioPortHandle => {
      const { port1, port2 } = new MessageChannel()
      ipcRenderer.postMessage(AUDIO_PORT_CHANNEL, null, [port2])

      port1.start()

      return {
        /**
         * Takes a Float32Array, NOT an ArrayBuffer.
         *
         * An ArrayBuffer cannot cross contextBridge: it is neither cloned nor
         * transferred, and — the expensive part — `postMessage` accepts the
         * result without complaint. Every chunk then arrives detached at zero
         * bytes and the recording is silently empty, with no error in the
         * renderer, the preload, or main.
         *
         * A TypedArray does survive, so the buffer is reconstituted here in
         * the preload realm, where the transfer is meaningful.
         */
        send: (pcm: Float32Array) => {
          const copy = new Float32Array(pcm.length)
          copy.set(pcm)
          port1.postMessage({ pcm: copy })
        },
        control: (msg: AudioPortMessage) => port1.postMessage(msg),
        close: () => port1.close(),
      }
    },
  },

  settings: {
    get: (): Promise<Settings> => ipcRenderer.invoke(IPC.SETTINGS_GET),
    set: (patch: Partial<Settings>): Promise<Settings> =>
      ipcRenderer.invoke(IPC.SETTINGS_SET, patch),
    pickVault: (): Promise<string | null> => ipcRenderer.invoke(IPC.SETTINGS_PICK_VAULT),
    /**
     * Open the vault in Finder, creating it if the first recording has not
     * made it yet. Rejects with a readable message if Finder refuses.
     */
    revealVault: (): Promise<void> => ipcRenderer.invoke(IPC.SETTINGS_REVEAL_VAULT),
    /** System Settings panes and https links only — see the handler. */
    openExternal: (url: string): Promise<void> =>
      ipcRenderer.invoke(IPC.SETTINGS_OPEN_EXTERNAL, url),
  },

  models: {
    list: (): Promise<ModelInfo[]> => ipcRenderer.invoke(IPC.MODEL_LIST),
    /** Installed/downloading/absent, per model. Separate from the catalogue. */
    states: (): Promise<ModelState[]> => ipcRenderer.invoke(IPC.MODEL_STATES),
    download: (id: ModelId): Promise<void> => ipcRenderer.invoke(IPC.MODEL_DOWNLOAD, id),
    cancel: (id: ModelId): Promise<void> => ipcRenderer.invoke(IPC.MODEL_CANCEL, id),
    remove: (id: ModelId): Promise<void> => ipcRenderer.invoke(IPC.MODEL_DELETE, id),
  },

  ai: {
    providers: (): Promise<ProviderConfig[]> => ipcRenderer.invoke(IPC.AI_PROVIDERS),
    setKey: (provider: KeyedProviderId, key: string): Promise<void> =>
      ipcRenderer.invoke(IPC.AI_SET_KEY, provider, key),
    /**
     * Summarise a meeting. Resolves when the stream ends; the text itself
     * arrives on `on.aiToken` as it is generated, so the UI fills in live
     * rather than appearing all at once after a minute of nothing.
     */
    summarize: (sessionId: string): Promise<void> =>
      ipcRenderer.invoke(IPC.AI_SUMMARIZE, sessionId),
    /** Stop a run in flight. Whatever streamed so far is kept. */
    cancel: (sessionId: string): Promise<void> =>
      ipcRenderer.invoke(IPC.AI_CANCEL, sessionId),
    /** The stored summary, read back from notes.md. */
    summary: (sessionId: string): Promise<StoredSummary> =>
      ipcRenderer.invoke(IPC.AI_SUMMARY_GET, sessionId),
    /** "Reset to my notes" — drops the summary, keeps what the user wrote. */
    clearSummary: (sessionId: string): Promise<void> =>
      ipcRenderer.invoke(IPC.AI_SUMMARY_CLEAR, sessionId),
  },

  permissions: {
    check: (): Promise<PermissionState> => ipcRenderer.invoke(IPC.PERMISSION_CHECK),
    requestMic: (): Promise<boolean> => ipcRenderer.invoke(IPC.PERMISSION_REQUEST_MIC),
  },

  /**
   * Where this window was asked to go before it was listening.
   *
   * A window created by a tray click is not subscribed to `navigate` yet at
   * the moment main fires it, so main parks the target and the renderer
   * collects it here on mount. Null when the window was opened by hand.
   * Collecting clears it, so a reload does not jump back.
   */
  pendingNav: (): Promise<NavTarget | null> => ipcRenderer.invoke(IPC.NAV_PENDING),

  /**
   * main→renderer events. Each returns its own unsubscribe function; React
   * effects must call it on cleanup or listeners accumulate across renders.
   */
  on: {
    recordingState: (cb: (s: RecordingState) => void) => subscribe(EVENTS.RECORDING_STATE, cb),
    /**
     * Main asking this window to open or close the microphone.
     *
     * The renderer does not decide when to record — main does, because the
     * tray can start a meeting with no window open. This window's only job is
     * to run `getUserMedia` when asked, since that API exists nowhere else.
     */
    micStart: (cb: () => void) => subscribe(EVENTS.MIC_START, cb),
    micStop: (cb: () => void) => subscribe(EVENTS.MIC_STOP, cb),
    transcriptionProgress: (cb: (p: TranscriptionProgress) => void) =>
      subscribe(EVENTS.TRANSCRIPTION_PROGRESS, cb),
    transcriptionPartial: (cb: (text: string) => void) =>
      subscribe(EVENTS.TRANSCRIPTION_PARTIAL, cb),
    modelProgress: (cb: (p: ModelState) => void) => subscribe(EVENTS.MODEL_PROGRESS, cb),
    sessionChanged: (cb: (id: string) => void) => subscribe(EVENTS.SESSION_CHANGED, cb),
    /** A summary delta, tagged with the section it belongs to. */
    aiToken: (cb: (e: AITokenEvent) => void) => subscribe(EVENTS.AI_TOKEN, cb),
    /** A summary run ended — completed, cancelled, or failed. */
    aiDone: (cb: (e: AIDoneEvent) => void) => subscribe(EVENTS.AI_DONE, cb),
    /** The tray asking this window to show a session or the Settings pane. */
    navigate: (cb: (t: NavTarget) => void) => subscribe(EVENTS.NAVIGATE, cb),
  },
}

function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const handler = (_e: Electron.IpcRendererEvent, payload: T) => cb(payload)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

contextBridge.exposeInMainWorld('oratio', api)

export type OratioApi = typeof api
