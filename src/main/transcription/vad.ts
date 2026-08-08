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
}

export const DEFAULT_VAD_OPTIONS: Required<VadOptions> = {
  threshold: 0.5,
  minSpeechDurationMs: 250,
  minSilenceDurationMs: 500,
  speechPadMs: 300,
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
