/**
 * Mic capture worklet — runs on the real-time audio render thread.
 *
 * Deliberately plain JavaScript with no imports. AudioWorkletGlobalScope is
 * not the window: there is no DOM, no `fetch`, no module resolution, and the
 * bundler cannot reach in here. Anything this file needs, it defines itself.
 *
 * AudioWorklet rather than ScriptProcessorNode because ScriptProcessorNode
 * runs its callback on the *main* thread. A React re-render or a garbage
 * collection pause then drops audio, and dropped input frames are gone —
 * there is no retry for a microphone.
 *
 * Two jobs, both of which have to happen before the data leaves this thread:
 *
 *  1. Resample the device rate (usually 48 kHz) down to 16 kHz, low-passing
 *     first. Naive decimation folds everything above 8 kHz back into the
 *     speech band as alias noise, which measurably degrades both VAD and ASR
 *     (ARCHITECTURE §3) — and it does so silently, as audio that merely
 *     sounds a bit worse.
 *
 *  2. Batch. `process()` is called every 128 frames — ~2.7 ms at 48 kHz,
 *     ~375 calls/s. Posting each one would swamp the message port with
 *     per-message overhead; throughput is never the problem, message rate is.
 *     We accumulate to CHUNK_MS and post once.
 */

/** Everything downstream (sherpa-onnx, the WAV writer) is 16 kHz mono. */
const TARGET_RATE = 16000

/**
 * Batch size before posting. 40 ms = 25 msg/s/track, comfortably inside the
 * 20–100 ms band in ARCHITECTURE §3, and small enough that the level meter
 * still feels immediate.
 */
const CHUNK_MS = 40
const CHUNK_SAMPLES = (TARGET_RATE * CHUNK_MS) / 1000

/**
 * Half-width of the sinc window, in output samples.
 *
 * 16 taps per side is the usual speech-resampling compromise: stopband
 * rejection is around -60 dB, which puts alias energy below the noise floor
 * of any real microphone, and it costs ~32 multiply-adds per output sample —
 * 512k/s at 16 kHz, nothing on the audio thread.
 */
const FILTER_HALF_WIDTH = 16

/**
 * Windowed-sinc resampler for an arbitrary, non-integer ratio.
 *
 * The ratio must be arbitrary: 44.1 kHz devices exist and 44100/16000 is not
 * an integer, so "take every Nth sample" cannot be made to work even in
 * principle. This evaluates a Blackman-windowed sinc at each fractional
 * output position instead, which combines the anti-alias filter and the rate
 * change into one pass.
 *
 * When downsampling, the sinc is stretched by the ratio so its cutoff sits at
 * the *output* Nyquist rather than the input's — that stretch IS the
 * anti-alias filter. Omitting it is exactly the bug this class exists to
 * avoid.
 */
class SincResampler {
  constructor(inputRate, outputRate) {
    this.ratio = inputRate / outputRate

    // Cutoff relative to the input rate. Downsampling (ratio > 1) needs the
    // filter to close early; upsampling needs no extra band-limiting at all,
    // so the cutoff stays at input Nyquist.
    this.cutoff = this.ratio > 1 ? 1 / this.ratio : 1

    // Kernel support widens with the ratio for the same reason: a lower
    // cutoff means a longer impulse response.
    this.halfWidth = Math.ceil(FILTER_HALF_WIDTH * Math.max(1, this.ratio))

    // Input samples carried across process() calls. The kernel reaches
    // backwards and forwards, so the tail of each block is needed to compute
    // the head of the next. Without this the output has a click every 128
    // frames — audible, and worse, periodic enough to look like real signal.
    this.history = new Float32Array(this.halfWidth * 2 + 2)
    this.historyLength = 0

    // Fractional read position in the (history + current block) stream.
    // Carried across calls so the output rate stays exact over hours rather
    // than drifting a fraction of a sample per block.
    this.position = 0
  }

  /**
   * Resample one block. Returns a newly allocated Float32Array — allocation
   * per block is fine here; it is one small array per 128 frames and the
   * alternative is a ring buffer whose bugs are far more expensive than the
   * GC pressure.
   */
  process(input) {
    const history = this.history
    const historyLength = this.historyLength
    const total = historyLength + input.length

    // Read helper over the concatenated [history, input] stream, so the
    // kernel does not need to know where the block boundary is.
    const at = (i) => {
      if (i < 0 || i >= total) return 0
      return i < historyLength ? history[i] : input[i - historyLength]
    }

    const halfWidth = this.halfWidth
    const cutoff = this.cutoff
    const ratio = this.ratio

    // Only positions whose kernel is fully inside the available data can be
    // computed now; the rest wait for the next block.
    const limit = total - halfWidth
    const out = []

    let position = this.position
    while (position < limit) {
      const centre = Math.floor(position)
      const frac = position - centre

      let sum = 0
      let weight = 0
      for (let k = -halfWidth; k <= halfWidth; k++) {
        const x = k - frac // distance from the output position, in input samples
        const w = blackman(x, halfWidth)
        if (w === 0) continue
        const h = sinc(cutoff * x) * cutoff * w
        sum += at(centre + k) * h
        weight += h
      }

      // Normalise by the realised kernel sum rather than trusting it to be
      // 1. It is not: the window is truncated and sampled at a different
      // fractional offset every output sample, so the raw sum wobbles by a
      // fraction of a dB. Unnormalised, that wobble is amplitude modulation
      // at the beat frequency between the two rates.
      out.push(weight > 0 ? sum / weight : 0)
      position += ratio
    }

    // Retain the tail the next block's kernel will reach back into, and
    // rebase the position onto it.
    const keepFrom = Math.max(0, Math.floor(position) - halfWidth)
    const keep = total - keepFrom
    for (let i = 0; i < keep; i++) history[i] = at(keepFrom + i)
    this.historyLength = keep
    this.position = position - keepFrom

    return Float32Array.from(out)
  }
}

function sinc(x) {
  if (x === 0) return 1
  const pix = Math.PI * x
  return Math.sin(pix) / pix
}

/** Blackman window over [-halfWidth, halfWidth]; zero outside. */
function blackman(x, halfWidth) {
  if (x < -halfWidth || x > halfWidth) return 0
  const t = (x + halfWidth) / (2 * halfWidth)
  return 0.42 - 0.5 * Math.cos(2 * Math.PI * t) + 0.08 * Math.cos(4 * Math.PI * t)
}

class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    // `sampleRate` is a global in AudioWorkletGlobalScope — the context's
    // real rate, which is whatever the device gave us, not what we asked for.
    this.resampler = sampleRate === TARGET_RATE ? null : new SincResampler(sampleRate, TARGET_RATE)

    this.pending = new Float32Array(CHUNK_SAMPLES)
    this.pendingLength = 0
    this.running = true

    this.port.onmessage = (e) => {
      if (e.data === 'flush') this.flush()
      else if (e.data === 'stop') {
        this.flush()
        this.running = false
      }
    }
  }

  /** Post whatever is buffered, even a partial chunk. */
  flush() {
    if (this.pendingLength === 0) return
    const chunk = this.pending.slice(0, this.pendingLength)
    // Transfer rather than copy: the buffer is detached here and adopted by
    // the receiver, so a 40 ms chunk crosses threads without a memcpy.
    this.port.postMessage(chunk, [chunk.buffer])
    this.pendingLength = 0
  }

  process(inputs) {
    if (!this.running) return false

    const channel = inputs[0]?.[0]
    // No input yet is normal, not an error: the graph runs before the device
    // has delivered its first buffer. Returning true keeps the node alive.
    if (!channel || channel.length === 0) return true

    const samples = this.resampler ? this.resampler.process(channel) : channel

    for (let i = 0; i < samples.length; i++) {
      this.pending[this.pendingLength++] = samples[i]
      if (this.pendingLength === CHUNK_SAMPLES) this.flush()
    }

    return true
  }
}

registerProcessor('oratio-capture', CaptureProcessor)
