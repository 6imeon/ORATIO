import type { MutedRange } from '@shared/types'
import type { Turn } from './turns'

/**
 * A muted stretch, positioned in the turn list.
 *
 * `beforeTurn` is the index of the first turn that starts at or after the mute
 * ended — where the marker is drawn. `turns.length` means the mute ran to the
 * end of the recording and the marker goes last.
 */
export interface MutedMarker {
  startMs: number
  endMs: number
  beforeTurn: number
}

/**
 * Ignore mutes shorter than this.
 *
 * A mute of under a second is a mis-click or a toggle the user immediately
 * undid, and it removes no meaningful speech. Rendering it would put a
 * full-width marker in the transcript for nothing, and several of them in a row
 * for someone fidgeting with the shortcut.
 */
const MIN_VISIBLE_MS = 1_000

/**
 * Place each muted range in the turn list.
 *
 * Muting is the one case where a *gap* in the transcript is the app working
 * correctly rather than failing, and the transcript cannot show that on its
 * own: a muted stretch is recorded as silence, VAD drops silence before ASR,
 * so there are simply no segments. Nothing distinguishes it from a dead
 * microphone by inspection — meta.json's `mutedRanges` is the only record, and
 * this is what reads it (docs/PRIVACY.md §5, P2).
 *
 * Anchored to the *end* of the range rather than the start. A marker placed
 * before the last turn preceding the mute would sit above speech that happened
 * before muting began, which reads as though that speech were muted too.
 * Placing it before the turn that resumes puts it exactly in the visual gap.
 *
 * Pure, so it memoises on the turn identity and never runs during a render.
 */
export function placeMutedMarkers(
  turns: readonly Turn[],
  ranges: readonly MutedRange[] | undefined,
): MutedMarker[] {
  if (!ranges?.length) return []

  return ranges
    .filter((r) => r.endMs - r.startMs >= MIN_VISIBLE_MS)
    .map((r) => {
      // The first turn that had not yet started when the mute ended. Turns
      // from the *other* track continue throughout a mute — only the mic is
      // gated — so this is usually a real turn, not the end of the list.
      const at = turns.findIndex((t) => t.startMs >= r.endMs)
      return {
        startMs: r.startMs,
        endMs: r.endMs,
        beforeTurn: at === -1 ? turns.length : at,
      }
    })
    .sort((a, b) => a.startMs - b.startMs)
}

/** `1 min 20 sec`, `45 sec` — spoken duration, not a clock reading. */
export function formatDuration(ms: number): string {
  const total = Math.max(1, Math.round(ms / 1000))
  const m = Math.floor(total / 60)
  const s = total % 60
  if (m === 0) return `${s} sec`
  if (s === 0) return `${m} min`
  return `${m} min ${s} sec`
}
