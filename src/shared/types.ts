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

/**
 * One search result.
 *
 * Deliberately small: a session id, where in it the match was, and a bounded
 * snippet FTS5 built around the hit — never the segment's full text and never
 * the transcript. A query that matches a two-hour meeting must cost a few
 * hundred bytes, not the megabyte its transcript.json occupies (UI.md §0). The
 * renderer fetches the transcript separately once the user picks a result.
 */
export interface SearchHit {
  sessionId: string
  title: string
  startedAt: string
  /** Ms offset of the matching line, so the UI can jump straight to the audio. */
  startMs: number
  speaker: string
  /** Match wrapped in <mark>, ellipsised. Built by FTS5, not by us. */
  snippet: string
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
  /**
   * This meta.json was reconstructed at startup from the audio on disk,
   * because the app died mid-recording and never wrote one.
   *
   * Worth recording because such a session is measurably weaker than a normal
   * one: it may be missing its final seconds, and its per-track offsets are
   * assumed to be zero rather than measured. Anything that presents timings to
   * the user should be able to say so.
   */
  recovered?: boolean
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

export type ProviderId = 'ollama' | 'anthropic' | 'openai' | 'openrouter'

/**
 * Providers that authenticate with an API key held in the Keychain.
 *
 * Derived from `ProviderId` rather than written out again, so adding a
 * provider cannot leave one call site accepting it and another rejecting it —
 * which is what a hand-maintained `'anthropic' | 'openai'` union in the IPC
 * layer and the preload bridge had already started to do.
 */
export type KeyedProviderId = Exclude<ProviderId, 'ollama'>

export interface ProviderConfig {
  id: ProviderId
  enabled: boolean
  /**
   * For OpenRouter this is a fully-qualified `vendor/model` slug
   * (`anthropic/claude-sonnet-5`), not a bare name — that is how its API
   * addresses models, and a bare name is rejected.
   */
  model: string
  /**
   * Where to reach the provider. Ollama uses it for the local daemon;
   * OpenRouter uses it because its endpoint is OpenAI-compatible and only the
   * host differs. Anthropic and OpenAI ignore it and use their SDK defaults.
   */
  baseUrl?: string
  /** Never populated when sending to the renderer — presence only. */
  hasApiKey?: boolean
}

/**
 * Appearance. Three values, not two.
 *
 * "system" is the default and follows macOS, which is what almost everyone
 * wants; the two explicit values exist because following the OS is not always
 * what someone wants — a light-mode Mac used for a meeting in a dark room being
 * the obvious case. Stored rather than derived, so the choice survives a
 * restart, and applied to `data-theme` on the root element, which is the hook
 * styles.css is already written against.
 */
export type ThemePreference = 'system' | 'light' | 'dark'

export interface Settings {
  /** Absolute path to the user's vault. All recordings live here. */
  vaultPath: string
  activeModel: ModelId
  theme: ThemePreference
  /** Skip non-speech before ASR. Off means Whisper hallucinates on silence. */
  vadEnabled: boolean
  /**
   * Drop the other side's voice back out of the mic track.
   *
   * Only matters when recording through speakers: the mic hears the meeting
   * audio from the room and the transcript attributes it to you. A setting
   * rather than always-on because it is the one feature here that can remove
   * something the user said — headphone users get no benefit and carry the
   * (small) risk for nothing, so they can turn it off.
   */
  removeSpeakerBleed: boolean
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
