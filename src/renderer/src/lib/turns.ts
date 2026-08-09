import type { Speaker, TranscriptSegment } from '@shared/types'

/**
 * A speaker turn: consecutive segments from the same speaker, merged.
 *
 * W3C's transcript guidance is explicit that a transcript should read as
 * logical paragraphs rather than caption-style lines, with timestamps
 * "only when useful" — their worked example folds six caption lines into two
 * paragraphs (UI.md §4). One seek point per handoff is the convention.
 *
 * It is also the cheapest performance win available. ASR emits a segment every
 * few seconds; a two-hour meeting is several thousand of them, and merging
 * typically cuts the rendered row count by a large factor before any
 * virtualization is involved.
 */
export interface Turn {
  /** Stable across re-renders: index into the turn array, assigned once. */
  index: number
  speaker: Speaker
  speakerLabel?: string
  startMs: number
  endMs: number
  text: string
  /** Kept so ⌘F hit-to-audio can seek to the line, not just the turn. */
  segments: TranscriptSegment[]
  /**
   * Where this turn's segments sit in the transcript, so an edit can be written
   * back to the right one.
   *
   * A turn is a display construct — several segments merged into a paragraph —
   * while a correction is per-segment. Without this the renderer would have to
   * re-derive the mapping by scanning for object identity, which is exactly the
   * kind of implicit coupling that breaks the next time merging changes.
   */
  firstSegment: number
}

/**
 * A gap longer than this starts a new turn even when the speaker hasn't
 * changed.
 *
 * Without it, one person talking for ten minutes with pauses collapses into a
 * single unscrollable wall with one timestamp at the top — which loses the
 * seek granularity that click-to-play depends on. Six seconds is comfortably
 * longer than the breath pauses inside a sentence and shorter than the beat
 * where someone genuinely stops and resumes.
 */
const TURN_GAP_MS = 6_000

/**
 * Merge segments into turns. Pure, so it can be memoised on the transcript
 * identity and never recomputed during a render.
 *
 * Segments are assumed to be in time order — the transcript writer merges the
 * two tracks on a shared clock before writing, so this does not re-sort. If it
 * did, it would silently paper over an ordering bug upstream that matters far
 * more than the display.
 */
export function mergeTurns(segments: readonly TranscriptSegment[]): Turn[] {
  const turns: Turn[] = []

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]
    if (seg === undefined) continue
    const last = turns[turns.length - 1]
    const continues =
      last !== undefined &&
      last.speaker === seg.speaker &&
      last.speakerLabel === seg.speakerLabel &&
      seg.startMs - last.endMs <= TURN_GAP_MS

    if (continues) {
      // A space, not a newline: these are clauses of one paragraph. Trimming
      // guards against ASR emitting leading whitespace on a continuation.
      last.text = `${last.text} ${seg.text.trim()}`.trim()
      last.endMs = Math.max(last.endMs, seg.endMs)
      last.segments.push(seg)
      continue
    }

    turns.push({
      index: turns.length,
      speaker: seg.speaker,
      ...(seg.speakerLabel !== undefined ? { speakerLabel: seg.speakerLabel } : {}),
      startMs: seg.startMs,
      endMs: seg.endMs,
      text: seg.text.trim(),
      segments: [seg],
      firstSegment: i,
    })
  }

  return turns
}

/**
 * Index of the turn containing `ms`, or -1 before the first turn starts.
 *
 * Binary search, not a linear scan, because this is called from `timeupdate`
 * — which fires up to 66 times a second (UI.md §4). At a few thousand turns a
 * linear scan is ~11 comparisons' worth of work done 66×/s for no reason.
 *
 * Returns the last turn whose `startMs <= ms`, deliberately including the gaps
 * between turns: during a pause the previous speaker stays highlighted, which
 * reads as "we are still in this part of the meeting" rather than flickering
 * the highlight off between every sentence.
 */
export function findTurnAt(turns: readonly Turn[], ms: number): number {
  let lo = 0
  let hi = turns.length - 1
  let found = -1

  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const turn = turns[mid]
    // noUncheckedIndexedAccess: mid is always in range here, but the compiler
    // cannot know that and the check costs nothing.
    if (turn === undefined) break

    if (turn.startMs <= ms) {
      found = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }

  return found
}

/** `m:ss`, or `h:mm:ss` past an hour. One per turn, not one per segment. */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const pad = (n: number): string => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`
}
