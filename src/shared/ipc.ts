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
  /**
   * A window that opened mid-recording asking whether it should run the mic.
   *
   * It cannot decide for itself: exactly one window may hold the microphone,
   * and two both running `getUserMedia` would interleave two streams into one
   * WAV. Main knows who holds it, so main answers.
   */
  RECORDING_CLAIM_MIC: 'recording:claimMic',

  // Sessions
  SESSION_LIST: 'session:list',
  SESSION_GET: 'session:get',
  SESSION_TRANSCRIPT: 'session:transcript',
  SESSION_NOTES_GET: 'session:notes:get',
  SESSION_NOTES_SET: 'session:notes:set',
  SESSION_DELETE: 'session:delete',
  SESSION_REVEAL: 'session:reveal',
  SESSION_SEARCH: 'session:search',
  /**
   * Drop the search index and re-derive it from the vault.
   *
   * Exposed because the index is derived and therefore disposable — this is
   * what makes that claim testable rather than aspirational. Resolves with the
   * number of sessions indexed.
   */
  SESSION_REINDEX: 'session:reindex',

  // Audio playback — the differentiator: click a transcript line, hear it
  SESSION_AUDIO_URL: 'session:audio:url',
  /** Delete a session's audio, keeping its transcript and notes. */
  SESSION_DISCARD_AUDIO: 'session:audio:discard',

  // Models
  /** The catalogue — static metadata for the picker. */
  MODEL_LIST: 'model:list',
  /** What is actually on disk. Distinct from the catalogue, and it changes. */
  MODEL_STATES: 'model:states',
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
  /**
   * Main asking the renderer to open or close its microphone.
   *
   * The direction is deliberate. `getUserMedia` exists only in the renderer,
   * but recording is owned by main — the tray has to be able to start a
   * meeting with no window open, and a page reload must not end one. So main
   * is the controller and the renderer is a device driver it commands.
   */
  MIC_START: 'evt:mic:start',
  MIC_STOP: 'evt:mic:stop',
  TRANSCRIPTION_PROGRESS: 'evt:transcription:progress',
  /** Partial transcript during a live session (streaming models only). */
  TRANSCRIPTION_PARTIAL: 'evt:transcription:partial',
  MODEL_PROGRESS: 'evt:model:progress',
  SESSION_CHANGED: 'evt:session:changed',
  AI_TOKEN: 'evt:ai:token',
} as const

/** Options for RECORDING_START. Everything is optional; defaults come from Settings. */
export interface StartRecordingOptions {
  /** Overrides the meeting's directory-derived title. */
  title?: string
  /**
   * Delete both WAVs as soon as the transcript exists. Defaults to
   * `Settings.discardAudioByDefault`. Chosen before recording rather than
   * after, because the decision is written into meta.json and has to survive
   * a crash — see SessionMeta.discardAudio.
   */
  discardAudio?: boolean
}

/** What RECORDING_START resolves to once capture is actually running. */
export interface StartRecordingResult {
  sessionId: string
  startedAt: string
}

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
