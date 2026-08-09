import { readFile } from 'node:fs/promises'

/**
 * Read one of our own 16-bit mono WAVs back into samples.
 *
 * Deliberately narrow: it reads the files `wav.ts` writes, not arbitrary WAVs.
 * That is what keeps it twenty lines rather than a dependency — no compressed
 * formats, no 24/32-bit, no multi-channel, no exotic chunk layouts.
 *
 * Not sherpa's `readWave`, even though the ASR worker uses it: sherpa-onnx must
 * never be required outside that worker's wrapper module (CLAUDE.md), because
 * loading a native addon in main is exactly the thing the utilityProcess
 * architecture exists to avoid.
 */

export interface WavData {
  samples: Float32Array
  sampleRate: number
}

/**
 * Chunks are walked rather than assumed to be at fixed offsets.
 *
 * A canonical WAV is `fmt ` then `data`, and ours are — but writers routinely
 * insert `LIST`/`INFO` between them, and an offset-based reader would then
 * read metadata as audio and return noise. Walking is barely more code and
 * cannot make that mistake.
 */
export async function readWav(path: string): Promise<WavData> {
  const buf = await readFile(path)

  if (buf.length < 12 || buf.toString('ascii', 0, 4) !== 'RIFF') {
    throw new Error(`Not a WAV file: ${path}`)
  }

  let sampleRate = 0
  let bitsPerSample = 0
  let channels = 0
  let dataStart = -1
  let dataLength = 0

  let offset = 12
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4)
    const size = buf.readUInt32LE(offset + 4)

    if (id === 'fmt ') {
      channels = buf.readUInt16LE(offset + 10)
      sampleRate = buf.readUInt32LE(offset + 12)
      bitsPerSample = buf.readUInt16LE(offset + 22)
    } else if (id === 'data') {
      dataStart = offset + 8
      dataLength = size
      break
    }

    // Chunks are word-aligned: an odd size is followed by a pad byte that is
    // not counted in the size field. Missing this desynchronises every
    // subsequent chunk.
    offset += 8 + size + (size % 2)
  }

  if (dataStart < 0) throw new Error(`WAV has no data chunk: ${path}`)
  if (bitsPerSample !== 16) {
    throw new Error(`Expected 16-bit WAV, got ${bitsPerSample}-bit: ${path}`)
  }

  /**
   * Trust the file's length over the header's.
   *
   * A recording interrupted by a crash has a header claiming more data than
   * was written — `repairWavHeader` fixes that on the next launch, but this
   * may run on a file it has not reached yet. Taking the minimum means a
   * truncated file reads short instead of running off the end of the buffer.
   */
  const available = Math.min(dataLength, buf.length - dataStart)
  const frames = Math.floor(available / 2)

  const samples = new Float32Array(frames)
  for (let i = 0; i < frames; i++) {
    // Int16 to [-1, 1). 32768 rather than 32767 so the mapping is exact and
    // -1.0 is representable, which is what every audio API expects.
    samples[i] = buf.readInt16LE(dataStart + i * 2) / 32768
  }

  // Mono is an invariant of our own capture, so this is an assertion about our
  // writer rather than a format limitation to handle.
  if (channels !== 1) {
    throw new Error(`Expected mono WAV, got ${channels} channels: ${path}`)
  }

  return { samples, sampleRate }
}

/**
 * Root-mean-square level of a time range, in dBFS.
 *
 * RMS rather than peak because it reflects loudness over the window, and a
 * single transient — a keyboard click, a door — should not make a quiet stretch
 * look loud. Returns `-Infinity` for digital silence, which compares correctly
 * against any threshold without a special case at the call site.
 */
export function rmsDb(
  samples: Float32Array,
  sampleRate: number,
  startMs: number,
  endMs: number,
): number {
  const from = Math.max(0, Math.floor((startMs * sampleRate) / 1000))
  const to = Math.min(samples.length, Math.floor((endMs * sampleRate) / 1000))
  if (to <= from) return -Infinity

  let sum = 0
  for (let i = from; i < to; i++) {
    const v = samples[i] ?? 0
    sum += v * v
  }

  const rms = Math.sqrt(sum / (to - from))
  return rms <= 0 ? -Infinity : 20 * Math.log10(rms)
}

/**
 * Frame size for the level envelope, in samples at 16 kHz — 20 ms.
 *
 * Same value as `energyVad.ts` uses, for the same reason: short enough to track
 * word boundaries, long enough that one transient sample cannot move a frame.
 */
const FRAME = 320

/** RMS per 20 ms frame. */
function envelope(samples: Float32Array, sampleRate: number): Float32Array {
  const frame = Math.max(1, Math.round((FRAME * sampleRate) / 16_000))
  const count = Math.floor(samples.length / frame)
  const out = new Float32Array(count)

  for (let f = 0; f < count; f++) {
    const start = f * frame
    let sum = 0
    for (let i = start; i < start + frame; i++) {
      const s = samples[i] ?? 0
      sum += s * s
    }
    out[f] = Math.sqrt(sum / frame)
  }

  return out
}

/** Percentile of the non-zero entries, in dB. `-Infinity` if there are none. */
function activePercentileDb(env: Float32Array, pct: number): number {
  const active = Array.from(env).filter((v) => v > 0).sort((a, b) => a - b)
  if (active.length === 0) return -Infinity

  const v = active[Math.min(active.length - 1, Math.floor(active.length * pct))] ?? 0
  return v <= 0 ? -Infinity : 20 * Math.log10(v)
}

export interface TrackGains {
  /**
   * The loudest the mic gets while the system track is quiet, relative to the
   * system track's own speech level, in dB.
   *
   * This is a statement about the RECORDING, not about any one segment: it
   * answers "does this microphone ever hear anything that is not also on the
   * system track". A mic with a person in front of it does. A mic that is only
   * catching room echo of the far end does not, because its loudest moments
   * coincide with the system track rather than with the gaps.
   */
  micRelativeDb: number
  /** How much of the track had the system side quiet enough to calibrate on. */
  soloFraction: number
}

/**
 * Decide whether the microphone was ever hearing anything of its own, by
 * measuring it only where the system track is silent.
 *
 * ## Why this exists
 *
 * The bleed detector used to compare raw dB between the two tracks and call a
 * mic segment bleed when it sat 20 dB below the system track. That number is
 * not measuring bleed. On the W1 recording — a headset, no acoustic path, no
 * bleed possible — the raw gap is -20.5 dB and the detector deleted the user's
 * only line. Measured on the same file, the channel gain difference alone
 * accounts for -19.8 dB of that, leaving a true gap of -0.7 dB. The threshold
 * was reading the difference between a pre-mixer digital tap running near full
 * scale and an acoustic mic across a room, which is present in every recording
 * whether or not anyone is speaking.
 *
 * Pfau, Ellis & Stolcke (ASRU 2001) hit the same problem on the ICSI corpus and
 * fixed it by normalizing each channel before comparing — worth 26.4% relative
 * frame-error on its own, more than their cross-correlation stage added. They
 * subtract each channel's MINIMUM frame energy as a noise-floor estimate.
 *
 * ## Two corrections to that recipe, both measured here
 *
 * Their estimator does not transfer directly, because their channels are all
 * microphones and one of ours is not:
 *
 *   1. **A digital tap has no noise floor.** 13.7% of the system track's frames
 *      are exactly zero — it idles at digital silence, not at room tone. The
 *      minimum frame energy is 0 and the subtraction is undefined. A percentile
 *      of the ACTIVE frames is the workable reference.
 *   2. **Normalizing each track by its own speech level cannot work.** It is
 *      circular: if the mic contains only bleed, then the mic's own speech level
 *      IS the bleed level, so the ratio is ~1 by construction. Measured, this
 *      collapses the classes completely — simulated bleed from -20 dB to -45 dB
 *      all normalized to +0.4 dB, against -0.7 dB for genuine near-end speech.
 *      Unusable.
 *
 * So the measurement is taken on SOLO frames: the stretches where the system
 * track is quiet, and the mic therefore has nothing to bleed from. Whatever the
 * mic picks up there is genuine — near-end speech, or that mic's noise floor —
 * which makes it a measurement of the device rather than of the mixture.
 *
 * Measured on the W1 fixture, mic-versus-system at the 90th percentile of solo
 * frames:
 *
 *   real near-end speech (headset)   -25.7 dB
 *   simulated bleed, -15 dB path     -45.6 dB
 *   simulated bleed, -27 dB path     -51.3 dB
 *   simulated bleed, -36 dB path     -51.7 dB
 *
 * Roughly 20 dB of separation, and it saturates: past about -20 dB of acoustic
 * attenuation the mic hears its own noise floor rather than the room, so every
 * worse case looks the same. That flatness is what makes a threshold safe here.
 *
 * ## A third correction: this is a GATE, not a normalizer
 *
 * The obvious use of a per-channel gain figure is to subtract it from each
 * segment's raw gap. That was tried and it is wrong, which is worth recording
 * because the reasoning is seductive and the failure is silent.
 *
 * The quantity above tracks the very thing being detected: when the mic contains
 * only bleed, this measures the mic's NOISE FLOOR, not its speech level, so
 * subtracting it inflates exactly the segments that should be suppressed.
 * Measured on the same fixture, per-segment gaps after such a subtraction came
 * out at +5.4 dB for genuine headset speech against +30.6, +24.4 and +16.1 dB
 * for bleed at -15, -27 and -36 dB. The ordering INVERTS, so no threshold on
 * that quantity can separate the classes — the detector either fires on
 * everything or nothing.
 *
 * Used as a gate it works, because the question it can answer is about the
 * recording rather than the segment: if the mic never rises above the system
 * track's level during the gaps, there is no near-end source and mic segments
 * overlapping far-end speech are bleed. If it does, there is a person there and
 * their quiet moments must not be deleted on a level argument.
 */
export function measureTrackGains(mic: WavData, system: WavData): TrackGains {
  const micEnv = envelope(mic.samples, mic.sampleRate)
  const sysEnv = envelope(system.samples, system.sampleRate)
  const frames = Math.min(micEnv.length, sysEnv.length)
  if (frames === 0) return { micRelativeDb: 0, soloFraction: 0 }

  /*
   * "Quiet" on the system side is that track's own low percentile rather than a
   * constant. A tap that idles at exact zero and one carrying faint room tone
   * from a conference app need the same treatment, and only a relative measure
   * gives it to them.
   *
   * Being relative, it degrades safely on far-end audio that never pauses: with
   * no genuine gaps, loud frames get counted as solo, the mic looks louder than
   * it is, and the caller concludes there IS a near-end speaker. Measured on a
   * constant tone the gate reads -27 dB against -51 dB for the same bleed over
   * real far-end audio. That errs toward keeping mic segments, which is the
   * direction to fail in — an undeleted bleed line is visible and recoverable,
   * a deleted sentence of the user's own speech is neither.
   */
  const sysQuietDb = activePercentileDb(sysEnv.subarray(0, frames), 0.2)
  const sysQuiet = sysQuietDb === -Infinity ? 0 : 10 ** (sysQuietDb / 20)

  const solo: number[] = []
  for (let f = 0; f < frames; f++) {
    if ((sysEnv[f] ?? 0) <= Math.max(sysQuiet, 1e-5)) solo.push(micEnv[f] ?? 0)
  }

  const soloFraction = solo.length / frames

  /*
   * Too little solo audio to calibrate on. Happens when the far end never stops
   * talking, and it must fail OPEN — reporting 0 dB means "no measured gain
   * difference", which makes the caller's threshold unreachable and leaves the
   * transcript untouched. Deleting the user's speech on an unmeasured guess is
   * the failure this whole function exists to prevent.
   */
  const MIN_SOLO_FRAMES = 25 // 0.5 s
  if (solo.length < MIN_SOLO_FRAMES) return { micRelativeDb: 0, soloFraction }

  const micDb = activePercentileDb(Float32Array.from(solo), 0.9)
  const sysDb = activePercentileDb(sysEnv.subarray(0, frames), 0.95)
  if (micDb === -Infinity || sysDb === -Infinity) {
    return { micRelativeDb: 0, soloFraction }
  }

  return { micRelativeDb: micDb - sysDb, soloFraction }
}
