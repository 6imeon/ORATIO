import { app, utilityProcess, type UtilityProcess } from 'electron'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import log from 'electron-log/main'
import type { Transcript } from '@shared/types'
import type { SearchHit } from './searchIndex'
import type { IndexWorkerRequest, IndexWorkerResponse } from './worker/protocol'

/**
 * Main-process handle on the index `utilityProcess`.
 *
 * Presents the same surface as `SearchIndex` itself, except every method is
 * async — which is the entire point. better-sqlite3 is synchronous, so calling
 * it in main blocks the thread that draws the tray; behind this client the same
 * query blocks a process nobody is looking at (ARCHITECTURE §5).
 *
 * Spawned once at startup and killed on quit. The ASR worker's one-process-per-
 * job discipline exists because inference leaks and only process exit reclaims
 * it; SQLite has no equivalent problem, and respawning would mean opening the
 * database on every keystroke of an as-you-type search.
 */

/**
 * How long to wait for the child to come up.
 *
 * Shorter than the ASR worker's 15 s: that budget covers loading model weights,
 * while this one only has to open a SQLite file. A worker that has not reported
 * ready in five seconds is a broken build, not a slow one.
 */
const SPAWN_TIMEOUT_MS = 5_000

interface Pending {
  resolve: (res: { hits?: SearchHit[]; ids?: string[]; count?: number }) => void
  reject: (err: Error) => void
}

export interface IndexableSession {
  sessionId: string
  meta: { title: string; startedAt: string; durationSeconds: number }
  transcript: Transcript
}

export class IndexClient {
  #child: UtilityProcess | null = null
  #pending = new Map<number, Pending>()
  #nextId = 1
  /** Set when the child dies, so later calls fail with the real reason. */
  #deadReason: string | null = null
  #closing = false

  constructor(private readonly dbPath: string) {}

  /** OS pid of the worker, or undefined when none is running. */
  get workerPid(): number | undefined {
    return this.#child?.pid
  }

  async start(): Promise<void> {
    await this.#spawn()
    await this.#request({ type: 'open', id: 0, dbPath: this.dbPath })
    log.info('[index] worker ready', { pid: this.workerPid })
  }

  async indexSession(
    sessionId: string,
    meta: IndexableSession['meta'],
    transcript: Transcript,
  ): Promise<void> {
    await this.#request({ type: 'index', id: 0, sessionId, meta, transcript })
  }

  async search(query: string, limit?: number): Promise<SearchHit[]> {
    const res = await this.#request({
      type: 'search',
      id: 0,
      query,
      ...(limit === undefined ? {} : { limit }),
    })
    return res.hits ?? []
  }

  async removeSession(sessionId: string): Promise<void> {
    await this.#request({ type: 'remove', id: 0, sessionId })
  }

  async indexedIds(): Promise<string[]> {
    return (await this.#request({ type: 'indexedIds', id: 0 })).ids ?? []
  }

  /** Drop everything and re-index from the vault. Returns sessions indexed. */
  async rebuild(sessions: IndexableSession[]): Promise<number> {
    const res = await this.#request({ type: 'rebuild', id: 0, sessions })
    return res.count ?? 0
  }

  /**
   * Kill the worker. Safe to call twice, and safe to call while requests are
   * in flight — they reject rather than hanging forever.
   */
  close(): void {
    this.#closing = true
    const child = this.#child
    this.#child = null
    child?.kill()
    this.#fail(new Error('index worker closed'))
  }

  // -- internals ------------------------------------------------------------

  #spawn(): Promise<void> {
    return new Promise((resolve, reject) => {
      // Resolved exactly the way the ASR worker resolves asr.cjs, and for the
      // same two reasons. NOT `__dirname`: rollup hoists code shared between
      // entry points into out/main/chunks/, so __dirname silently becomes
      // .../chunks the moment another entry imports this file. And
      // `app.getAppPath()` is the project root under `electron-vite dev` but
      // `out/main` when the built output is launched directly, so both layouts
      // are tried rather than assuming which one we are in — the phase 4 bug.
      const appPath = app.getAppPath()
      const candidates = [
        join(appPath, 'out', 'main', 'index-worker.cjs'),
        // Already inside out/main — the direct-launch case.
        join(appPath, 'index-worker.cjs'),
      ]
      const entry = candidates.find((p) => existsSync(p))

      if (!entry) {
        reject(new Error(`Index worker binary not found. Looked in: ${candidates.join(', ')}`))
        return
      }

      // `utilityProcess` requires every env value to be a string. Assigning
      // `undefined` to strip a key throws "Invalid value for env", so the key
      // is deleted instead.
      const env: Record<string, string> = {}
      for (const [k, v] of Object.entries(process.env)) {
        if (typeof v === 'string') env[k] = v
      }
      // With this set, `require('electron')` inside the child returns the
      // binary PATH STRING instead of the API, and nothing works.
      delete env['ELECTRON_RUN_AS_NODE']

      const child = utilityProcess.fork(entry, [], {
        serviceName: 'oratio-index',
        // Piped so the child's output lands in our log rather than vanishing —
        // a better-sqlite3 ABI mismatch prints there and nowhere else.
        stdio: 'pipe',
        env,
      })
      this.#child = child

      const timer = setTimeout(() => {
        reject(new Error('Index worker did not start'))
        child.kill()
      }, SPAWN_TIMEOUT_MS)

      // Attached BEFORE the child can report anything, so `exit` cannot beat
      // `message` and swallow the first reply.
      child.on('message', (msg: IndexWorkerResponse) => {
        if (msg.type === 'ready') {
          clearTimeout(timer)
          resolve()
          return
        }
        this.#dispatch(msg)
      })

      child.on('exit', (code) => {
        clearTimeout(timer)
        this.#child = null
        if (this.#closing) return

        // Not fatal, and deliberately not auto-restarted here: the index is
        // derived, so the honest failure mode is that search stops working
        // until the next launch rebuilds it. Silently respawning would hide a
        // crash loop behind a search box that works every other query.
        const reason = `Index worker exited unexpectedly (code ${code})`
        this.#deadReason = reason
        log.error('[index]', reason)
        this.#fail(new Error(reason))
        reject(new Error(reason))
      })

      child.stdout?.on('data', (d: Buffer) => log.info('[index:out]', d.toString().trim()))
      child.stderr?.on('data', (d: Buffer) => log.warn('[index:err]', d.toString().trim()))
    })
  }

  #dispatch(msg: IndexWorkerResponse): void {
    if (msg.type === 'ready') return

    const pending = this.#pending.get(msg.id)
    if (!pending) return
    this.#pending.delete(msg.id)

    if (msg.type === 'ok') {
      pending.resolve({
        ...(msg.hits ? { hits: msg.hits } : {}),
        ...(msg.ids ? { ids: msg.ids } : {}),
        ...(msg.count === undefined ? {} : { count: msg.count }),
      })
    } else {
      pending.reject(new Error(msg.message))
    }
  }

  #request(
    req: IndexWorkerRequest,
  ): Promise<{ hits?: SearchHit[]; ids?: string[]; count?: number }> {
    const child = this.#child
    if (!child) {
      return Promise.reject(new Error(this.#deadReason ?? 'Index worker is not running'))
    }

    const id = this.#nextId++
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject })
      child.postMessage({ ...req, id })
    })
  }

  /** Reject everything still in flight — the worker can no longer answer. */
  #fail(err: Error): void {
    for (const pending of this.#pending.values()) pending.reject(err)
    this.#pending.clear()
  }
}
