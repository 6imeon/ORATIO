import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { readdir, readFile, writeFile, appendFile } from 'node:fs/promises'
import { join } from 'node:path'
import log from 'electron-log/main'
import type { SessionMeta, Transcript, TranscriptSegment } from '@shared/types'
import type { TranscriptionProgress } from '@shared/ipc'
import type { TranscriptionEngine } from './TranscriptionEngine'
import { isLikelyHallucination } from './vad'
import { removeSpeakerBleed } from './bleed'
import { measureTrackGains, readWav } from '../audio/readWav'
import {
  discardSessionAudio,
  hasAudio,
  readCorrections,
  readMeta,
  writeCorrections,
} from '../storage/vault'
import { reapplyCorrections } from '@shared/corrections'
import { loadSettings } from '../storage/settings'

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
    /**
     * Async because building an engine means resolving model paths on disk —
     * and because "the model is not downloaded" has to surface as a normal
     * job failure written to transcribe.log, not an exception at startup.
     */
    private readonly createEngine: () => Promise<TranscriptionEngine>,
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

    const dirs = entries.map((name) => join(this.vaultPath, name)).sort()

    const pending = dirs.filter(
      (dir) => existsSync(join(dir, 'meta.json')) && !existsSync(join(dir, 'transcript.json')),
    )

    if (pending.length > 0) {
      log.info(`[queue] resuming ${pending.length} untranscribed session(s)`)
      for (const dir of pending) this.enqueue(dir)
    }

    // Finish any audio deletion that was promised but not completed.
    //
    // Without this the guarantee has a permanent hole: a crash between writing
    // transcript.json and unlinking the WAVs leaves a session that
    // resumePending will never look at again — it has a transcript, so it is
    // done — and the audio the user asked us to discard stays on disk forever.
    // Cheap to re-check, and it is the only place that hole can be closed.
    await this.#sweepDiscarded(dirs)
  }

  async #sweepDiscarded(dirs: string[]): Promise<void> {
    for (const dir of dirs) {
      if (!existsSync(join(dir, 'transcript.json')) || !hasAudio(dir)) continue

      const meta = await readMeta(dir)
      if (!meta?.discardAudio) continue

      try {
        await discardSessionAudio(dir)
        log.info(`[queue] discarded leftover audio for ${meta.id}`)
        await this.#log(dir, 'audio discarded on relaunch (interrupted earlier)')
      } catch (err) {
        log.warn(`[queue] could not discard audio for ${meta.id}`, err)
      }
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

  /**
   * Strip the other side's voice back out of the mic track.
   *
   * With speakers rather than headphones the mic hears the meeting audio from
   * the room, ASR transcribes it, and the user is recorded saying what the
   * other person said. See `bleed.ts` for why this is detection rather than
   * echo cancellation — briefly: our two capture paths have independent
   * clocks, which makes an adaptive filter unable to converge, and a
   * mis-converged AEC would eat the user's real speech.
   *
   * Failure here degrades to the unfiltered transcript rather than losing it.
   * A missing or unreadable WAV is completely normal — `discardAudio` deletes
   * both tracks as soon as the transcript exists — and a session recorded with
   * no mic has nothing to filter in the first place.
   */
  async #removeBleed(
    dir: string,
    meta: SessionMeta,
    segments: TranscriptSegment[],
  ): Promise<TranscriptSegment[]> {
    if (!(await loadSettings()).removeSpeakerBleed) return segments

    const micTrack = meta.tracks.find((t) => t.speaker === 'me')
    const systemTrack = meta.tracks.find((t) => t.speaker === 'them')
    if (!micTrack || !systemTrack) return segments

    const micPath = join(dir, micTrack.file)
    const systemPath = join(dir, systemTrack.file)
    if (!existsSync(micPath) || !existsSync(systemPath)) return segments

    try {
      const [mic, system] = await Promise.all([readWav(micPath), readWav(systemPath)])

      /**
       * Ask whether this recording has a near-end speaker at all before
       * deciding anything about individual segments.
       *
       * Both WAVs start at the session anchor, so the two envelopes address the
       * same instants and "the far end is silent here" is a meaningful question
       * to ask of them. See `measureTrackGains` for why the answer cannot be
       * derived per segment.
       */
      const gains = measureTrackGains(mic, system)
      const result = removeSpeakerBleed(segments, gains.micRelativeDb)

      // Logged even when nothing is removed: this is the number that explains a
      // wrong verdict in either direction, and it is unrecoverable once
      // `discardAudio` deletes the tracks.
      await this.#log(
        dir,
        `bleed check: mic reaches ${result.nearEndDb.toFixed(1)} dB relative to system ` +
          `during far-end pauses (${(gains.soloFraction * 100).toFixed(0)}% of the track ` +
          `measurable) — ${result.nearEndPresent ? 'near-end speaker present' : 'no near-end speaker'}`,
      )

      if (result.removed > 0) {
        await this.#log(
          dir,
          `removed ${result.removed} speaker-bleed segments from the mic track`,
        )
        log.info('[transcribe] removed speaker bleed', {
          sessionId: meta.id,
          removed: result.removed,
          nearEndDb: Number(result.nearEndDb.toFixed(1)),
        })
      }

      return result.segments
    } catch (err) {
      // Never fatal: a transcript with some misattributed lines is far better
      // than no transcript at all.
      await this.#log(dir, `bleed detection skipped: ${err}`)
      return segments
    }
  }

  async #transcribe(dir: string, sessionId: string): Promise<void> {
    const meta = JSON.parse(await readFile(join(dir, 'meta.json'), 'utf8')) as SessionMeta

    if (!this.#engine) {
      const engine = await this.createEngine()
      try {
        await engine.prepare()
      } catch (err) {
        // Assign only once loading has actually succeeded. A half-constructed
        // engine left in the field would be reused by every subsequent job,
        // turning one failed model load into a queue that can never recover
        // without a restart.
        await engine.release().catch(() => {})
        throw err
      }
      this.#engine = engine
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

    const segments = await this.#removeBleed(dir, meta, merged)

    const transcript: Transcript = {
      model: engine.modelId,
      createdAt: new Date().toISOString(),
      segments,
    }

    // Write atomically: resumePending treats the presence of transcript.json
    // as "done", so a half-written file must never exist.
    const tmp = join(dir, 'transcript.json.tmp')
    await writeFile(tmp, JSON.stringify(transcript, null, 2), 'utf8')
    const { rename } = await import('node:fs/promises')
    await rename(tmp, join(dir, 'transcript.json'))

    await this.#log(dir, `done — ${merged.length} segments`)

    // Re-place the user's edits against the transcript that just replaced the
    // one they were made on. This is the case the whole overlay design exists
    // for: writing edits into transcript.json would have destroyed them three
    // lines ago, silently.
    //
    // Failure is logged and swallowed. corrections.json is left exactly as it
    // was, so the edits survive to be re-placed on the next run — losing a
    // transcription over a bookkeeping error would be the worse trade.
    try {
      const existing = await readCorrections(dir)
      if (existing?.segments.length) {
        const result = reapplyCorrections(segments, existing)
        await writeCorrections(dir, result.corrections)
        await this.#log(
          dir,
          `corrections re-applied — ${result.applied} kept, ${result.orphaned} orphaned`,
        )
      }
    } catch (err) {
      await this.#log(dir, `corrections re-apply failed: ${String(err)}`)
    }

    // Ordered after the transcript is on disk, never before: the audio is the
    // only copy of the meeting until the transcript exists, so deleting it
    // first would turn one failed job into a lost meeting.
    //
    // Re-read rather than reusing the `meta` from the top of this method:
    // transcription can take minutes, and the flag must reflect what the file
    // says now. `discardSessionAudio` writes to the same file, so acting on a
    // stale copy would also risk clobbering it.
    const current = (await readMeta(dir)) ?? meta
    if (current.discardAudio) {
      try {
        await discardSessionAudio(dir)
        await this.#log(dir, 'audio discarded at user request (discardAudio)')
      } catch (err) {
        // Left for the next launch rather than escalated: the transcript is
        // already safe, and resumePending re-checks. Failing the job here
        // would re-run a completed transcription.
        await this.#log(dir, `could not discard audio: ${err}`)
        log.warn(`[queue] ${sessionId} audio discard failed`, err)
      }
    }

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
