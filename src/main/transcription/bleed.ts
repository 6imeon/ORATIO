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
 * **That last sentence used to be read here as "correlation should replace the
 * level test", and it should not be.** Every channel in Wrigley's setup is a
 * microphone; ours are a digital tap and an acoustic mic, and cross-channel
 * energy behaves differently when the channels are different kinds of device.
 * Pfau's own Table 2 puts energy NORMALIZATION at 26.4% relative frame-error
 * improvement against 12.4% for the correlation post-processing on top of it —
 * energy is the larger win, not the smaller. The level test was never the wrong
 * feature. It was an unnormalized one, which is a different bug with a different
 * fix; see `measureTrackGains` in `../audio/readWav.ts`.
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
 * Works on the TRANSCRIPT, not the audio, and decides at the level of the whole
 * RECORDING before it looks at any segment: it asks whether the microphone ever
 * heard anything during the far end's pauses. If it did, there is a person at
 * that mic and nothing is removed. If it did not, mic segments overlapping
 * far-end speech are bleed.
 *
 * That ordering is the point. Within a single segment, a quiet interjection over
 * loud far-end audio and room echo of that same audio are the same measurement,
 * and no per-segment threshold separates them — see `NEAR_END_PRESENT_DB` for
 * the numbers and for what the earlier per-segment version got wrong.
 *
 * Text similarity was previously the confirming signal and has been removed: on
 * a real bleed-heavy recording it did not separate the classes at all, scoring
 * as low as 0.14 on genuine bleed (ASR mangles the second-hand copy) and 1.0 on
 * a legitimate repeat, where one person agrees using the other's words. Phase A2
 * in ATTRIBUTION.md replaces that role with cross-channel correlation, which is
 * the feature the literature actually uses.
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
 * How quiet the mic must be during the far end's PAUSES before this recording
 * is treated as having no near-end speaker at all.
 *
 * ## What the old constants were measuring
 *
 * This was -20 dB and compared raw per-segment levels, justified by a recording
 * where every mic segment sat 27-36 dB below the system track. The observation
 * was real; the inference was not. That gap is mostly the difference between a
 * pre-mixer digital tap and an acoustic microphone, and it is there whether or
 * not any bleed is.
 *
 * Measured on the W1 fixture — a HEADSET recording, no acoustic path, no bleed
 * possible — the raw gap is -20.5 dB, already past the old threshold, so the
 * detector deleted the user's only line. The comment here used to assume
 * "speaking into your own laptop mic is normally LOUDER than the meeting audio";
 * against a tap running near full scale it is not, and that assumption is what
 * deleted the speech.
 *
 * ## Why this is now a per-recording gate
 *
 * A per-segment level cannot answer this question at all. Both classes — the
 * user speaking quietly, and room echo of the far end — are quiet mic audio
 * overlapping loud system audio, and they are not separable on level within the
 * segment. `measureTrackGains` asks the question that IS separable, over the
 * whole recording: how loud does the mic get while the system track is silent?
 *
 *   real near-end speech (headset)   -25.7 dB
 *   simulated bleed, -15 dB path     -45.6 dB
 *   simulated bleed, -27 dB path     -51.3 dB
 *   simulated bleed, -36 dB path     -51.7 dB
 *
 * -35 dB sits about 10 dB clear of both sides. The bleed side saturates near
 * -51 dB — past roughly -20 dB of acoustic attenuation the mic hears its own
 * noise floor rather than the room — so the margin does not shrink as the
 * acoustic path gets worse.
 *
 * Above this line there is a person at the microphone, and their quiet moments
 * must not be deleted on a level argument. Below it there is not, and mic
 * segments overlapping far-end speech have no other source to have come from.
 */
const NEAR_END_PRESENT_DB = -35

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
  /**
   * The gate value this verdict was reached on, echoed back for the log.
   *
   * Worth recording on every run: it is the one number that explains a wrong
   * verdict in either direction, and it is unrecoverable once `discardAudio`
   * removes the tracks.
   */
  nearEndDb: number
  /**
   * Whether the recording was judged to have a person at the microphone.
   *
   * Reported separately from `removed` because the two differ in exactly the
   * case worth seeing in a log: a recording with no near-end speaker AND no mic
   * segments removes nothing, which is not the same as one where the user was
   * present.
   */
  nearEndPresent: boolean
}

/**
 * How loud the mic gets during the far end's pauses, relative to the system
 * track — `measureTrackGains().micRelativeDb`.
 *
 * Passed in rather than measured here so this function stays pure and testable
 * against fixtures: the measurement needs two WAVs and the decision logic does
 * not.
 */
export type NearEndLevel = number

/**
 * Drop "me" segments that are the other side's voice coming back through the
 * microphone.
 *
 * Only ever removes from the mic track. The system track is captured digitally
 * from the audio subsystem and cannot contain bleed from the microphone —
 * there is no acoustic path in that direction — so the asymmetry is physical
 * rather than a heuristic.
 *
 * The recording is classified first, then its segments:
 *
 *   1. If the mic ever rises clearly above the system track during the far
 *      end's pauses, there is a person at that microphone. Nothing is removed.
 *      A quiet interjection over loud far-end audio is indistinguishable from
 *      bleed WITHIN the segment, so the only safe reading is the one that keeps
 *      the user's words.
 *   2. Otherwise the mic has no near-end source, and a mic segment is dropped
 *      when it overlaps a "them" segment. Bleed is simultaneous by physics, and
 *      with no one at the microphone there is nowhere else for overlapping mic
 *      audio to have come from.
 *
 * The audio is never touched, so this cannot produce a silent recording. The
 * worst outcome is a dropped or kept transcript line — visible, recoverable,
 * and re-derivable by rescanning, which is what the vault's derived-data rule
 * requires.
 */
export function removeSpeakerBleed(
  segments: readonly TranscriptSegment[],
  nearEndDb: NearEndLevel,
): BleedResult {
  const them = segments.filter((s) => s.speaker === 'them')
  const nearEndPresent = nearEndDb > NEAR_END_PRESENT_DB

  // Nothing to compare against — headphone users, one-sided recordings, and
  // meetings where the mic track is absent all take this path, and it costs
  // nothing.
  if (them.length === 0) {
    return { segments: [...segments], removed: 0, nearEndDb, nearEndPresent }
  }

  /*
   * There is a near-end speaker, so nothing on the mic track is presumed bleed.
   *
   * This is the branch that fixes the deleted-speech report, and it is
   * deliberately absolute rather than a per-segment softening: with a person at
   * the mic, the quiet mic segments are exactly the ones most likely to be
   * their genuine speech over loud far-end audio, and the level test has
   * already been shown unable to tell those apart.
   *
   * `measureTrackGains` reports 0 when it could not calibrate — too little
   * far-end silence to measure in — which lands here and leaves the transcript
   * untouched. Failing open is the right default for a destructive filter.
   */
  if (nearEndPresent) {
    return { segments: [...segments], removed: 0, nearEndDb, nearEndPresent }
  }

  let removed = 0

  const kept = segments.filter((seg) => {
    if (seg.speaker !== 'me') return true

    const overlapping = them.filter((other) => {
      // Sorted, so once a candidate starts after this segment ends there can
      // be no further overlap.
      if (other.startMs >= seg.endMs) return false
      return overlapRatio(seg, other) >= MIN_OVERLAP
    })

    if (overlapping.length === 0) return true

    /*
     * No near-end source in this recording, and this segment sits on top of
     * far-end speech, so there is nowhere else for it to have come from.
     *
     * A text match is confirming evidence but is deliberately NOT required:
     * real bleed often scores near zero on similarity — measured at 0.06 on a
     * recording where every "me" line was bleed — because ASR mangles the
     * second-hand copy. Demanding a match would keep most of what this exists
     * to remove.
     */
    removed++
    return false
  })

  return { segments: kept, removed, nearEndDb, nearEndPresent }
}
