import { createWriteStream } from 'node:fs'
import { mkdir, rm, rename, stat, open, readdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { createHash } from 'node:crypto'
import { pipeline } from 'node:stream/promises'
import { Readable, Transform } from 'node:stream'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { statfs } from 'node:fs'
import { app } from 'electron'
import log from 'electron-log/main'
import type { ModelId, ModelState } from '@shared/types'
import { MODELS, MODEL_DOWNLOADS, VAD_MODEL, type ModelDownload } from '@shared/models'

const execFileAsync = promisify(execFile)
const statfsAsync = promisify(statfs)

/**
 * Model download, verification, and installation.
 *
 * This is deliberately the first thing built. Across Vibe and Meetily,
 * "failed to load model" outnumbers accuracy complaints (ARCHITECTURE §4.4) —
 * it is the top user-visible defect class in this category, and it is the
 * first thing a new user touches. Almost all of it traces to three things
 * this class refuses to do:
 *
 *   1. treat a directory that exists as a model that works,
 *   2. start a 636 MB download without checking there is room for it,
 *   3. leave a partial file behind when something fails.
 *
 * The invariant: `<models>/<id>/` exists ONLY when every file the engine
 * needs is present and verified. Everything else happens in a sibling temp
 * directory and is renamed in atomically, so an interrupted install is
 * indistinguishable from one that never started.
 */

export type ProgressFn = (state: ModelState) => void

/**
 * Progress events are throttled to ~10/s.
 *
 * Every async IPC message costs roughly 1 ms of main-process time (UI.md §0),
 * and chunk callbacks fire far faster than a human can read. At 10/s the bar
 * still looks smooth and the cost is negligible.
 */
const PROGRESS_INTERVAL_MS = 100

/** Free space to leave spare, so we never fill a user's disk to zero. */
const DISK_HEADROOM_BYTES = 500_000_000

export class ModelManager {
  private readonly root: string
  /** In-flight downloads, so a second request can cancel the first. */
  private readonly active = new Map<ModelId, AbortController>()

  constructor(root = join(app.getPath('userData'), 'models')) {
    this.root = root
  }

  /** Where a finished model lives. Present ⇒ verified. */
  modelDir(id: ModelId): string {
    return join(this.root, id)
  }

  /**
   * Absolute paths the ASR engine needs, or null when the model is not
   * installed. Phase 2 builds its sherpa config from this rather than
   * rebuilding filenames itself.
   */
  async resolve(id: ModelId): Promise<Record<string, string> | null> {
    if (!(await this.isInstalled(id))) return null
    const dir = this.modelDir(id)
    const files: Record<string, string> = {}
    for (const name of MODEL_DOWNLOADS[id].required) files[name] = join(dir, name)
    return files
  }

  /**
   * Absolute path to the Silero VAD weights, downloading them if absent.
   *
   * VAD is not optional (see transcription/vad.ts), so this is a hard
   * prerequisite of every ASR job rather than a model in its own right. It is
   * 644 KB and shipped as a bare .onnx, so there is no extraction step — but
   * it still gets the same verify-then-atomic-rename treatment, because a
   * truncated VAD model fails inside sherpa exactly as unhelpfully as a
   * truncated ASR one.
   *
   * Never bundled: the same first-run-download rule applies as to the models.
   */
  async ensureVad(): Promise<string> {
    const dest = join(this.root, VAD_MODEL.fileName)

    const existing = await stat(dest).catch(() => null)
    if (existing?.isFile() && existing.size === VAD_MODEL.sizeBytes) return dest

    log.info('[models] fetching Silero VAD')
    await mkdir(this.root, { recursive: true })
    const tmp = join(this.root, `.tmp-${VAD_MODEL.fileName}`)

    try {
      const res = await fetch(VAD_MODEL.url)
      if (!res.ok || !res.body) {
        throw new Error(`VAD download failed: ${res.status} ${res.statusText}`)
      }
      await pipeline(Readable.fromWeb(res.body as never), createWriteStream(tmp))
      await this.verify(tmp, VAD_MODEL.sha256)
      await rename(tmp, dest)
    } finally {
      await rm(tmp, { force: true }).catch(() => {})
    }

    return dest
  }

  /**
   * True only when EVERY required file exists and is non-empty.
   *
   * The directory's existence is not evidence: extraction can be interrupted
   * halfway, and a zero-byte .onnx passes any existence check while failing
   * deep inside sherpa with an error the user cannot act on. Checking the
   * manifest is what turns that into "not downloaded", which is recoverable.
   */
  async isInstalled(id: ModelId): Promise<boolean> {
    const dir = this.modelDir(id)
    for (const name of MODEL_DOWNLOADS[id].required) {
      try {
        const s = await stat(join(dir, name))
        if (!s.isFile() || s.size === 0) return false
      } catch {
        return false
      }
    }
    return true
  }

  async list(): Promise<ModelState[]> {
    return Promise.all(
      (Object.keys(MODELS) as ModelId[]).map(async (id) => ({
        id,
        status: this.active.has(id)
          ? ('downloading' as const)
          : (await this.isInstalled(id))
            ? ('ready' as const)
            : ('not-downloaded' as const),
        progress: 0,
      })),
    )
  }

  cancel(id: ModelId): void {
    this.active.get(id)?.abort()
  }

  async remove(id: ModelId): Promise<void> {
    this.cancel(id)
    await rm(this.modelDir(id), { recursive: true, force: true })
    log.info('[models] removed', id)
  }

  /**
   * Download, verify, extract, and install.
   *
   * Resolves when the model is usable. Every failure path — including cancel
   * — leaves the filesystem as it was found.
   */
  async download(id: ModelId, onProgress: ProgressFn): Promise<void> {
    if (await this.isInstalled(id)) {
      onProgress({ id, status: 'ready', progress: 1 })
      return
    }
    if (this.active.has(id)) throw new Error(`${id} is already downloading`)

    const spec = MODEL_DOWNLOADS[id]
    const controller = new AbortController()
    this.active.set(id, controller)

    // Work in a sibling of the final directory: same filesystem, so the
    // final rename is atomic rather than a copy across devices.
    const tmpDir = join(this.root, `.tmp-${id}`)
    const archive = join(tmpDir, 'model.tar.bz2')

    try {
      await mkdir(tmpDir, { recursive: true })
      await this.assertDiskSpace(spec)

      await this.fetchResumable(spec, archive, controller.signal, (received, total) => {
        // Download is ~90% of the wait; extraction gets the last tenth so the
        // bar keeps moving through a step that can take several seconds.
        onProgress({ id, status: 'downloading', progress: (received / total) * 0.9 })
      })

      onProgress({ id, status: 'downloading', progress: 0.92 })
      await this.verify(archive, spec.sha256)

      onProgress({ id, status: 'downloading', progress: 0.95 })
      await this.extract(archive, tmpDir)

      const unpacked = join(tmpDir, spec.dirName)
      await this.assertComplete(unpacked, spec)
      await this.prune(unpacked, spec)

      // Only now does the model become visible under its real name. Up to
      // this point a crash leaves only a .tmp- directory, which the next
      // launch sweeps away.
      await rm(this.modelDir(id), { recursive: true, force: true })
      await rename(unpacked, this.modelDir(id))

      onProgress({ id, status: 'ready', progress: 1 })
      log.info('[models] installed', id)
    } catch (err) {
      const cancelled = controller.signal.aborted
      const message = err instanceof Error ? err.message : String(err)

      onProgress({
        id,
        status: cancelled ? 'not-downloaded' : 'failed',
        progress: 0,
        // A real message, never a silent stall. "Not enough disk space" is
        // something the user can act on; a spinner that never finishes is not.
        error: cancelled ? undefined : message,
      })

      if (!cancelled) log.error('[models] download failed', id, err)
      throw err
    } finally {
      this.active.delete(id)
      // Partial archives and half-extracted trees never survive. Leaving one
      // behind is how a broken model comes to read as installed.
      await rm(tmpDir, { recursive: true, force: true }).catch(() => {})
    }
  }

  /** Clear temp directories orphaned by a crash. Called once at startup. */
  async sweep(): Promise<void> {
    try {
      const entries = await readdir(this.root)
      await Promise.all(
        entries
          .filter((name) => name.startsWith('.tmp-'))
          .map((name) => rm(join(this.root, name), { recursive: true, force: true })),
      )
    } catch {
      /* models dir may not exist yet — nothing to sweep */
    }
  }

  // -- internals ------------------------------------------------------------

  /**
   * Refuse to start when the disk cannot hold the install.
   *
   * The budget is the tarball plus everything it unpacks to, because both
   * exist at once before pruning — for whisper-small.en that is 1.9 GB, three
   * times the 636 MB the picker advertises. Checking against the download
   * size would let the install die mid-extract with a cryptic ENOSPC.
   */
  private async assertDiskSpace(spec: ModelDownload): Promise<void> {
    let free: number
    try {
      // statfs throws ENOENT on a path that does not exist yet, and on first
      // run the models directory is exactly that — so querying `this.root`
      // directly fails precisely when the check matters most, and a swallowed
      // error would let an impossible download start anyway. Free space is a
      // property of the filesystem, so walk up to something that exists.
      const fs = await statfsAsync(await nearestExistingDir(this.root))
      free = fs.bavail * fs.bsize
    } catch (err) {
      // The check itself failing must not block a download that might be
      // fine. A genuine shortfall is reported below, outside this catch.
      log.warn('[models] could not check disk space', err)
      return
    }

    const needed = spec.installPeakBytes + DISK_HEADROOM_BYTES
    if (free < needed) {
      throw new Error(`Not enough disk space: ${gb(needed)} needed, ${gb(free)} free`)
    }
  }

  /**
   * Download with resume.
   *
   * A 636 MB download on a laptop will be interrupted — sleep, wifi change,
   * tunnel — so a partial file is resumed with a Range request rather than
   * restarted.
   *
   * Two details this gets wrong if written naively:
   *
   *   - GitHub 302s to a *signed* asset URL that expires in about an hour, so
   *     resume must re-request the original URL. Reusing the redirect target
   *     after a long pause 403s.
   *   - A server that ignores Range answers 200 with the whole file, not 206.
   *     Appending that to what we already have produces a corrupt archive that
   *     only surfaces as a checksum failure, so the offset resets on 200.
   */
  private async fetchResumable(
    spec: ModelDownload,
    dest: string,
    signal: AbortSignal,
    onBytes: (received: number, total: number) => void,
  ): Promise<void> {
    let offset = 0
    try {
      offset = (await stat(dest)).size
    } catch {
      /* no partial file — start from zero */
    }

    const res = await fetch(spec.url, {
      signal,
      headers: offset > 0 ? { Range: `bytes=${offset}-` } : {},
    })

    if (!res.ok || !res.body) {
      throw new Error(`Download failed: ${res.status} ${res.statusText}`)
    }

    // 206 means our Range was honoured; anything else means we are receiving
    // the file from the beginning and must not append.
    let append = res.status === 206
    if (!append) offset = 0

    const remaining = Number(res.headers.get('content-length') ?? 0)
    const total = offset + remaining

    const out = createWriteStream(dest, append ? { flags: 'a' } : { flags: 'w' })

    let received = offset
    let lastEmit = 0
    const counter = new TransformStreamCounter((n) => {
      received += n
      const now = Date.now()
      if (now - lastEmit >= PROGRESS_INTERVAL_MS) {
        lastEmit = now
        if (total > 0) onBytes(received, total)
      }
    })

    await pipeline(Readable.fromWeb(res.body as never), counter, out, { signal })
    if (total > 0) onBytes(total, total)
  }

  /**
   * Verify the tarball against its pinned digest before extracting.
   *
   * Corrupt weights do not fail cleanly: they fail deep inside sherpa with a
   * message that points at the model file and tells the user nothing they can
   * act on. Checking here converts that into "the download was corrupted",
   * which retries successfully. Hashed in a stream so a 636 MB file never
   * lands in memory.
   */
  private async verify(archive: string, expected: string): Promise<void> {
    const hash = createHash('sha256')
    const fh = await open(archive, 'r')
    try {
      await pipeline(fh.createReadStream(), hash)
    } finally {
      await fh.close()
    }

    const actual = hash.digest('hex')
    if (actual !== expected) {
      throw new Error('Downloaded file is corrupted or has changed upstream')
    }
  }

  /**
   * Extract with the system `tar`.
   *
   * bsdtar on macOS reads .tar.bz2 natively, so this needs no npm dependency
   * — which matters for a supply-chain-conscious project: an archive library
   * is exactly the kind of transitive dependency worth not having.
   */
  private async extract(archive: string, into: string): Promise<void> {
    await execFileAsync('/usr/bin/tar', ['-xjf', archive, '-C', into], {
      maxBuffer: 1024 * 1024,
    })
  }

  /** Every declared file must have landed, non-empty, before we rename in. */
  private async assertComplete(dir: string, spec: ModelDownload): Promise<void> {
    for (const name of spec.required) {
      const s = await stat(join(dir, name)).catch(() => null)
      if (!s?.isFile() || s.size === 0) {
        throw new Error(`Model archive is missing ${name}`)
      }
    }
  }

  /**
   * Drop what we will never load.
   *
   * The Whisper tarballs ship full-precision weights alongside int8 ones and
   * we only ever load int8, so keeping them costs 924 MB on whisper-small.en
   * for no benefit. Failure here is not fatal: a model with extra files still
   * works, it just takes more room than it should.
   */
  private async prune(dir: string, spec: ModelDownload): Promise<void> {
    await Promise.all(
      spec.prune.map((name) =>
        rm(join(dir, name), { recursive: true, force: true }).catch((err: unknown) =>
          log.warn('[models] could not prune', name, err),
        ),
      ),
    )
  }
}

function gb(bytes: number): string {
  return `${(bytes / 1_000_000_000).toFixed(1)} GB`
}

/**
 * Walk up until a directory that actually exists.
 *
 * userData/models does not exist before the first download, and free space is
 * a property of the filesystem rather than of any one directory, so its parent
 * answers the same question.
 */
async function nearestExistingDir(path: string): Promise<string> {
  let dir = path
  for (;;) {
    try {
      await stat(dir)
      return dir
    } catch {
      const parent = dirname(dir)
      // dirname('/') === '/', so this terminates at the root either way.
      if (parent === dir) return dir
      dir = parent
    }
  }
}

/**
 * Counts bytes passing through without buffering them.
 *
 * A plain `for await` over the body would work, but this keeps the download
 * inside `pipeline()`, which is what propagates backpressure and abort to the
 * file stream. Without it, aborting mid-download can leave a dangling handle.
 */
class TransformStreamCounter extends Transform {
  constructor(private readonly onChunk: (n: number) => void) {
    super()
  }
  override _transform(
    chunk: Buffer,
    _enc: BufferEncoding,
    cb: (err?: Error | null, data?: Buffer) => void,
  ): void {
    this.onChunk(chunk.length)
    cb(null, chunk)
  }
}
