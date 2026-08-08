import { EventEmitter } from 'node:events'
import { createWriteStream, type WriteStream } from 'node:fs'
import { AudioTee } from 'audiotee'
import log from 'electron-log/main'
import {
  TARGET_SAMPLE_RATE,
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
 * The mic arrives as PCM pushed from the renderer via `pushMicPcm`. Keeping
 * mic capture in the renderer avoids a second native dependency; if echo
 * bleed becomes a problem this is where voice processing would be added
 * (see quill's rca-001 for how badly that can fail).
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

    this.#tee.on('data', (chunk: { data: Buffer }) => {
      const samples = toFloat32(chunk.data)
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
    log.info('[audio] capture started')
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

  async stop(): Promise<CaptureResult> {
    if (!this.#recording) throw new Error('not recording')
    this.#recording = false

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
      micBytes: mic.bytesWritten,
      systemBytes: system.bytesWritten,
    })

    return { mic, system }
  }
}

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

  constructor(path: string) {
    this.#path = path
    this.#stream = createWriteStream(path)
    writeWavHeader(this.#stream, { sampleRate: TARGET_SAMPLE_RATE, channels: 1 })
  }

  /** Returns the peak of this buffer, 0..1. */
  write(samples: Float32Array): number {
    if (this.#firstBufferAt === null) this.#firstBufferAt = Date.now()

    let bufPeak = 0
    for (let i = 0; i < samples.length; i++) {
      const a = Math.abs(samples[i]!)
      if (a > bufPeak) bufPeak = a
    }
    if (bufPeak > this.#peak) this.#peak = bufPeak

    // 16-bit PCM on disk: half the size of Float32 at no meaningful quality
    // cost for speech, and universally playable.
    const pcm16 = Buffer.allocUnsafe(samples.length * 2)
    for (let i = 0; i < samples.length; i++) {
      const clamped = Math.max(-1, Math.min(1, samples[i]!))
      pcm16.writeInt16LE(Math.round(clamped * 32767), i * 2)
    }
    this.#stream.write(pcm16)
    this.#bytes += pcm16.length

    return bufPeak
  }

  async close(): Promise<TrackResult> {
    await new Promise<void>((resolve) => this.#stream.end(resolve))
    await finalizeWavHeader(this.#path, this.#bytes)
    return {
      path: this.#path,
      firstBufferAt: this.#firstBufferAt,
      peak: this.#peak,
      bytesWritten: this.#bytes,
    }
  }
}

/** AudioTee hands us little-endian Float32 bytes. */
function toFloat32(buf: Buffer): Float32Array {
  const out = new Float32Array(buf.length / 4)
  for (let i = 0; i < out.length; i++) out[i] = buf.readFloatLE(i * 4)
  return out
}
