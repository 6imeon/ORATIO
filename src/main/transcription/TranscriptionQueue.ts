import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { readdir, readFile, writeFile, appendFile } from 'node:fs/promises'
import { join } from 'node:path'
import log from 'electron-log/main'
import type { SessionMeta, Transcript, TranscriptSegment } from '@shared/types'
import type { TranscriptionProgress } from '@shared/ipc'
import type { TranscriptionEngine } from './TranscriptionEngine'
import { isLikelyHallucination } from './vad'

/**
 * Serial queue of sessions awaiting transcription.
 *
 * THE FILESYSTEM IS THE QUEUE. A session directory containing meta.json but
 * no transcript.json is pending, by definition. That means:
 *   - there is no queue state to keep in sync or corrupt
 *   - a crash or force-quit mid-transcription costs nothing; the next launch
 *     rescans and retries
 *   - the user can delete a transcript.json to force a re-run
 *
 * Jobs run one at a time so a new recording can start while the previous one
 * transcribes. A failure is logged into the session's own transcribe.log and
 * never blocks the rest of the queue.
 */
export class TranscriptionQueue extends EventEmitter {
  #queue: string[] = []
  #draining = false
  #engine: TranscriptionEngine | null = null
  #current: string | null = null

  constructor(
    private readonly vaultPath: string,
    private readonly createEngine: () => TranscriptionEngine,
  ) {
    super()
  }

  enqueue(sessionDir: string): void {
    if (this.#queue.includes(sessionDir) || this.#current === sessionDir) return
    this.#queue.push(sessionDir)
    void this.#drain()
  }

  /**
   * Rescan the vault for sessions that finished recording but were never
   * transcribed. Directory names sort chronologically, so oldest-first is
   * a plain name sort.
   */
  async resumePending(): Promise<void> {
    let entries: string[]
    try {
      entries = await readdir(this.vaultPath)
    } catch {
      return
    }

    const pending = entries
      .map((name) => join(this.vaultPath, name))
      .filter(
        (dir) =>
          existsSync(join(dir, 'meta.json')) && !existsSync(join(dir, 'transcript.json')),
      )
      .sort()

    if (pending.length > 0) {
      log.info(`[queue] resuming ${pending.length} untranscribed session(s)`)
      for (const dir of pending) this.enqueue(dir)
    }
  }

  async #drain(): Promise<void> {
    if (this.#draining) return
    this.#draining = true

    while (this.#queue.length > 0) {
      const dir = this.#queue.shift()!
      this.#current = dir
      const sessionId = dir.split('/').pop()!

      try {
        this.#progress({ sessionId, stage: 'transcribing', progress: 0, queued: this.#queue.length })
        await this.#transcribe(dir, sessionId)
        this.#progress({ sessionId, stage: 'done', progress: 1, queued: this.#queue.length })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        log.error(`[queue] ${sessionId} failed:`, message)
        await this.#log(dir, `transcription failed: ${message}`)
        this.#progress({
          sessionId,
          stage: 'failed',
          progress: 0,
          queued: this.#queue.length,
          error: message,
        })
      }
      this.#current = null
    }

    // Free the model weights once idle so a backgrounded app is not holding
    // hundreds of megabytes for nothing.
    if (this.#engine) {
      await this.#engine.release()
      this.#engine = null
    }
    this.#draining = false

    // An enqueue that landed between the loop exiting and release finishing
    // would otherwise sit until the next enqueue.
    if (this.#queue.length > 0) void this.#drain()
  }

  async #transcribe(dir: string, sessionId: string): Promise<void> {
    const meta = JSON.parse(await readFile(join(dir, 'meta.json'), 'utf8')) as SessionMeta

    if (!this.#engine) {
      this.#engine = this.createEngine()
      await this.#engine.prepare()
    }
    const engine = this.#engine

    const merged: TranscriptSegment[] = []

    for (const track of meta.tracks) {
      const wav = join(dir, track.file)
      if (!existsSync(wav)) {
        await this.#log(dir, `skipping missing track ${track.file}`)
        continue
      }

      await this.#log(dir, `transcribing ${track.file} (${engine.modelId})`)

      // One bad track must not cost us the other's transcript.
      let segments
      try {
        segments = await engine.transcribeFile(wav)
      } catch (err) {
        await this.#log(dir, `skipping ${track.file}: ${err}`)
        continue
      }

      const offset = track.startOffsetMs
      for (const seg of segments) {
        if (isLikelyHallucination(seg.text)) continue
        merged.push({
          speaker: track.speaker,
          startMs: Math.round(seg.start * 1000) + offset,
          endMs: Math.round(seg.end * 1000) + offset,
          text: seg.text.trim(),
        })
      }
    }

    // Shift onto one shared clock, then interleave the two speakers.
    merged.sort((a, b) => a.startMs - b.startMs)

    const transcript: Transcript = {
      model: engine.modelId,
      createdAt: new Date().toISOString(),
      segments: merged,
    }

    // Write atomically: resumePending treats the presence of transcript.json
    // as "done", so a half-written file must never exist.
    const tmp = join(dir, 'transcript.json.tmp')
    await writeFile(tmp, JSON.stringify(transcript, null, 2), 'utf8')
    const { rename } = await import('node:fs/promises')
    await rename(tmp, join(dir, 'transcript.json'))

    await this.#log(dir, `done — ${merged.length} segments`)
    this.emit('completed', sessionId)
  }

  async #log(dir: string, message: string): Promise<void> {
    const line = `${new Date().toISOString()} ${message}\n`
    try {
      await appendFile(join(dir, 'transcribe.log'), line, 'utf8')
    } catch {
      /* logging must never throw */
    }
  }

  #progress(p: TranscriptionProgress): void {
    this.emit('progress', p)
  }
}
