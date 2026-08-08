import type { ModelId } from '@shared/types'
import type { RawSegment } from '../TranscriptionEngine'

/**
 * The wire protocol between the main process and the ASR `utilityProcess`.
 *
 * Deliberately request/response with an explicit `id` on every message rather
 * than a bare event stream: `load` takes seconds and `transcribe` can take
 * minutes, so replies do not arrive in the order requests were sent, and
 * matching them by arrival order would silently pair the wrong reply with the
 * wrong request.
 *
 * Everything here crosses a process boundary via structured clone, so it must
 * stay plain data — no class instances, no functions.
 */

export interface LoadRequest {
  type: 'load'
  id: number
  modelId: ModelId
  /** Absolute paths from ModelManager.resolve(), keyed by manifest filename. */
  files: Record<string, string>
  vadModelPath: string
  /** When false, audio goes straight to ASR. Off is a footgun; see vad.ts. */
  vadEnabled: boolean
}

export interface TranscribeRequest {
  type: 'transcribe'
  id: number
  wavPath: string
}

export interface ReleaseRequest {
  type: 'release'
  id: number
}

export type WorkerRequest = LoadRequest | TranscribeRequest | ReleaseRequest

/** Sent once at startup so the host knows the child is alive and listening. */
export interface ReadyMessage {
  type: 'ready'
}

export interface OkResponse {
  type: 'ok'
  id: number
  segments?: RawSegment[]
}

export interface ErrResponse {
  type: 'err'
  id: number
  message: string
}

/**
 * Progress during a long transcription, so the UI is not frozen for minutes.
 * Unsolicited — it carries the request id but expects no reply.
 */
export interface ProgressMessage {
  type: 'progress'
  id: number
  /** 0..1 through the current file. */
  progress: number
}

export type WorkerResponse = ReadyMessage | OkResponse | ErrResponse | ProgressMessage
