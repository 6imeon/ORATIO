import { EventEmitter } from 'node:events'
import { createWriteStream, existsSync, statSync, type WriteStream } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { AudioTee } from 'audiotee'
import { app } from 'electron'
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
 * Locate the AudioTee Swift binary ourselves instead of letting the package
 * find it.
 *
 * audiotee computes its binary as `join(__dirname, '..', 'bin', 'audiotee')`,
 * where `__dirname` comes from `import.meta.url` — the package is
 * `"type": "module"`. Electron's asar integration patches `fs` and the CJS
 * `require`, but the **ESM loader bypasses it entirely**, so in a packaged app
 * `import.meta.url` reports a path *inside* the archive
 * (`.../app.asar/node_modules/audiotee/dist/index.js`) even though the file was
 * unpacked. The spawn path then traverses `app.asar` — a regular file — as if
 * it were a directory, and the failure is `spawn ENOTDIR`, which names neither
 * the file nor the archive.
 *
 * This is CLAUDE.md rule 5 wearing a different hat: never resolve a bundled
 * path from `__dirname`. `app.getAppPath()` is authoritative, and appending
 * `.unpacked` to it is how you address something asarUnpack pulled out.
 *
 * Verified rather than assumed — a missing binary here is another silent
 * macOS failure, so an absent file is reported now, with a path in the message,
 * instead of surfacing later as a bare errno.
 */
function resolveAudioTeeBinary(): string {
  const appPath = app.getAppPath()

  if (appPath.endsWith('.asar')) {
    // Packaged: asarUnpack put the real file beside the archive.
    const unpacked = `${appPath}.unpacked`
    const binary = join(unpacked, 'node_modules', 'audiotee', 'bin', 'audiotee')

    /**
     * Check the containing DIRECTORY, not the file.
     *
     * Electron's asar shim makes `existsSync` return true for paths inside the
     * archive, so an existence check on the binary passes even when asarUnpack
     * did not run — the very case this guard is for. `statSync().isDirectory()`
     * on the unpacked tree is not faked: if unpacking did not happen, the
     * `.unpacked` directory is simply absent.
     */
    const binDir = dirname(binary)
    const unpackedProperly = existsSync(binDir) && statSync(binDir).isDirectory()
    if (!unpackedProperly) {
      throw new Error(
        `AudioTee was not unpacked from the asar (expected ${binary}). ` +
          "It must be listed in electron-builder.yml's asarUnpack — a native " +
          'binary cannot be executed from inside an asar archive.',
      )
    }
    return binary
  }

  /*
   * Dev: resolve through the package itself, which handles pnpm's store layout
   * (node_modules/audiotee is a symlink into .pnpm) without hardcoding it.
   *
   * Deliberately NOT named `require`. Main is bundled to CommonJS, so a local
   * `const require = ...` compiles to a binding that shadows the module's own
   * `require` for the whole function body — and rollup hoists the helper this
   * file uses above it, so calling it hits the temporal dead zone:
   * "Cannot access 'require' before initialization". Every recording in dev
   * failed with that until the name was changed; the packaged build took the
   * branch above and never reached it, which is what made it survive testing.
   */
  const resolveFrom = createRequire(import.meta.url)
  const binary = join(dirname(resolveFrom.resolve('audiotee')), '..', 'bin', 'audiotee')
  if (!existsSync(binary)) {
    throw new Error(`AudioTee binary is missing at ${binary}. Try reinstalling with pnpm install.`)
  }
  return binary
}

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

    const onWriteError = (err: Error): void => {
      log.error('[audio] track write error', err)
      this.emit('error', err)
    }
    this.#mic = new TrackWriter(opts.micPath, onWriteError)
    this.#system = new TrackWriter(opts.systemPath, onWriteError)

    // Ask AudioTee for exactly the format sherpa-onnx wants, so no
    // resampling is needed anywhere downstream. binaryPath is passed
    // explicitly because the package cannot locate itself inside an asar —
    // see resolveAudioTeeBinary.
    this.#tee = new AudioTee({
      sampleRate: TARGET_SAMPLE_RATE,
      binaryPath: resolveAudioTeeBinary(),
    })

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

  /**
   * First write error, kept rather than thrown.
   *
   * A full disk is the case this exists for. `write()` is called from an
   * AudioTee data callback and from the mic IPC handler — neither has anywhere
   * to put a rejection, so throwing would surface as an unhandled error at a
   * random point in the audio path. Instead the failure is recorded and
   * reported once through the capture `error` event.
   *
   * `close()` deliberately does NOT re-throw it. The recording is still saved:
   * the samples written before the failure are real audio, and a meeting that
   * lost its last minutes to a full disk is worth far more than no meeting at
   * all. The user has already been told what happened.
   */
  #writeError: Error | null = null

  /** Reports a fatal write failure to the owning capture, once. */
  readonly #onError: (err: Error) => void

  constructor(path: string, onError: (err: Error) => void) {
    this.#path = path
    this.#onError = onError
    this.#stream = createWriteStream(path)
    writeWavHeader(this.#stream, { sampleRate: TARGET_SAMPLE_RATE, channels: 1 })

    /**
     * Without this handler a stream error is an unhandled 'error' event, which
     * Node throws — taking down the main process and the meeting with it. The
     * disk filling up mid-recording is a normal thing that happens to real
     * users, and it has to end in a message rather than a crash.
     */
    this.#stream.on('error', (err) => this.#fail(err))

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

  /**
   * Record a fatal write failure and report it upward exactly once.
   *
   * Only the first is kept: a full disk produces one error per buffer, and
   * thirty a second of identical ENOSPC would bury the one that explains it.
   */
  #fail(err: Error): void {
    if (this.#writeError) return
    this.#writeError = err
    log.error('[audio] write failed', { path: this.#path, err })
    this.#onError(
      new Error(
        `Recording to ${this.#path} failed: ${err.message}. ` +
          'Audio already written is still on disk.',
      ),
    )
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
    // Once the stream has failed there is nothing useful to do with further
    // buffers: the fd is gone, and every subsequent write would raise the
    // same error again. Levels keep being reported so the meters stay live
    // and the user can see the meeting is still in progress.
    if (this.#writeError) {
      let bufPeak = 0
      for (let i = 0; i < samples.length; i++) {
        const a = Math.abs(samples[i]!)
        if (a > bufPeak) bufPeak = a
      }
      return bufPeak
    }

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
    // `end()` on a stream that already errored never fires its callback, so
    // this would hang forever waiting for a flush that cannot happen.
    if (this.#writeError) {
      this.#stream.destroy()
    } else {
      await new Promise<void>((resolve) => this.#stream.end(resolve))
    }

    /**
     * Patch the header even on failure, so the bytes that DID land are a
     * playable file rather than a WAV claiming zero length. This is the same
     * reason the header is patched periodically while recording: partial audio
     * is worth keeping, and it is only worth keeping if something can open it.
     */
    try {
      await finalizeWavHeader(this.#path, this.#bytes)
    } catch (err) {
      // A disk with no room for 8 bytes of header is possible. The samples are
      // still there, and repairWavHeader can reconstruct the sizes later.
      log.warn('[audio] could not finalize header', { path: this.#path, err })
    }

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
