import { existsSync } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import log from 'electron-log/main'
import type { SessionMeta, TrackMeta } from '@shared/types'
import { TARGET_SAMPLE_RATE } from '../audio/AudioCapture'
import { repairWavHeader } from '../audio/wav'
import { FILES, writeMeta } from '../storage/vault'

/**
 * Recover recordings orphaned by a crash.
 *
 * A session is complete when `meta.json` exists — that is the whole queue
 * protocol, and it is what makes crash recovery free for every *transcription*
 * failure. But it cuts the other way for a crash during *recording*: the
 * directory has two WAVs and no meta.json, so `listSessions` skips it and
 * `resumePending` skips it, and a meeting that was captured correctly right up
 * to the moment the power went is invisible forever. The audio is on disk, and
 * nothing ever looks at it again.
 *
 * The fix is not a new queue or a state file — both would break the invariant
 * that the filesystem is the only queue. It is to finish the job the crashed
 * process did not: patch the WAV headers from the byte counts on disk, write
 * the meta.json that was never written, and let the ordinary pending path take
 * it from there.
 *
 * Run once at startup, before `resumePending`, so recovered sessions are
 * transcribed in the same pass as everything else that was waiting.
 */

/** A WAV with only a header and no samples is not worth recovering. */
const HEADER_BYTES = 44

interface Recovered {
  dir: string
  durationSeconds: number
}

export async function recoverOrphanedSessions(vaultPath: string): Promise<Recovered[]> {
  let entries: string[]
  try {
    entries = await readdir(vaultPath)
  } catch {
    // No vault yet — nothing has ever been recorded.
    return []
  }

  const recovered: Recovered[] = []

  for (const name of entries.sort()) {
    const dir = join(vaultPath, name)

    // meta.json present means the session finished normally, whatever else is
    // or is not there. Never rewrite one: it holds the real start time, the
    // title, and the measured track offsets, none of which are recoverable
    // from the audio.
    if (existsSync(join(dir, FILES.meta))) continue

    try {
      const result = await recoverSession(dir, name)
      if (result) recovered.push(result)
    } catch (err) {
      // One unreadable directory must not stop the others being recovered.
      log.warn('[recover] could not recover session', { dir, err })
    }
  }

  if (recovered.length > 0) {
    log.info(`[recover] rebuilt meta.json for ${recovered.length} interrupted recording(s)`, {
      sessions: recovered.map((r) => `${r.dir} (${r.durationSeconds}s)`),
    })
  }

  return recovered
}

async function recoverSession(dir: string, name: string): Promise<Recovered | null> {
  const dirStat = await stat(dir).catch(() => null)
  if (!dirStat?.isDirectory()) return null

  /**
   * A transcript without a meta.json is not an interrupted recording.
   *
   * The queue writes meta.json long before any transcript exists, so this
   * cannot happen by itself — but the vault is the user's folder and they are
   * free to delete files in it. Writing a meta.json here would make a finished
   * session look pending and hand it back to the queue, which would re-run ASR
   * and overwrite a transcript that may have been corrected by hand. Recovery
   * exists to rescue work, so it must never be the thing that destroys it.
   */
  if (existsSync(join(dir, FILES.transcript))) return null

  const tracks = await Promise.all([
    measureTrack(dir, FILES.mic, 'me' as const),
    measureTrack(dir, FILES.system, 'them' as const),
  ])
  const present = tracks.filter((t) => t !== null)

  // A directory with no audio is not an interrupted recording — it is a
  // session whose start() failed after mkdir, or something the user put here.
  // Leaving it alone is correct; deleting other people's folders is not our
  // business.
  if (present.length === 0) return null

  /**
   * Patch each header from the bytes actually on disk.
   *
   * The writer patches every 30 s while recording, so a crash usually leaves a
   * header that under-reports by up to half a minute — the file plays, but the
   * tail is missing. Recomputing from the real size recovers those samples,
   * which are the ones nearest to whatever the user was saying when it died.
   */
  for (const track of present) {
    await repairWavHeader(join(dir, track.file), track.fileBytes)
  }

  /**
   * Everything below is inferred, and the comments say which parts are weaker
   * than what a clean stop would have produced.
   *
   * `startOffsetMs` is 0 for both tracks: the real value came from comparing
   * the two first-buffer timestamps in memory, and that measurement died with
   * the process. Assuming zero is the honest default — it is what "we do not
   * know" looks like in this schema, and it is right whenever both tracks
   * started together, which is the normal case.
   */
  const trackMetas: TrackMeta[] = present.map((t) => ({
    file: t.file,
    speaker: t.speaker,
    startOffsetMs: 0,
  }))

  const durationSeconds = Math.round(
    Math.max(...present.map((t) => t.samples)) / TARGET_SAMPLE_RATE,
  )

  // Started-at comes from the directory name, which is generated from the
  // clock at start() and is accurate to the minute. mtime would be the crash
  // time, not the start time.
  const startedAt = parseSessionId(name) ?? new Date(dirStat.birthtime)

  const meta: SessionMeta = {
    id: name,
    // Marked in the title because the user should know why this one is
    // different: it may be missing its last seconds, and its two tracks are
    // assumed to have started together.
    title: `${formatTitle(startedAt)} (recovered)`,
    startedAt: startedAt.toISOString(),
    // The recording did not end; it stopped existing. Derive the end from the
    // audio so endedAt - startedAt matches the duration.
    endedAt: new Date(startedAt.getTime() + durationSeconds * 1000).toISOString(),
    durationSeconds,
    tracks: trackMetas,
    recovered: true,
  }

  await writeMeta(dir, meta)
  return { dir, durationSeconds }
}

interface MeasuredTrack {
  file: string
  speaker: 'me' | 'them'
  fileBytes: number
  samples: number
}

async function measureTrack(
  dir: string,
  file: string,
  speaker: 'me' | 'them',
): Promise<MeasuredTrack | null> {
  const s = await stat(join(dir, file)).catch(() => null)
  if (!s || s.size <= HEADER_BYTES) return null

  // 16-bit mono: two bytes per sample. Matches TrackWriter's on-disk format.
  const samples = Math.floor((s.size - HEADER_BYTES) / 2)
  if (samples === 0) return null

  return { file, speaker, fileBytes: s.size, samples }
}

/** `2026.08.08-1430` back into a Date. Returns null if the name is not ours. */
export function parseSessionId(name: string): Date | null {
  const m = /^(\d{4})\.(\d{2})\.(\d{2})-(\d{2})(\d{2})/.exec(name)
  if (!m) return null
  const [, y, mo, d, h, mi] = m
  const date = new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi))
  return Number.isNaN(date.getTime()) ? null : date
}

function formatTitle(date: Date): string {
  return date.toLocaleString(undefined, {
    weekday: 'long',
    hour: 'numeric',
    minute: '2-digit',
  })
}
