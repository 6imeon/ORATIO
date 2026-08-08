/**
 * Types shared between the main and renderer processes.
 *
 * Anything crossing the IPC boundary must be structured-cloneable — no
 * class instances, no functions, no Date objects (use ISO strings).
 */

/** Which track a segment came from. Derived from the source file, never guessed. */
export type Speaker = 'me' | 'them'

/** One utterance in the transcript. Times are ms from session start. */
export interface TranscriptSegment {
  speaker: Speaker
  startMs: number
  endMs: number
  text: string
  /** Present only when diarization has split the `them` track. */
  speakerLabel?: string
}

export interface Transcript {
  model: string
  createdAt: string
  segments: TranscriptSegment[]
}

/** One audio track on disk. */
export interface TrackMeta {
  file: string
  speaker: Speaker
  /**
   * Milliseconds this track's first buffer lagged the earliest track's.
   * The two recorders never start on the same instant; without this the
   * merged transcript drifts.
   */
  startOffsetMs: number
}

/** meta.json — written on clean stop. Its presence marks a session complete. */
export interface SessionMeta {
  id: string
  title: string
  startedAt: string
  endedAt: string
  durationSeconds: number
  tracks: TrackMeta[]
  /**
   * Delete the audio once a transcript exists — chosen per session, before
   * recording starts, for a meeting the user does not want a verbatim copy of.
   *
   * Lives in meta.json rather than in Settings on purpose. The decision has to
   * survive a crash between recording and transcription, and the filesystem is
   * the queue: a session that is resumed on next launch must carry its own
   * instruction with it, because there is nowhere else the queue looks.
   *
   * Absent means keep, so every session recorded before this existed keeps its
   * audio.
   */
  discardAudio?: boolean
  /**
   * Set once the audio has actually been deleted, so the UI can distinguish
   * "no audio because you asked" from "no audio because something broke" —
   * and so click-to-play can explain itself rather than silently failing.
   */
  audioDiscardedAt?: string
}

export type SessionStatus =
  | 'recording'
  | 'pending' // has meta.json, no transcript.json yet
  | 'transcribing'
  | 'ready'
  | 'failed'

export interface Session {
  id: string
  dir: string
  title: string
  startedAt: string
  durationSeconds: number
  status: SessionStatus
  hasNotes: boolean
  /**
   * Whether the audio is still on disk. Drives click-to-play: a session whose
   * audio was discarded must say so rather than offering a play button that
   * does nothing.
   */
  hasAudio: boolean
  /** ISO timestamp, present only when the audio was deliberately discarded. */
  audioDiscardedAt?: string
}

// ---------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------

export interface RecordingState {
  active: boolean
  sessionId: string | null
  startedAt: string | null
  elapsedSeconds: number
  /**
   * Peak amplitude of the last mic buffer, 0..1. Drives the level meter and
   * lets the UI surface a dead microphone before the meeting is over.
   */
  micLevel: number
  systemLevel: number
}

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

export type ModelId =
  | 'whisper-base-en'
  | 'moonshine-base-en'
  | 'whisper-small-en'
  | 'parakeet-tdt-v2'

export interface ModelInfo {
  id: ModelId
  label: string
  /** Shown in the picker so the download cost is visible before committing. */
  sizeBytes: number
  description: string
  streaming: boolean
  recommended?: boolean
}

export type ModelStatus = 'not-downloaded' | 'downloading' | 'ready' | 'failed'

export interface ModelState {
  id: ModelId
  status: ModelStatus
  /** 0..1, only meaningful while downloading. */
  progress: number
  error?: string
}

// ---------------------------------------------------------------------------
// AI providers (summaries only — transcription is always local)
// ---------------------------------------------------------------------------

export type ProviderId = 'ollama' | 'anthropic' | 'openai'

export interface ProviderConfig {
  id: ProviderId
  enabled: boolean
  model: string
  /** Ollama only. Cloud providers read their key from the Keychain. */
  baseUrl?: string
  /** Never populated when sending to the renderer — presence only. */
  hasApiKey?: boolean
}

export interface Settings {
  /** Absolute path to the user's vault. All recordings live here. */
  vaultPath: string
  activeModel: ModelId
  /** Skip non-speech before ASR. Off means Whisper hallucinates on silence. */
  vadEnabled: boolean
  /**
   * Default for a new session's `discardAudio`. Off — audio is kept, which is
   * what makes click-a-line-to-hear-it possible and what lets a garbled name
   * be recovered from the source. The per-session toggle overrides it either
   * way, so someone who mostly records sensitive meetings can flip the
   * default rather than remembering each time.
   */
  discardAudioByDefault: boolean
  launchAtLogin: boolean
  providers: ProviderConfig[]
  activeProvider: ProviderId | null
}
