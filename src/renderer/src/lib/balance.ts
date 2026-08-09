/**
 * Level-match the two tracks for playback.
 *
 * The tracks are captured by completely different means and arrive at very
 * different levels: the system track is a pre-mixer digital tap running near
 * full scale, while the mic is an acoustic capture that has been through a room.
 * Mixed raw, the far end drowns the near-end speaker out. Measured on two
 * recordings of the same setup:
 *
 *   built-in mic + speakers   mic -37.5 dB   system -19.1 dB   gap 18.4 dB
 *   headset                   mic -45.9 dB   system -18.9 dB   gap 27.0 dB
 *
 * **The gap is device-dependent, so a fixed gain cannot be right.** It is nearly
 * 9 dB wider on the headset — a constant tuned for one is visibly wrong on the
 * other, which is why this measures each session instead.
 *
 * Deliberately NOT reusing `measureTrackGains` from the main process. That
 * measures the mic during the far end's PAUSES, which is the bleed gate — a
 * different question. On a built-in-mic recording it largely reflects bleed
 * rather than the user's voice, so using it here would under-boost precisely the
 * case that needs the most help.
 *
 * This runs in the renderer on already-decoded audio, so it needs no new IPC and
 * no change to what is stored on disk. Playback gain is a presentation concern;
 * the files are never modified.
 */

/** 20 ms at any sample rate — matches the framing used elsewhere. */
const FRAME_MS = 20

/**
 * How far below a track's own loudest frames a frame may sit and still count as
 * speech.
 *
 * Speech has a wide short-term range — stops and unvoiced consonants fall well
 * below the vowels around them — so this has to be generous enough to keep whole
 * words rather than only their peaks. 25 dB keeps the body of an utterance while
 * excluding a mic's noise floor, which on the measured headset sits 29 dB below
 * its speech.
 */
const SPEECH_FLOOR_DB = 25

/**
 * Median level of the frames in which someone is actually SPEAKING.
 *
 * A plain percentile of the whole track cannot work here, and this is the second
 * bug it caused. A percentile measures a different thing on each device
 * depending on how much of the track is silence: on the measured headset the
 * mic's p50 is its noise floor (-74.9 dB) while its p90 is speech (-45.9 dB),
 * because it is quiet between utterances. On a built-in mic, which records the
 * room continuously, p50 and p90 are both speech-ish and 19 dB apart.
 *
 * Matching two tracks at p90 therefore matched them only at their loudest
 * moments, leaving the far end 19.4 dB too loud through the rest of a headset
 * recording — audibly wrong, and the reason this now gates first.
 *
 * So: find the track's own loud end, keep everything within `SPEECH_FLOOR_DB` of
 * it, and take the median of that. The result means the same thing on both
 * devices — "how loud is this person while talking" — which is the only
 * quantity worth equalising.
 */
function speechLevel(buffer: AudioBuffer): number {
  const data = buffer.getChannelData(0)
  const frame = Math.max(1, Math.round((buffer.sampleRate * FRAME_MS) / 1000))
  const active: number[] = []

  for (let start = 0; start + frame <= data.length; start += frame) {
    let sum = 0
    for (let i = start; i < start + frame; i++) {
      const v = data[i] ?? 0
      sum += v * v
    }
    const rms = Math.sqrt(sum / frame)
    // Zero frames are excluded because a digital tap idles at true silence —
    // measured, 13.7% of its frames are exactly zero.
    if (rms > 0) active.push(rms)
  }

  if (active.length === 0) return 0
  active.sort((a, b) => a - b)

  // The loud end, taken as a high percentile rather than the maximum so one
  // transient — a cough, a click — cannot set the reference for the whole track.
  const loud = active[Math.min(active.length - 1, Math.floor(active.length * 0.95))] ?? 0
  if (loud <= 0) return 0

  const floor = loud * 10 ** (-SPEECH_FLOOR_DB / 20)
  const speech = active.filter((v) => v >= floor)
  if (speech.length === 0) return loud

  return speech[Math.floor(speech.length / 2)] ?? loud
}

/**
 * Floor on how far the louder track may be turned down.
 *
 * The measured gaps are 18.4 and 27.0 dB, needing attenuation to 0.121 and
 * 0.045 — so the range must be generous. But a mic track that is nearly silent
 * for a bad reason (wrong input selected, a dead microphone) would otherwise
 * drag the far end down to inaudibility in sympathy, turning one broken track
 * into two. -35 dB is past the widest real gap measured and still audible.
 */
const MIN_VOLUME = 0.018

export interface Balance {
  /** Playback volume for the mic element, 0..1. */
  mic: number
  /** Playback volume for the system element, 0..1. */
  system: number
  /** How much louder the system track was, in dB. 0 when not measurable. */
  gapDb: number
}

/** Even balance — the safe result whenever a track cannot be measured. */
const NEUTRAL: Balance = { mic: 1, system: 1, gapDb: 0 }

/**
 * Work out playback volumes that put the two tracks at a comparable level.
 *
 * **Attenuates the louder track rather than boosting the quieter one**, which is
 * the worse of the two corrections and is chosen for a hard reason: raising the
 * quiet track requires a gain above 1, `HTMLMediaElement.volume` is capped at
 * 1.0, and the WebAudio graph that could express it silences playback outright
 * in this renderer (see `TranscriptView` for the measurements).
 *
 * The cost is that the whole mix ends up at the quieter track's level — around
 * -46 dBFS on a headset recording — so the user raises their system volume.
 * Known, and preferable to silence.
 *
 * Never clips, since nothing is ever amplified. Fails to `NEUTRAL` whenever
 * either track is missing or silent: an unmeasured guess is worse than leaving
 * the volume alone.
 */
export function computeBalance(
  mic: AudioBuffer | null,
  system: AudioBuffer | null,
): Balance {
  if (!mic || !system) return NEUTRAL

  const micLevel = speechLevel(mic)
  const systemLevel = speechLevel(system)
  if (micLevel <= 0 || systemLevel <= 0) return NEUTRAL

  const gapDb = 20 * Math.log10(systemLevel / micLevel)
  const quieter = Math.min(micLevel, systemLevel)

  // Each track is brought down to the quieter one's level; the quieter track
  // itself lands on 1.0 and is left alone.
  const volume = (level: number): number =>
    Math.min(1, Math.max(MIN_VOLUME, quieter / level))

  return { mic: volume(micLevel), system: volume(systemLevel), gapDb }
}
