import { contextBridge, ipcRenderer } from 'electron'
import { IPC, EVENTS } from '@shared/ipc'
import type { PermissionState, TranscriptionProgress } from '@shared/ipc'
import type {
  ModelInfo,
  ProviderConfig,
  Session,
  Settings,
  Transcript,
} from '@shared/types'

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
    search: (q: string) => ipcRenderer.invoke(IPC.SESSION_SEARCH, q),
    /** Local file:// URL, so an <audio> element can seek to any transcript line. */
    audioUrl: (id: string, track: 'mic' | 'system'): Promise<string> =>
      ipcRenderer.invoke(IPC.SESSION_AUDIO_URL, id, track),
  },

  recording: {
    start: (): Promise<void> => ipcRenderer.invoke(IPC.RECORDING_START),
    stop: (): Promise<void> => ipcRenderer.invoke(IPC.RECORDING_STOP),
  },

  settings: {
    get: (): Promise<Settings> => ipcRenderer.invoke(IPC.SETTINGS_GET),
    set: (patch: Partial<Settings>): Promise<Settings> =>
      ipcRenderer.invoke(IPC.SETTINGS_SET, patch),
    pickVault: (): Promise<string | null> => ipcRenderer.invoke(IPC.SETTINGS_PICK_VAULT),
  },

  models: {
    list: (): Promise<ModelInfo[]> => ipcRenderer.invoke(IPC.MODEL_LIST),
    download: (id: string): Promise<void> => ipcRenderer.invoke(IPC.MODEL_DOWNLOAD, id),
    cancel: (id: string): Promise<void> => ipcRenderer.invoke(IPC.MODEL_CANCEL, id),
    remove: (id: string): Promise<void> => ipcRenderer.invoke(IPC.MODEL_DELETE, id),
  },

  ai: {
    providers: (): Promise<ProviderConfig[]> => ipcRenderer.invoke(IPC.AI_PROVIDERS),
    setKey: (provider: 'anthropic' | 'openai', key: string): Promise<void> =>
      ipcRenderer.invoke(IPC.AI_SET_KEY, provider, key),
    summarize: (sessionId: string): Promise<void> =>
      ipcRenderer.invoke(IPC.AI_SUMMARIZE, sessionId),
  },

  permissions: {
    check: (): Promise<PermissionState> => ipcRenderer.invoke(IPC.PERMISSION_CHECK),
    requestMic: (): Promise<boolean> => ipcRenderer.invoke(IPC.PERMISSION_REQUEST_MIC),
  },

  /**
   * main→renderer events. Each returns its own unsubscribe function; React
   * effects must call it on cleanup or listeners accumulate across renders.
   */
  on: {
    recordingState: (cb: (s: unknown) => void) => subscribe(EVENTS.RECORDING_STATE, cb),
    transcriptionProgress: (cb: (p: TranscriptionProgress) => void) =>
      subscribe(EVENTS.TRANSCRIPTION_PROGRESS, cb),
    transcriptionPartial: (cb: (text: string) => void) =>
      subscribe(EVENTS.TRANSCRIPTION_PARTIAL, cb),
    modelProgress: (cb: (p: unknown) => void) => subscribe(EVENTS.MODEL_PROGRESS, cb),
    sessionChanged: (cb: (id: string) => void) => subscribe(EVENTS.SESSION_CHANGED, cb),
    aiToken: (cb: (token: string) => void) => subscribe(EVENTS.AI_TOKEN, cb),
  },
}

function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const handler = (_e: Electron.IpcRendererEvent, payload: T) => cb(payload)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

contextBridge.exposeInMainWorld('oratio', api)

export type OratioApi = typeof api
