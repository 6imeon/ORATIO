/**
 * Voice-activity detection.
 *
 * This is NOT optional polish. Whisper-family models hallucinate confidently
 * on silence — the notorious "Thank you for watching!" and "[BLANK_AUDIO]"
 * artefacts — and a system-audio tap produces long silent stretches whenever
 * nobody is speaking. Without VAD gating the transcript fills with invented
 * text and the product looks broken.
 *
 * Silero VAD runs ahead of ASR; non-speech regions are dropped entirely and
 * never reach the model.
 */

export interface SpeechRegion {
  /** Seconds from the start of the track. */
  start: number
  end: number
}

/**
 * Longest region the detector may emit, in ms.
 *
 * ## Why this is an ordering parameter, not a memory one
 *
 * This was 30 s, chosen to bound decoder backlog, and it is the direct cause of
 * report A: an interjection landing *after* the far-end turn it interrupted
 * instead of inside it. The transcript's ordering unit is the VAD region, and
 * regions are sorted by start time. Continuous far-end audio never produces the
 * `minSilenceDurationMs` gap needed to split a region, so an entire paragraph
 * stays one 30 s block — and a two-second interjection starting anywhere inside
 * it still starts *later* than the block did, so it sorts after the whole thing.
 *
 * A shorter cap gives the interjection somewhere to sort *between*. Measured on
 * the W1 fixture, whose far-end track is one unbroken 17.4 s region:
 *
 *   30 s / 20 s / 15 s   2 far-end regions, 1 mic region — no reordering at all
 *   12 s                 3 far-end regions, but the mic stays whole — still none
 *   10 s / 9 s / 8 s     reorders correctly, but seams are damaged
 *   7.5 s .. 5.5 s       reorders correctly, seams clean
 *
 * ## This is a target, not a ceiling
 *
 * Measured, sherpa's Silero routinely exceeds it: at 7 s the fixture's mic track
 * still returns regions of 11.3 s and 9.6 s. The detector only cuts where speech
 * probability actually dips, so the cap chooses among the pauses the audio
 * already contains rather than imposing a boundary on it. Setting 10, 7 or 5 s
 * yields the identical two mic regions, because those are the only two places a
 * cut is available.
 *
 * Two consequences worth stating, since neither is obvious from the name:
 *
 *   - **The old 30 s value never bounded decoder backlog either**, which was the
 *     reason given for it. A region is as long as the audio's pauses allow. If a
 *     hard bound is ever genuinely needed, it has to be enforced downstream, the
 *     way `splitLongRegions` does it in `energyVad.ts`.
 *   - **It is also why the seams stay clean.** A cap that cut at exactly N
 *     seconds would slice mid-word; this one cannot.
 *
 * ## Why 7 s specifically
 *
 * Not a tuned point — the middle of a plateau. Every value from 5.5 s to 7.5 s
 * produces an identical result on the fixture, because across that band the cap
 * is not the binding constraint and Silero is choosing real silences. Push below
 * it and the clock starts winning, taking cuts at worse and worse places:
 *
 *   at 9 s   "...absolutely nothing. That is. That's."   <- stub
 *   at 5 s   "It's nothing there. Not a" / "Hints of moisture."
 *   at 4 s   "That's just c yeah, it's just clay"        <- word cut in half
 *
 * 7 s sits mid-plateau and keeps the largest regions the audio's own structure
 * allows, which matters because ASR accuracy rises with context.
 *
 * **There is no padding to fall back on here.** `speechPadMs` protects region
 * edges only in the energy detector; sherpa's Silero binding exposes no
 * equivalent parameter, so on the primary path the cut is unpadded and where it
 * falls is the only thing protecting the words either side of it. That is the
 * whole reason for choosing from a plateau rather than picking the smallest
 * value that reorders.
 *
 * This mitigates report A rather than fixing it. Genuinely simultaneous speech
 * still cannot be expressed by a flat start-time sort — see ATTRIBUTION.md
 * open question 1.
 */
const MAX_SPEECH_DURATION_MS = 7_000

export interface VadOptions {
  /**
   * Speech probability above which a frame counts as speech. Lower catches
   * more quiet speech at the cost of more false positives.
   */
  threshold?: number
  /** Drop detected regions shorter than this — usually clicks, not words. */
  minSpeechDurationMs?: number
  /**
   * Silence shorter than this does not split a region. Without it, natural
   * pauses mid-sentence fragment the transcript.
   */
  minSilenceDurationMs?: number
  /**
   * Padding kept either side of each region so word onsets and tails are not
   * clipped. ASR accuracy drops noticeably without it.
   */
  speechPadMs?: number
  /**
   * Target length for one region, in ms — deliberately not a ceiling. Silero
   * cuts only where speech probability dips, so a region with no pause in it
   * runs past this. See `MAX_SPEECH_DURATION_MS`; the energy detector enforces
   * it strictly, sherpa does not.
   */
  maxSpeechDurationMs?: number
}

export const DEFAULT_VAD_OPTIONS: Required<VadOptions> = {
  threshold: 0.5,
  minSpeechDurationMs: 250,
  minSilenceDurationMs: 500,
  speechPadMs: 300,
  maxSpeechDurationMs: MAX_SPEECH_DURATION_MS,
}

/**
 * Decoding parameters that further suppress hallucination on marginal audio.
 * Applied to Whisper-family models; Moonshine and Parakeet are far less prone
 * to this but are unharmed by the settings.
 */
export const ANTI_HALLUCINATION = {
  /** Blank outputs are suppressed rather than emitted as empty segments. */
  suppressBlank: true,
  /** Default 0.6 is too permissive for meeting audio. */
  noSpeechThreshold: 0.4,
  /** Catches degenerate repetition loops ("yeah yeah yeah yeah..."). */
  compressionRatioThreshold: 2.0,
} as const

/** Text that ASR emits on silence and which should never reach the user. */
const HALLUCINATION_PATTERNS = [
  /^\s*\[?\s*(blank[ _]audio|music|silence|inaudible|applause)\s*\]?\s*$/i,
  /^\s*thank(s| you)( you)? for watching[.!]?\s*$/i,
  /^\s*(please )?subscribe.{0,30}$/i,
  /^\s*you\s*$/i,
  /^\s*\.+\s*$/,
]

/**
 * Final defence: drop segments that are pure hallucination artefacts.
 * VAD prevents most of these; this catches what slips through.
 */
export function isLikelyHallucination(text: string): boolean {
  const t = text.trim()
  if (!t) return true
  return HALLUCINATION_PATTERNS.some((re) => re.test(t))
}
