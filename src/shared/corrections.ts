import type { Correction, Corrections, TranscriptSegment } from './types'

/**
 * Merging and re-applying user corrections over machine output.
 *
 * The rules here are the ones argued out in docs/PRIVACY.md §4.1. In short:
 * transcript.json is disposable — re-transcription rewrites it wholesale — so
 * user edits live in a sibling corrections.json and are merged over the
 * segments at read time. Nothing writes a correction into transcript.json.
 *
 * Pure and dependency-free on purpose: this is the part that can silently
 * corrupt a user's own words, so it must be testable without a filesystem or an
 * Electron process.
 */

/**
 * Whitespace-insensitive, case-sensitive comparison.
 *
 * ASR output has unstable leading/trailing space and occasional double spaces
 * between sentences, none of which is a real difference. Case is left
 * significant because capitalisation is exactly the kind of thing a user
 * corrects ("ios" → "iOS"), and treating it as noise would make a real
 * correction look already-applied.
 */
function sameText(a: string, b: string): boolean {
  return a.trim().replace(/\s+/g, ' ') === b.trim().replace(/\s+/g, ' ')
}

/**
 * Where a correction should land in a possibly-rewritten segment list, or -1.
 *
 * Deliberately exact-match only, with no similarity threshold anywhere. `was`
 * is by definition text a model got wrong — short and garbled — so a threshold
 * loose enough to match it again is loose enough to match a different sentence,
 * and a wrong word the user appears to have typed themselves is worse than a
 * dropped correction. Safety comes from `was` being kept, not from clever
 * matching.
 */
export function locateCorrection(
  segments: readonly TranscriptSegment[],
  c: Correction,
): number {
  // The overwhelmingly common case: nothing before this segment changed.
  const at = segments[c.index]
  if (at && sameText(at.text, c.was)) return c.index

  // Segmentation shifted — A3's bleed removal deletes segments, so every index
  // after a removal moves. Fall back to identity by text, but only when the
  // answer is unambiguous.
  let found = -1
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]
    if (!seg || !sameText(seg.text, c.was)) continue
    if (found !== -1) return -1 // two candidates — refuse to guess
    found = i
  }
  return found
}

/**
 * Apply corrections over machine segments, returning a new array.
 *
 * Never mutates its input, and never drops or reorders a segment: a correction
 * changes text and nothing else. Timings in particular are untouched, so
 * click-to-play still seeks correctly from an edited line.
 */
export function applyCorrections(
  segments: readonly TranscriptSegment[],
  corrections: Corrections | null | undefined,
): TranscriptSegment[] {
  const out = segments.map((s) => ({ ...s }))
  if (!corrections?.segments?.length) return out

  for (const c of corrections.segments) {
    if (c.orphaned) continue

    const at = locateCorrection(segments, c)
    const seg = out[at]
    if (at === -1 || !seg) continue

    // Keep the machine's wording rather than the previous correction's, so
    // "revert" always goes back to what the model actually said even after the
    // line has been edited more than once.
    out[at] = { ...seg, text: c.text, corrected: true, originalText: c.was }
  }

  return out
}

/**
 * Re-place corrections against a freshly written transcript.
 *
 * Called after re-transcription. Corrections that can no longer be placed are
 * marked `orphaned` rather than removed — this is the only copy of text the
 * user typed, and silently deleting it would be the one unrecoverable failure
 * in the whole design. One that can be placed again has its index refreshed and
 * any earlier `orphaned` mark cleared, so a correction orphaned by a bad model
 * comes back when a better one restores the line.
 */
export function reapplyCorrections(
  segments: readonly TranscriptSegment[],
  corrections: Corrections,
): { corrections: Corrections; applied: number; orphaned: number } {
  let applied = 0
  let orphaned = 0

  const next = corrections.segments.map((c) => {
    const at = locateCorrection(segments, c)
    if (at === -1) {
      orphaned++
      return { ...c, orphaned: true }
    }
    applied++
    const { orphaned: _dropped, ...rest } = c
    return { ...rest, index: at }
  })

  return { corrections: { segments: next }, applied, orphaned }
}

/**
 * Record one edit, replacing any existing correction for the same segment.
 *
 * Returns `null` when the edit is a no-op or restores the machine's original
 * wording — in the latter case any existing correction is dropped, so reverting
 * a line leaves no trace rather than storing an edit that changes nothing.
 */
export function upsertCorrection(
  corrections: Corrections | null | undefined,
  segment: TranscriptSegment,
  index: number,
  text: string,
  editedAt: string,
): Corrections {
  const existing = corrections?.segments ?? []

  // The machine's wording, even if this line has already been edited once.
  const was = segment.originalText ?? segment.text
  const others = existing.filter((c) => c.index !== index)

  if (sameText(text, was)) return { segments: others }

  return {
    segments: [...others, { index, text, was, editedAt }].sort(
      (a, b) => a.index - b.index,
    ),
  }
}
