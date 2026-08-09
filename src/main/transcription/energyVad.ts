/**
 * Energy-based voice-activity detection — the fallback for machines that
 * cannot run onnxruntime at all.
 *
 * Silero VAD is an ONNX model, so on a CPU without AVX2 it does not merely
 * perform badly, it kills the process during thread-pool init (see
 * cpuFeatures.ts). That leaves two options on such a machine: skip VAD, or
 * detect speech without a neural net.
 *
 * **Skipping is not an option** — VAD-before-ASR is an invariant, and it is one
 * for a concrete reason: Whisper-family models hallucinate confidently on
 * silence, and a system-audio tap is mostly silence. Feeding a whole track to
 * ASR fills the transcript with invented text and makes the product look
 * broken. So the fallback is worse detection, never absent detection.
 *
 * This is pure arithmetic over the samples: no model, no native code, no
 * onnxruntime. It cannot hit the crash it exists to avoid.
 *
 * It is genuinely less accurate than Silero — it keys on loudness, so it keeps
 * loud non-speech (a door, keyboard noise, music) and can drop very quiet
 * speech. That trade is correct here: a transcript with some spurious regions
 * is recoverable, a crash at recording start is not. The UI labels the
 * degradation rather than hiding it.
 */

import { DEFAULT_VAD_OPTIONS } from './vad'

/** Matches the sherpa path: sample offsets, not seconds. */
export interface EnergyRegion {
  startSample: number
  samples: Float32Array
}

/**
 * Frame size for the energy envelope, in samples at 16 kHz — 20 ms.
 *
 * Short enough to catch word boundaries, long enough that a single loud sample
 * cannot open a region on its own.
 */
const FRAME = 320

/**
 * Speech is detected relative to the track's own noise floor, not against a
 * fixed threshold.
 *
 * An absolute cutoff cannot work across the two tracks this app records: a
 * system-audio tap is pre-mixer and often near full scale, while a laptop mic
 * three feet away is far quieter. One constant would either miss the mic
 * entirely or treat the tap's noise floor as continuous speech. Deriving the
 * floor per track makes the detector self-calibrating.
 */
const SPEECH_FLOOR_MULTIPLE = 3.0

/**
 * Absolute floor, below which nothing counts as speech regardless of the
 * noise estimate.
 *
 * Without it, a digitally silent track has a noise floor of ~0 and *every*
 * frame clears `floor * 3`, so the entire track is returned as speech — which
 * is the exact failure this module exists to prevent, arrived at from the other
 * direction. A dead track must yield no regions.
 */
const ABSOLUTE_FLOOR = 1e-4

/**
 * Detect speech regions by energy.
 *
 * Deliberately mirrors the shape of `SherpaSession.detectSpeech` so the two are
 * interchangeable at the call site and the caller never branches on which ran.
 */
export function detectSpeechByEnergy(
  samples: Float32Array,
  sampleRate: number,
): EnergyRegion[] {
  if (samples.length === 0) return []

  // RMS per frame. RMS rather than peak: peak is dominated by transient clicks,
  // which is what makes a peak-based detector fire on keyboard noise.
  const frameCount = Math.ceil(samples.length / FRAME)
  const energy = new Float32Array(frameCount)
  for (let f = 0; f < frameCount; f++) {
    const start = f * FRAME
    const end = Math.min(start + FRAME, samples.length)
    let sum = 0
    for (let i = start; i < end; i++) {
      const s = samples[i]!
      sum += s * s
    }
    energy[f] = Math.sqrt(sum / (end - start))
  }

  const threshold = Math.max(noiseFloor(energy) * SPEECH_FLOOR_MULTIPLE, ABSOLUTE_FLOOR)

  /*
   * Hysteresis, expressed in frames.
   *
   * `minSilenceDurationMs` is what stops a natural mid-sentence pause from
   * splitting one utterance into two — the same reason the Silero config sets
   * it. Reusing DEFAULT_VAD_OPTIONS keeps the two detectors behaving
   * consistently where they can, so switching paths changes accuracy but not
   * segmentation style.
   */
  const msToFrames = (ms: number): number => Math.max(1, Math.round((ms * sampleRate) / 1000 / FRAME))
  const minSpeechFrames = msToFrames(DEFAULT_VAD_OPTIONS.minSpeechDurationMs)
  const minSilenceFrames = msToFrames(DEFAULT_VAD_OPTIONS.minSilenceDurationMs)
  const padFrames = msToFrames(DEFAULT_VAD_OPTIONS.speechPadMs)

  // Walk the envelope, closing a region only after enough consecutive quiet
  // frames to count as a real pause.
  const spans: Array<{ start: number; end: number }> = []
  let spanStart = -1
  let quietRun = 0

  for (let f = 0; f < frameCount; f++) {
    const loud = energy[f]! >= threshold
    if (loud) {
      if (spanStart < 0) spanStart = f
      quietRun = 0
    } else if (spanStart >= 0) {
      quietRun++
      if (quietRun >= minSilenceFrames) {
        spans.push({ start: spanStart, end: f - quietRun + 1 })
        spanStart = -1
        quietRun = 0
      }
    }
  }
  // Speech still open when the audio ends. Without this the last utterance of a
  // meeting is discarded — the same trap `vad.flush()` exists for on the sherpa
  // path.
  if (spanStart >= 0) spans.push({ start: spanStart, end: frameCount })

  const out: EnergyRegion[] = []
  for (const span of spans) {
    if (span.end - span.start < minSpeechFrames) continue

    // Pad so word onsets and tails are not clipped; ASR accuracy drops
    // noticeably without it.
    const startFrame = Math.max(0, span.start - padFrames)
    const endFrame = Math.min(frameCount, span.end + padFrames)

    const startSample = startFrame * FRAME
    const endSample = Math.min(endFrame * FRAME, samples.length)
    out.push({ startSample, samples: samples.subarray(startSample, endSample) })
  }

  /*
   * Split AFTER merging, never before.
   *
   * `mergeOverlapping` joins any two regions that touch, and padding makes the
   * halves of a fresh cut overlap by construction — so splitting first produces
   * regions that are immediately glued back together, silently restoring the
   * over-long region this is meant to prevent. Enforcing the cap last is what
   * makes it an actual guarantee rather than a suggestion.
   */
  return splitLongRegions(
    mergeOverlapping(out, samples),
    samples,
    energy,
    msToFrames(DEFAULT_VAD_OPTIONS.maxSpeechDurationMs),
    minSpeechFrames,
  )
}

/**
 * Break regions longer than the cap, cutting at their quietest frame.
 *
 * Exists so this detector shares the sherpa path's ordering unit. Without it a
 * continuously-talking far end becomes one region covering the whole recording,
 * and an interjection can only ever sort after it — report A, in the fallback
 * path (see `MAX_SPEECH_DURATION_MS` in `vad.ts` for the full derivation).
 *
 * Cutting at the quietest frame rather than exactly at the cap is the same
 * choice Silero makes internally, and it is what keeps the seam off the middle
 * of a word. This detector can be more careful about it than sherpa's binding
 * allows, because the frame energies are right here: the search is restricted to
 * the last third of the allowed window, so the cut is late enough to keep
 * regions near their full length and still free to move to a real pause.
 *
 * Unlike the region builder above, the halves are NOT padded. A cut is a
 * boundary this function invented rather than one the audio contains, so
 * padding it would overlap the two halves — and `mergeOverlapping` would then
 * join them straight back together.
 */
function splitLongRegions(
  regions: EnergyRegion[],
  source: Float32Array,
  energy: Float32Array,
  maxFrames: number,
  minFrames: number,
): EnergyRegion[] {
  const maxSamples = maxFrames * FRAME
  const out: EnergyRegion[] = []

  for (const region of regions) {
    let start = region.startSample
    const end = start + region.samples.length

    while (end - start > maxSamples) {
      // Never cut so early that the piece left behind is below the minimum
      // region length — that would trade one over-long region for a sliver.
      const from = Math.max(start + minFrames * FRAME, start + Math.floor(maxSamples * 0.67))
      const to = start + maxSamples

      // Guaranteed by the loop condition, but the cap is only a real guarantee
      // if this cannot silently fall through and emit the whole region.
      if (to <= from) break

      let cut = from
      let quietest = Infinity
      for (let s = from; s < to; s += FRAME) {
        const e = energy[Math.floor(s / FRAME)] ?? 0
        if (e < quietest) {
          quietest = e
          cut = s
        }
      }

      out.push({ startSample: start, samples: source.subarray(start, cut) })
      start = cut
    }

    out.push({ startSample: start, samples: source.subarray(start, end) })
  }

  return out
}

/**
 * Estimate the noise floor as the 10th percentile of frame energy.
 *
 * The median would sit inside speech on a track that is mostly talking; the
 * minimum is a single unrepresentative frame. The 10th percentile is low enough
 * to land in genuine background on a busy track and stable enough not to chase
 * one quiet outlier.
 */
function noiseFloor(energy: Float32Array): number {
  const sorted = Float32Array.from(energy).sort()
  return sorted[Math.floor(sorted.length * 0.1)] ?? 0
}

/**
 * Padding can push two neighbouring regions into each other. Overlapping
 * regions would transcribe the same words twice and produce duplicated text in
 * the merged transcript, so they are joined back into one.
 */
function mergeOverlapping(regions: EnergyRegion[], source: Float32Array): EnergyRegion[] {
  if (regions.length <= 1) return regions

  const merged: EnergyRegion[] = []
  let current = regions[0]!

  for (let i = 1; i < regions.length; i++) {
    const next = regions[i]!
    const currentEnd = current.startSample + current.samples.length
    if (next.startSample <= currentEnd) {
      const end = Math.max(currentEnd, next.startSample + next.samples.length)
      current = {
        startSample: current.startSample,
        samples: source.subarray(current.startSample, end),
      }
    } else {
      merged.push(current)
      current = next
    }
  }
  merged.push(current)

  return merged
}
