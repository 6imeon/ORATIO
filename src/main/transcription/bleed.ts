import type { TranscriptSegment } from '@shared/types'

/**
 * Speaker bleed: the other side's voice, picked up by your microphone.
 *
 * With speakers instead of headphones, the remote participants' audio comes out
 * of the laptop and straight back into the mic. That audio is genuinely in
 * `mic.wav`, so ASR transcribes it and the merged transcript attributes it to
 * "me" — the user is recorded saying things the other person said, usually
 * garbled, because it is a second-hand copy through a speaker and a room.
 *
 * ## Why this is detection, not cancellation
 *
 * The obvious fix is acoustic echo cancellation, and it is not available here.
 * AEC models the echo path as an adaptive filter and requires the microphone
 * and the reference signal to share a sample clock. Ours do not: the mic comes
 * from WebAudio in the renderer and the system track from AudioTee in main —
 * two independent Core Audio clients with free-running clocks. Speex's manual
 * states the case plainly ("Using a different soundcard to do the capture and
 * playback will *not* work"), and its own diagnostic tool exists to tell you
 * that your clocks drift and no AEC will help. The drift makes the true delay
 * ramp continuously, so the filter never converges.
 *
 * Two further reasons, either of which would be sufficient:
 *
 *   - Our reference is the PRE-mixer system tap, which is the whole reason we
 *     use AudioTee. What actually reached the room went through the volume
 *     control, the EQ and a nonlinear speaker. A linear filter cannot model
 *     that by definition.
 *   - An AEC that mis-converges during double-talk attenuates the near-end
 *     speaker. That is the digital-silence failure class this codebase has
 *     already been bitten by (LIVENESS_CHECK_MS exists for it), except worse:
 *     it would eat the user's own words selectively, and a peak-amplitude
 *     check would not see it.
 *
 * ## What the literature does instead
 *
 * This is the meeting-corpus crosstalk problem, not the AEC problem. Pfau,
 * Ellis & Stolcke (ASRU 2001) and Wrigley et al. (IEEE TSAP 2005) both address
 * exactly this shape — N channels each nominally one speaker, contaminated by
 * the others, needing ATTRIBUTION rather than clean audio — and both converge
 * on the same answer: cross-channel correlation plus relative energy, deciding
 * per segment which channel a sound belongs to. Pfau's rule is to reject the
 * hypothesised speech on whichever channel has the LOWER energy when the
 * correlation is high, and Wrigley found correlation so dominant that removing
 * log energy entirely barely moved their ROC curves.
 *
 * Crucially, the clock drift that makes AEC impossible is harmless here.
 * Correlation only needs alignment to within a few milliseconds to attribute a
 * segment; AEC needed it to a fraction of a sample. That asymmetry is the whole
 * argument for doing it this way.
 *
 * Pfau also reports trying the cancellation route and abandoning it, for a
 * reason unrelated to clocks: the coupling filters "are sensitive to changes of
 * just a few centimeters", so a person moving their head breaks them. A laptop
 * user does that constantly.
 *
 * ## What this module does
 *
 * Works on the TRANSCRIPT, not the audio. For each "me" segment it looks for a
 * "them" segment overlapping in time whose text is near-identical, and drops
 * the "me" copy. Text similarity stands in for the correlation feature: two
 * transcriptions of the same acoustic event agree far more than two people
 * independently saying the same thing at the same moment. The measured natural
 * coincidence rate — genuinely simultaneous identical words — is about 0.2% of
 * frames (LibriCSS, arXiv 2509.10143), so a match is close to conclusive.
 *
 * The audio is never modified, so this cannot produce a silent recording. The
 * worst case is a dropped or kept line in a transcript, which is visible,
 * recoverable, and re-runnable with a different threshold.
 */

/**
 * How much of the shorter segment must overlap in time.
 *
 * Bleed is simultaneous by construction — the sound reaches the mic within
 * milliseconds of entering the system tap. But the two ASR passes segment
 * independently, so the boundaries rarely line up: one track may split a
 * sentence the other keeps whole. A fraction of the shorter segment is the
 * robust test; requiring the ranges to match closely would miss most real
 * cases.
 */
const MIN_OVERLAP = 0.35

/**
 * How similar the words must be.
 *
 * A CONFIRMING signal, never the deciding one. Measured on a real bleed-heavy
 * recording, text similarity does not separate the two classes at all: genuine
 * bleed pairs scored as low as 0.14 (ASR mangles the second-hand copy badly
 * enough that few words survive), while a legitimately repeated phrase — one
 * person agreeing with another using the same words — scores 1.0. The ranges
 * overlap completely, so a similarity threshold alone would both miss most
 * bleed and delete real speech.
 *
 * It earns its place only alongside the energy test below, where it guards the
 * one case energy cannot see: the user genuinely speaking, quietly, while the
 * other side talks.
 */
const MIN_SIMILARITY = 0.45

/**
 * How far below the system track a mic segment must sit to look like bleed.
 *
 * This is the signal that actually works, and it is a measurement rather than a
 * guess. On a recording made through laptop speakers, every mic segment sat
 * between 27 and 36 dB below the system track over the same window — the mic's
 * PEAK was quieter than the system track's average. Sound that has travelled
 * out of a speaker, across a room and into a microphone arrives dramatically
 * attenuated, and that is a physical property rather than a linguistic one.
 *
 * 20 dB is a hundredfold difference in power and sits well clear of the -27 dB
 * worst case observed, leaving margin for a louder room or a closer mic while
 * staying far from the range where the user's own voice lives — speaking into
 * your own laptop mic is normally LOUDER than the meeting audio, not thirty
 * decibels quieter.
 */
const BLEED_LEVEL_DB = -20

/**
 * Below this, the level gap decides on its own.
 *
 * A microphone hearing a person in front of it does not sit 25 dB under the
 * meeting audio; that gap is what an acoustic path across a room does, and
 * nothing else in normal use produces it. Requiring a text match as well would
 * be strictly worse, because ASR mangles the second-hand copy badly enough that
 * real bleed often scores near zero on similarity — measured at 0.06 on one
 * segment of a recording where every single "me" line was bleed.
 *
 * The band between this and BLEED_LEVEL_DB is the genuinely ambiguous one: a
 * quiet user, or a distant one. There, and only there, the words have to agree
 * too.
 */
const CONCLUSIVE_LEVEL_DB = -25

/**
 * Words too common to count as evidence.
 *
 * Two unrelated English sentences share "the", "and", "you" constantly, which
 * inflates similarity between segments that have nothing to do with each other.
 * Removing them makes the score reflect content rather than grammar. Kept
 * short — an aggressive stop list would strip short utterances down to nothing
 * and make them unmatchable.
 */
const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'so', 'to', 'of', 'in', 'on', 'at',
  'is', 'it', 'that', 'this', 'i', 'you', 'we', 'they', 'be', 'was', 'are',
  'for', 'with', 'as', 'do', 'have', 'has', 'yeah', 'yes', 'no', 'ok', 'okay',
])

/**
 * Words, lowercased, without punctuation or stopwords.
 *
 * Numbers are kept as digits and words alike: "507" and "407" differ, which is
 * exactly the kind of ASR damage that should REDUCE similarity, and losing them
 * would make two readings of the same figure look identical.
 */
function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 0 && !STOPWORDS.has(w))
}

/**
 * Dice coefficient over token multisets: 2·|shared| / (|a| + |b|).
 *
 * Multiset rather than set so a repeated word counts as many times as it
 * appears in both — "bit of a bit of a bit" is a real ASR failure mode on
 * bleed, and set semantics would score it against anything.
 */
export function similarity(a: string, b: string): number {
  const ta = tokens(a)
  const tb = tokens(b)
  if (ta.length === 0 || tb.length === 0) return 0

  const counts = new Map<string, number>()
  for (const w of ta) counts.set(w, (counts.get(w) ?? 0) + 1)

  let shared = 0
  for (const w of tb) {
    const left = counts.get(w) ?? 0
    if (left > 0) {
      shared++
      counts.set(w, left - 1)
    }
  }

  return (2 * shared) / (ta.length + tb.length)
}

/** Fraction of the SHORTER segment that lies inside the other. */
function overlapRatio(a: TranscriptSegment, b: TranscriptSegment): number {
  const start = Math.max(a.startMs, b.startMs)
  const end = Math.min(a.endMs, b.endMs)
  const shared = end - start
  if (shared <= 0) return 0

  const shortest = Math.min(a.endMs - a.startMs, b.endMs - b.startMs)
  return shortest <= 0 ? 0 : shared / shortest
}

export interface BleedResult {
  segments: TranscriptSegment[]
  /** How many "me" segments were dropped as bleed. */
  removed: number
  /** Median mic-minus-system level across overlapping segments, for the log. */
  medianLevelDb: number
}

/**
 * Per-segment levels on both tracks, for the same time window.
 *
 * Supplied by the caller rather than read here, so this function stays pure and
 * testable against fixtures — the level probe needs two WAVs and the decision
 * logic does not.
 */
export interface LevelProbe {
  /** Mic level minus system level, in dB, over a segment's window. */
  (segment: TranscriptSegment): number
}

/**
 * Drop "me" segments that are the other side's voice coming back through the
 * microphone.
 *
 * Only ever removes from the mic track. The system track is captured digitally
 * from the audio subsystem and cannot contain bleed from the microphone —
 * there is no acoustic path in that direction — so the asymmetry is physical
 * rather than a heuristic.
 *
 * A segment is dropped when ALL THREE hold:
 *
 *   1. It overlaps a "them" segment in time. Bleed is simultaneous by physics.
 *   2. The mic is far below the system track over that window. This is the
 *      decisive test — measured at 27-36 dB on a real speaker recording.
 *   3. Either the words match, or the level gap is so extreme that no
 *      near-field speech could produce it.
 *
 * The audio is never touched, so this cannot produce a silent recording. The
 * worst outcome is a dropped or kept transcript line — visible, recoverable,
 * and re-derivable by rescanning, which is what the vault's derived-data rule
 * requires.
 */
export function removeSpeakerBleed(
  segments: readonly TranscriptSegment[],
  level: LevelProbe,
): BleedResult {
  const them = segments.filter((s) => s.speaker === 'them')

  // Nothing to compare against — headphone users, one-sided recordings, and
  // meetings where the mic track is absent all take this path, and it costs
  // nothing.
  if (them.length === 0) {
    return { segments: [...segments], removed: 0, medianLevelDb: 0 }
  }

  let removed = 0
  const observed: number[] = []

  const kept = segments.filter((seg) => {
    if (seg.speaker !== 'me') return true

    const overlapping = them.filter((other) => {
      // Sorted, so once a candidate starts after this segment ends there can
      // be no further overlap.
      if (other.startMs >= seg.endMs) return false
      return overlapRatio(seg, other) >= MIN_OVERLAP
    })

    if (overlapping.length === 0) return true

    const gap = level(seg)
    if (Number.isFinite(gap)) observed.push(gap)

    // Loud enough to be someone speaking into this microphone. Whatever the
    // words say, near-field speech is not bleed — and this is the branch that
    // protects the user agreeing with a phrase the other side just used, which
    // text similarity scores as a perfect match.
    if (gap > BLEED_LEVEL_DB) return true

    // Far enough down that the level settles it on its own.
    if (gap <= CONCLUSIVE_LEVEL_DB) {
      removed++
      return false
    }

    // The ambiguous band: quiet, but not impossibly so. The words have to
    // agree as well before anything is discarded.
    if (overlapping.some((other) => similarity(seg.text, other.text) >= MIN_SIMILARITY)) {
      removed++
      return false
    }

    return true
  })

  observed.sort((a, b) => a - b)
  const medianLevelDb = observed.length > 0 ? (observed[observed.length >> 1] ?? 0) : 0

  return { segments: kept, removed, medianLevelDb }
}
