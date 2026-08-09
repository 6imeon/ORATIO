import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { app } from 'electron'
import log from 'electron-log/main'

/**
 * What the last completed recording observed about each track.
 *
 * This exists because macOS gives us no way to ask whether system-audio
 * capture is permitted. `systemPreferences.getMediaAccessStatus` covers the
 * microphone and camera only; there is no equivalent for a Core Audio process
 * tap, and the only way to "check" would be to start a tap and see what comes
 * out — which is a side effect, not a query (ARCHITECTURE §6).
 *
 * So the answer is inferred from evidence instead: a track that produced
 * *exactly* zero amplitude for an entire recording was not permitted, because
 * a working tap on a silent machine still carries a dither floor. That
 * evidence only exists at the moment a recording ends, and the recording
 * controller throws it away on reset — so it is written here, where the
 * settings panel can read it on a later launch without recording anything.
 *
 * Kept out of `settings.json` deliberately. Settings are the user's choices
 * and are theirs to edit or copy between machines; this is an observation
 * about one Mac's TCC state, and a stale value copied to another machine
 * would be worse than no value at all.
 */

export interface CaptureHealth {
  /** ISO timestamp of the recording these observations came from. */
  observedAt: string
  /** Peak amplitude 0..1 of the mic track over the whole recording. */
  micPeak: number
  systemPeak: number
}

const healthPath = (): string => join(app.getPath('userData'), 'capture-health.json')

export async function readCaptureHealth(): Promise<CaptureHealth | null> {
  try {
    const raw = await readFile(healthPath(), 'utf8')
    const parsed = JSON.parse(raw) as Partial<CaptureHealth>

    // Guard the shape rather than trusting it: this file is only ever written
    // by us, but a truncated write from a power loss would otherwise turn a
    // permissions panel into a crash.
    if (
      typeof parsed.observedAt !== 'string' ||
      typeof parsed.micPeak !== 'number' ||
      typeof parsed.systemPeak !== 'number'
    ) {
      return null
    }
    return { observedAt: parsed.observedAt, micPeak: parsed.micPeak, systemPeak: parsed.systemPeak }
  } catch {
    return null
  }
}

export async function writeCaptureHealth(health: CaptureHealth): Promise<void> {
  try {
    await mkdir(dirname(healthPath()), { recursive: true })
    await writeFile(healthPath(), JSON.stringify(health, null, 2), 'utf8')
  } catch (err) {
    // Best effort by design. This is diagnostic information for a settings
    // panel; failing to record it must never fail the recording that just
    // finished successfully.
    log.warn('[capture-health] could not persist observation', err)
  }
}

/**
 * Turn a peak amplitude into the three-state answer the UI shows.
 *
 * The thresholds are deliberately asymmetric. Exactly zero is the only value
 * that means "denied", because that is the signature of the silent-success
 * failure — a permitted tap that captured a genuinely quiet room still returns
 * a non-zero floor. Anything above zero is evidence the tap worked, which is
 * why this reports `likely-granted` rather than `granted`: we observed audio
 * flowing once, which is not the same as holding a permission now, and the
 * wording in the UI has to match that.
 */
export function inferTrackAccess(
  peak: number | undefined,
): 'likely-granted' | 'likely-denied' | 'unknown' {
  if (peak === undefined) return 'unknown'
  return peak > 0 ? 'likely-granted' : 'likely-denied'
}
