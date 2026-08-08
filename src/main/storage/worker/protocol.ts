import type { Transcript } from '@shared/types'
import type { SearchHit } from '../searchIndex'

/**
 * Wire protocol between main and the index `utilityProcess`.
 *
 * Same request/response shape as the ASR worker's protocol, and for the same
 * reason: replies do not arrive in the order requests were sent — a rebuild
 * takes seconds while a query takes microseconds — so every message carries an
 * explicit `id` rather than being matched by arrival order.
 *
 * Unlike the ASR worker this process is LONG-LIVED. It is spawned once at
 * startup and killed on quit, because there is nothing to reclaim: SQLite's
 * memory is bounded by its page cache, not by job size, so the "process exit
 * is the only reliable deallocator" argument that governs ASR does not apply.
 *
 * Everything here crosses a process boundary via structured clone, so it must
 * stay plain data — no class instances, no functions.
 */

/** Open the database. Sent once, immediately after `ready`. */
export interface OpenRequest {
  type: 'open'
  id: number
  dbPath: string
}

export interface IndexRequest {
  type: 'index'
  id: number
  sessionId: string
  meta: { title: string; startedAt: string; durationSeconds: number }
  transcript: Transcript
}

export interface SearchRequest {
  type: 'search'
  id: number
  query: string
  limit?: number
}

export interface RemoveRequest {
  type: 'remove'
  id: number
  sessionId: string
}

/**
 * Drop every row and re-index from the sessions supplied by main.
 *
 * Main does the vault scan rather than the worker: reading the vault is the
 * one thing that must never diverge between the two, and `listSessions` plus
 * `readTranscript` already live in main. The worker owns the database and
 * nothing else.
 */
export interface RebuildRequest {
  type: 'rebuild'
  id: number
  sessions: Array<{
    sessionId: string
    meta: { title: string; startedAt: string; durationSeconds: number }
    transcript: Transcript
  }>
}

/** Which sessions the index already knows about, for an incremental catch-up. */
export interface IndexedIdsRequest {
  type: 'indexedIds'
  id: number
}

export type IndexWorkerRequest =
  | OpenRequest
  | IndexRequest
  | SearchRequest
  | RemoveRequest
  | RebuildRequest
  | IndexedIdsRequest

/** Sent once at startup so the host knows the child is alive and listening. */
export interface ReadyMessage {
  type: 'ready'
}

export interface OkResponse {
  type: 'ok'
  id: number
  /** Present for `search`. */
  hits?: SearchHit[]
  /** Present for `indexedIds`. */
  ids?: string[]
  /** Present for `rebuild` — how many sessions actually landed. */
  count?: number
}

export interface ErrResponse {
  type: 'err'
  id: number
  message: string
}

export type IndexWorkerResponse = ReadyMessage | OkResponse | ErrResponse
