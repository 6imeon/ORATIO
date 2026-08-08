import { app, utilityProcess, type UtilityProcess } from 'electron'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import log from 'electron-log/main'
import type { ModelId } from '@shared/types'
import type { TranscriptionEngine, RawSegment } from './TranscriptionEngine'
import type { WorkerRequest, WorkerResponse } from './worker/protocol'

/**
 * Main-process half of the ASR worker.
 *
 * Implements `TranscriptionEngine`, so `TranscriptionQueue` drives ASR without
 * ever learning that a second process — let alone sherpa — is involved.
 *
 * The worker is spawned on `prepare()` and killed on `release()`, which the
 * queue calls once it drains. That is one process per job: the model loads
 * once and is amortised across both tracks, then every byte it allocated goes
 * away with the process. Per ARCHITECTURE §1.3, process exit is the only
 * reliable deallocator for this stack, which is what makes whisper.cpp-style
 * per-call leaks harmless rather than cumulative.
 */

/**
 * How long to wait for the child to come up before giving up.
 *
 * A worker that never reports ready means a broken native module or a bad
 * build path — both of which otherwise present as an app that hangs forever on
 * "transcribing", the exact failure ARCHITECTURE §4.4 says to never ship.
 */
const SPAWN_TIMEOUT_MS = 15_000

interface Pending {
  resolve: (segments: RawSegment[]) => void
  reject: (err: Error) => void
}

export class WorkerEngine implements TranscriptionEngine {
  readonly modelId: ModelId
  readonly streaming = false

  #child: UtilityProcess | null = null
  #pending = new Map<number, Pending>()
  #nextId = 1
  /** Set when the child dies, so later calls fail with the real reason. */
  #deadReason: string | null = null

  constructor(
    modelId: ModelId,
    private readonly files: Record<string, string>,
    private readonly vadModelPath: string,
    private readonly vadEnabled: boolean,
    private readonly onProgress?: (fraction: number) => void,
  ) {
    this.modelId = modelId
  }

  /**
   * OS pid of the worker, or undefined when none is running.
   *
   * Exposed because "is the worker actually gone?" is not answerable from the
   * outside — `serviceName` is a label, not a process name, so it cannot be
   * found with pgrep. Worth having when a job appears stuck.
   */
  get workerPid(): number | undefined {
    return this.#child?.pid
  }

  async prepare(): Promise<void> {
    await this.#spawn()
    await this.#request({
      type: 'load',
      id: 0, // replaced by #request
      modelId: this.modelId,
      files: this.files,
      vadModelPath: this.vadModelPath,
      vadEnabled: this.vadEnabled,
    })
    log.info('[asr] model loaded', this.modelId)
  }

  async transcribeFile(wavPath: string): Promise<RawSegment[]> {
    return this.#request({ type: 'transcribe', id: 0, wavPath })
  }

  async release(): Promise<void> {
    const child = this.#child
    if (!child) return

    // Ask politely so sherpa can drop its handles, but do not let a wedged
    // child hold up shutdown — kill() is what actually frees the memory.
    await this.#request({ type: 'release', id: 0 }).catch(() => {})

    this.#child = null
    child.kill()
    this.#fail(new Error('engine released'))
    log.info('[asr] worker released', this.modelId)
  }

  // -- internals ------------------------------------------------------------

  #spawn(): Promise<void> {
    return new Promise((resolve, reject) => {
      // Built as a separate rollup entry alongside index.cjs.
      //
      // NOT resolved from `__dirname`: rollup hoists code shared between
      // entry points into out/main/chunks/, so the moment a second entry
      // imports this file, __dirname silently becomes .../chunks and the fork
      // fails with ERR_MODULE_NOT_FOUND. That makes __dirname a hidden
      // dependency on how rollup happened to chunk the build.
      //
      // `app.getAppPath()` is the project root in dev and the asar root when
      // packaged, so out/main/asr.cjs is correct in both.
      const entry = join(app.getAppPath(), 'out', 'main', 'asr.cjs')

      // A missing worker is a build error, and it must not present as the
      // spawn timeout below — "did not start" would send someone hunting a
      // native-module problem that does not exist.
      if (!existsSync(entry)) {
        reject(new Error(`ASR worker binary missing at ${entry}`))
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
        serviceName: 'oratio-asr',
        // Piped so the child's stdout/stderr land in our log rather than
        // vanishing — native-module load failures print there and nowhere else.
        stdio: 'pipe',
        env,
      })
      this.#child = child

      const timer = setTimeout(() => {
        reject(new Error('ASR worker did not start'))
        child.kill()
      }, SPAWN_TIMEOUT_MS)

      // Attached BEFORE the child can report anything. Driving the first send
      // from `spawn` rather than immediately is the documented ordering trap:
      // otherwise `exit` can beat `message` and the first reply is lost.
      child.on('message', (msg: WorkerResponse) => {
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
        // Only meaningful if we did not ask for it; release() clears #child
        // first, so reaching here means the worker died on its own.
        const reason = `ASR worker exited unexpectedly (code ${code})`
        this.#deadReason = reason
        this.#fail(new Error(reason))
        reject(new Error(reason))
      })

      child.stdout?.on('data', (d: Buffer) => log.info('[asr:out]', d.toString().trim()))
      child.stderr?.on('data', (d: Buffer) => log.warn('[asr:err]', d.toString().trim()))
    })
  }

  #dispatch(msg: WorkerResponse): void {
    if (msg.type === 'progress') {
      this.onProgress?.(msg.progress)
      return
    }
    if (msg.type === 'ready') return

    const pending = this.#pending.get(msg.id)
    if (!pending) return
    this.#pending.delete(msg.id)

    if (msg.type === 'ok') pending.resolve(msg.segments ?? [])
    else pending.reject(new Error(msg.message))
  }

  #request(req: WorkerRequest): Promise<RawSegment[]> {
    const child = this.#child
    if (!child) {
      return Promise.reject(new Error(this.#deadReason ?? 'ASR worker is not running'))
    }

    const id = this.#nextId++
    return new Promise<RawSegment[]>((resolve, reject) => {
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
