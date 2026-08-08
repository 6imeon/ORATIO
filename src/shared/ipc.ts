/**
 * IPC channel names.
 *
 * Centralised so main and preload can never drift apart on a string literal.
 * `invoke` channels are request/response; `event` channels are main→renderer
 * pushes.
 */

export const IPC = {
  // Recording
  RECORDING_START: 'recording:start',
  RECORDING_STOP: 'recording:stop',
  RECORDING_STATE: 'recording:state',

  // Sessions
  SESSION_LIST: 'session:list',
  SESSION_GET: 'session:get',
  SESSION_TRANSCRIPT: 'session:transcript',
  SESSION_NOTES_GET: 'session:notes:get',
  SESSION_NOTES_SET: 'session:notes:set',
  SESSION_DELETE: 'session:delete',
  SESSION_REVEAL: 'session:reveal',
  SESSION_SEARCH: 'session:search',

  // Audio playback — the differentiator: click a transcript line, hear it
  SESSION_AUDIO_URL: 'session:audio:url',

  // Models
  MODEL_LIST: 'model:list',
  MODEL_DOWNLOAD: 'model:download',
  MODEL_CANCEL: 'model:cancel',
  MODEL_DELETE: 'model:delete',

  // Settings
  SETTINGS_GET: 'settings:get',
  SETTINGS_SET: 'settings:set',
  SETTINGS_PICK_VAULT: 'settings:pickVault',

  // AI providers
  AI_PROVIDERS: 'ai:providers',
  AI_SET_KEY: 'ai:setKey',
  AI_SUMMARIZE: 'ai:summarize',

  // Permissions
  PERMISSION_CHECK: 'permission:check',
  PERMISSION_REQUEST_MIC: 'permission:requestMic',
} as const

/** main → renderer pushes. */
export const EVENTS = {
  RECORDING_STATE: 'evt:recording:state',
  TRANSCRIPTION_PROGRESS: 'evt:transcription:progress',
  /** Partial transcript during a live session (streaming models only). */
  TRANSCRIPTION_PARTIAL: 'evt:transcription:partial',
  MODEL_PROGRESS: 'evt:model:progress',
  SESSION_CHANGED: 'evt:session:changed',
  AI_TOKEN: 'evt:ai:token',
} as const

export interface TranscriptionProgress {
  sessionId: string
  stage: 'queued' | 'vad' | 'transcribing' | 'merging' | 'done' | 'failed'
  /** 0..1 within the current stage. */
  progress: number
  queued: number
  error?: string
}

export interface PermissionState {
  /** Mirrors Electron's getMediaAccessStatus, which includes 'unknown'. */
  microphone: 'granted' | 'denied' | 'not-determined' | 'restricted' | 'unknown'
  /**
   * macOS exposes no API to query system-audio TCC state without side
   * effects, so this is inferred from whether the last capture produced
   * a non-silent buffer. `unknown` until a recording has been attempted.
   */
  systemAudio: 'likely-granted' | 'likely-denied' | 'unknown'
}
