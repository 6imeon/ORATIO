import { EventEmitter } from 'node:events'
import { createWriteStream, type WriteStream } from 'node:fs'
import { AudioTee } from 'audiotee'
import log from 'electron-log/main'
import {
  TARGET_SAMPLE_RATE,
  LIVENESS_CHECK_MS,
  type AudioCapture,
  type CaptureOptions,
  type CaptureResult,
  type TrackResult,
} from './AudioCapture'
import { writeWavHeader, finalizeWavHeader } from './wav'

/**
 * macOS capture: AudioTee for system audio, getUserMedia (renderer) for mic.
 *
 * System audio goes through AudioTee — a small Swift binary wrapping the
 * Core Audio process-tap API (macOS 14.2+). Chosen over Electron's
 * desktopCapturer because taps:
 *   - need only the "System Audio Recording" permission, not the much
 *     scarier "Screen & System Audio Recording"
 *   - do not light the purple screen-recording indicator
 *   - capture PRE-mixer, so turning the speakers down does not quieten
 *     the recording
 *
 * The mic arrives as PCM pushed from the renderer via `pushMicPcm`, already
 * mono 16 kHz — the renderer's AudioWorklet does that conversion so this side
 * never sees a device format. Keeping mic capture in the renderer avoids a
 * second native dependency; if echo bleed becomes a problem this is where
 * voice processing would be added (see quill's rca-001 for how badly that can
 * fail).
 *
 * The two tracks are written to SEPARATE files and never mixed. That split
 * is what gives speaker attribution for free.
 */
export class MacAudioCapture extends EventEmitter implements AudioCapture {
  readonly platform = 'darwin' as const

  #tee: AudioTee | null = null
  #recording = false

  #mic: TrackWriter | null = null
  #system: TrackWriter | null = null

  /**
   * Fires once per track, LIVENESS_CHECK_MS after start. Cleared on stop so a
   * short recording does not report a dead mic after the fact.
   */
  #livenessTimer: ReturnType<typeof setTimeout> | null = null

  isRecording(): boolean {
    return this.#recording
  }

  async start(opts: CaptureOptions): Promise<void> {
    if (this.#recording) return

    this.#mic = new TrackWriter(opts.micPath)
    this.#system = new TrackWriter(opts.systemPath)

    // Ask AudioTee for exactly the format sherpa-onnx wants, so no
    // resampling is needed anywhere downstream.
    this.#tee = new AudioTee({ sampleRate: TARGET_SAMPLE_RATE })

    let formatChecked = false

    this.#tee.on('data', (chunk: { data: Buffer }) => {
      const samples = toFloat32(chunk.data)

      // Sample values live in -1..1 by definition. Anything outside it means
      // the byte format is being misread — which is exactly what happened
      // when this decoded Int16 as Float32 and produced peaks near 1e38.
      // Checked once per recording rather than per buffer: the format cannot
      // change mid-stream, and this must not cost anything in the hot path.
      if (!formatChecked && samples.length > 0) {
        formatChecked = true
        let max = 0
        for (let i = 0; i < samples.length; i++) max = Math.max(max, Math.abs(samples[i]!))
        if (max > 1.001) {
          const err = new Error(
            `system audio sample values out of range (peak ${max.toExponential(2)}) — ` +
              'AudioTee is not emitting the expected 16-bit PCM',
          )
          log.error('[audio]', err)
          this.emit('error', err)
        }
      }

      const peak = this.#system!.write(samples)
      this.emit('level', 'system', peak)
      this.emit('pcm', 'system', samples)
    })

    this.#tee.on('error', (err: Error) => {
      log.error('[audio] system capture error', err)
      this.emit('error', err)
    })

    this.#tee.on('log', (msg: unknown) => log.debug('[audiotee]', msg))

    await this.#tee.start()
    this.#recording = true
    this.#startLivenessCheck()
    log.info('[audio] capture started')
  }

  /**
   * Detect the silent-success failure mode.
   *
   * A missing `com.apple.security.device.audio-input` entitlement on a helper
   * binary, a tap-only aggregate device, or an unsupported voice-processing
   * route all return SUCCESS and then deliver zeroes forever. A real
   * microphone always has a noise floor, so an *exactly* zero peak after
   * three seconds means the capture is dead, not quiet.
   *
   * Reported, not repaired: the recording is already running and tearing it
   * down automatically would lose whatever the other track is capturing
   * correctly. The controller decides what to do (phase 4).
   */
  #startLivenessCheck(): void {
    this.#livenessTimer = setTimeout(() => {
      if (!this.#recording) return
      for (const [name, track] of [
        ['mic', this.#mic],
        ['system', this.#system],
      ] as const) {
        if (track && track.peak === 0) {
          log.warn(`[audio] ${name} track is digitally silent after ${LIVENESS_CHECK_MS}ms`)
          this.emit('dead', name)
        }
      }
    }, LIVENESS_CHECK_MS)
  }

  /**
   * Mic PCM from the renderer. Expected mono Float32 at TARGET_SAMPLE_RATE —
   * the renderer's AudioWorklet is responsible for that conversion.
   */
  pushMicPcm(samples: Float32Array): void {
    if (!this.#recording || !this.#mic) return
    const peak = this.#mic.write(samples)
    this.emit('level', 'mic', peak)
    this.emit('pcm', 'mic', samples)
  }

  /**
   * The renderer lost and rebuilt its audio graph — a device rate change.
   * Marks the gap so the merged timeline does not treat the two halves as
   * contiguous.
   */
  noteMicDiscontinuity(): void {
    this.#mic?.markDiscontinuity()
  }

  /** The renderer stopped capturing. Main may still be writing system audio. */
  noteMicEnded(): void {
    log.info('[audio] mic track ended', { peak: this.#mic?.peak })
  }

  /**
   * Called on `powerMonitor` suspend. The event loop is about to freeze, so
   * both tracks will have a hole in them that no sample count can reveal
   * afterwards — it has to be recorded at the moment it happens.
   */
  noteSuspend(): void {
    this.#mic?.markDiscontinuity()
    this.#system?.markDiscontinuity()
    log.warn('[audio] system suspended mid-recording; both tracks marked')
  }

  async stop(): Promise<CaptureResult> {
    if (!this.#recording) throw new Error('not recording')
    this.#recording = false

    if (this.#livenessTimer) {
      clearTimeout(this.#livenessTimer)
      this.#livenessTimer = null
    }

    try {
      await this.#tee?.stop()
    } catch (err) {
      log.warn('[audio] error stopping system capture', err)
    }
    this.#tee = null

    const [mic, system] = await Promise.all([this.#mic!.close(), this.#system!.close()])
    this.#mic = null
    this.#system = null

    log.info('[audio] capture stopped', {
      micPeak: mic.peak,
      systemPeak: system.peak,
      micSeconds: mic.samples / TARGET_SAMPLE_RATE,
      systemSeconds: system.samples / TARGET_SAMPLE_RATE,
    })

    return { mic, system }
  }
}

/**
 * How often the RIFF sizes are patched while recording continues.
 *
 * The header is rewritten periodically rather than only at stop, so a crash
 * or a force-quit leaves a *playable* file truncated to the last patch rather
 * than one every tool reports as zero-length (ARCHITECTURE §3). 30 s is the
 * most anyone loses, at the cost of one 8-byte write.
 */
const HEADER_PATCH_INTERVAL_MS = 30_000

/**
 * Streams Float32 PCM to a WAV file, tracking the first-buffer timestamp and
 * peak amplitude.
 *
 * WAV rather than a compressed container for the same reason quill picked
 * CAF over m4a: the header is patched on clean close, but every sample
 * already written stays readable if the process dies mid-meeting. A partially
 * written m4a is worthless.
 */
class TrackWriter {
  readonly #path: string
  #stream: WriteStream
  #firstBufferAt: number | null = null
  #peak = 0
  #bytes = 0
  #samples = 0
  #discontinuities: number[] = []

  /** Set when the stream asks us to stop writing; cleared on 'drain'. */
  #backpressured = false
  #droppedWhileBackpressured = 0

  #lastPatchAt = 0
  #patching = false

  constructor(path: string) {
    this.#path = path
    this.#stream = createWriteStream(path)
    writeWavHeader(this.#stream, { sampleRate: TARGET_SAMPLE_RATE, channels: 1 })

    this.#stream.on('drain', () => {
      if (this.#droppedWhileBackpressured > 0) {
        log.warn('[audio] resumed after backpressure', {
          path,
          droppedBuffers: this.#droppedWhileBackpressured,
        })
        this.#droppedWhileBackpressured = 0
      }
      this.#backpressured = false
    })
  }

  get peak(): number {
    return this.#peak
  }

  /** Mark a gap at the current position. */
  markDiscontinuity(): void {
    this.#discontinuities.push(Math.round((this.#samples / TARGET_SAMPLE_RATE) * 1000))
  }

  /** Returns the peak of this buffer, 0..1. */
  write(samples: Float32Array): number {
    if (this.#firstBufferAt === null) {
      this.#firstBufferAt = Date.now()
      this.#lastPatchAt = this.#firstBufferAt
    }

    let bufPeak = 0
    for (let i = 0; i < samples.length; i++) {
      const a = Math.abs(samples[i]!)
      if (a > bufPeak) bufPeak = a
    }
    if (bufPeak > this.#peak) this.#peak = bufPeak

    // Backpressure: `highWaterMark` is a threshold, not a limit — Node will
    // happily buffer past it, and the docs are explicit that ignoring it
    // produces "high RSS which is not typically released back to the system".
    // A 2-hour meeting behind a slow disk is exactly that case. Dropping a
    // buffer costs 40 ms of audio; the alternative costs the whole session.
    if (this.#backpressured) {
      this.#droppedWhileBackpressured++
      // Still count them, so the timeline does not silently compress.
      this.#samples += samples.length
      this.markDiscontinuityOnce()
      return bufPeak
    }

    // 16-bit PCM on disk: half the size of Float32 at no meaningful quality
    // cost for speech, and universally playable.
    const pcm16 = Buffer.allocUnsafe(samples.length * 2)
    for (let i = 0; i < samples.length; i++) {
      const clamped = Math.max(-1, Math.min(1, samples[i]!))
      pcm16.writeInt16LE(Math.round(clamped * 32767), i * 2)
    }

    if (!this.#stream.write(pcm16)) this.#backpressured = true
    this.#bytes += pcm16.length
    this.#samples += samples.length

    this.#maybePatchHeader()
    return bufPeak
  }

  /** One discontinuity per backpressure episode, not one per dropped buffer. */
  private markDiscontinuityOnce(): void {
    if (this.#droppedWhileBackpressured === 1) this.markDiscontinuity()
  }

  /**
   * Patch the RIFF sizes in place while still recording.
   *
   * Uses a separate file handle at a fixed offset, so it never interleaves
   * with the append stream — the two touch disjoint byte ranges. Guarded by
   * `#patching` because a slow disk could otherwise start a second patch
   * before the first finished.
   */
  #maybePatchHeader(): void {
    const now = Date.now()
    if (this.#patching || now - this.#lastPatchAt < HEADER_PATCH_INTERVAL_MS) return

    this.#lastPatchAt = now
    this.#patching = true
    const bytes = this.#bytes

    void finalizeWavHeader(this.#path, bytes)
      .catch((err) => log.warn('[audio] periodic header patch failed', err))
      .finally(() => {
        this.#patching = false
      })
  }

  async close(): Promise<TrackResult> {
    await new Promise<void>((resolve) => this.#stream.end(resolve))
    await finalizeWavHeader(this.#path, this.#bytes)
    return {
      path: this.#path,
      firstBufferAt: this.#firstBufferAt,
      peak: this.#peak,
      bytesWritten: this.#bytes,
      samples: this.#samples,
      discontinuities: this.#discontinuities,
    }
  }
}

/**
 * AudioTee hands us little-endian **Int16** bytes, not Float32.
 *
 * Its README is explicit: "Specifying _any_ sample rate automatically
 * switches encoding to use 16-bit signed integers". We always pass
 * `sampleRate: 16000` to get the rate sherpa wants, so the stream is always
 * Int16 — the 32-bit float form only appears if the rate is left unset.
 *
 * Read as Float32 instead, the bytes decode to values around 1e38 and the
 * whole system track is noise. It still produces a plausible-looking WAV of
 * the right length, which is why this survived: the only visible symptom was
 * a peak amplitude far outside 0..1.
 */
function toFloat32(buf: Buffer): Float32Array {
  const out = new Float32Array(buf.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = buf.readInt16LE(i * 2) / 32768
  return out
}
