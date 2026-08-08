import workletUrl from './capture-worklet.js?url'

/**
 * Microphone capture, renderer side.
 *
 * The mic lives in the renderer because `getUserMedia` is the only mic API
 * Electron exposes without a second native dependency, and because the
 * permission prompt is tied to a WebContents. System audio goes the other way
 * — AudioTee in main — so the two tracks arrive by different routes and are
 * only ever joined by their timestamps, never mixed.
 *
 * PCM leaves here already mono, Float32 and 16 kHz. Main deals in one format
 * and never learns what the device was doing.
 */

/** Matches TARGET_SAMPLE_RATE in main/audio/AudioCapture.ts. */
const TARGET_RATE = 16_000

export interface MicRecorderEvents {
  /** Mono 16 kHz Float32, ~40 ms per call. */
  onChunk: (samples: Float32Array) => void
  /**
   * The device changed sample rate mid-recording, which ARCHITECTURE §3
   * insists we treat as a real event rather than an impossibility. Everything
   * after this point was resampled from a different ratio.
   */
  onRateChange?: (from: number, to: number) => void
  onError?: (err: Error) => void
}

export class MicRecorder {
  #ctx: AudioContext | null = null
  #stream: MediaStream | null = null
  #node: AudioWorkletNode | null = null
  #source: MediaStreamAudioSourceNode | null = null
  #events: MicRecorderEvents
  #running = false

  /** Wall-clock ms of the first buffer. Null until audio actually arrives. */
  #firstChunkAt: number | null = null

  #deviceRate = 0
  #rateWatch: ReturnType<typeof setInterval> | null = null

  constructor(events: MicRecorderEvents) {
    this.#events = events
  }

  get firstChunkAt(): number | null {
    return this.#firstChunkAt
  }

  isRunning(): boolean {
    return this.#running
  }

  async start(): Promise<void> {
    if (this.#running) return

    this.#stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        // All three off deliberately. Echo cancellation on some macOS routes
        // delivers digital silence with no error at all (quill rca-001), and
        // noise suppression is tuned for intelligibility on a phone call, not
        // for an ASR frontend — it removes exactly the low-energy consonants
        // Whisper needs. The VAD downstream handles silence far better.
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
      video: false,
    })

    // No sampleRate hint: asking for 16 kHz makes Chromium resample with its
    // own (undocumented, unmeasurable) filter and can force the device into a
    // different mode entirely. Take the device's native rate and do the
    // conversion in the worklet, where the filter is ours and testable.
    this.#ctx = new AudioContext({ latencyHint: 'interactive' })
    this.#deviceRate = this.#ctx.sampleRate

    await this.#ctx.audioWorklet.addModule(workletUrl)

    this.#source = this.#ctx.createMediaStreamSource(this.#stream)
    this.#node = new AudioWorkletNode(this.#ctx, 'oratio-capture', {
      numberOfInputs: 1,
      numberOfOutputs: 0,
      channelCount: 1,
      // Downmix anything multi-channel to mono in the graph rather than in
      // our own code — a 2-channel interface is common and the browser's
      // downmix is correct and free.
      channelCountMode: 'explicit',
      channelInterpretation: 'speakers',
    })

    this.#node.port.onmessage = (e: MessageEvent<Float32Array>) => {
      if (this.#firstChunkAt === null) this.#firstChunkAt = Date.now()
      this.#events.onChunk(e.data)
    }

    this.#node.onprocessorerror = () => {
      this.#events.onError?.(new Error('audio worklet stopped unexpectedly'))
    }

    // numberOfOutputs is 0, so this node is a sink. It still pulls input as
    // long as it is connected to something in the graph, which the source
    // connection below provides — no destination hookup, and therefore no
    // risk of the mic being played back into the room.
    this.#source.connect(this.#node)

    this.#watchSampleRate()
    this.#running = true
  }

  /**
   * A route change (AirPods connecting, a dock being unplugged) can change
   * the context's rate mid-session. Hyprnote re-probes for this because when
   * it happens every subsequent sample is pitch-shifted with no error raised
   * anywhere.
   *
   * An AudioContext's `sampleRate` is fixed for its lifetime, so a change
   * means the graph must be rebuilt — polling is enough to notice, since the
   * consequence is measured in whole seconds of bad audio, not milliseconds.
   */
  #watchSampleRate(): void {
    this.#rateWatch = setInterval(() => {
      const rate = this.#ctx?.sampleRate
      if (!rate || rate === this.#deviceRate) return

      const from = this.#deviceRate
      this.#deviceRate = rate
      this.#events.onRateChange?.(from, rate)
      void this.#rebuild()
    }, 1_000)
  }

  /**
   * Tear the graph down and stand it back up at the new device rate.
   *
   * Loses a few hundred milliseconds of audio, which is the correct trade:
   * the alternative is hours of pitch-shifted garbage that no one notices
   * until they read the transcript.
   */
  async #rebuild(): Promise<void> {
    if (!this.#running) return
    try {
      const firstChunkAt = this.#firstChunkAt
      await this.stop()
      await this.start()
      // Preserve the original alignment — the session's clock is anchored to
      // the FIRST buffer ever seen, not to the restart.
      this.#firstChunkAt = firstChunkAt
    } catch (err) {
      this.#events.onError?.(err instanceof Error ? err : new Error(String(err)))
    }
  }

  async stop(): Promise<void> {
    this.#running = false

    if (this.#rateWatch) {
      clearInterval(this.#rateWatch)
      this.#rateWatch = null
    }

    // Flush before teardown: the worklet is holding up to 40 ms of audio that
    // would otherwise be dropped, and the end of a meeting is exactly where
    // someone says the thing worth keeping.
    this.#node?.port.postMessage('stop')
    await new Promise((r) => setTimeout(r, 60))

    this.#source?.disconnect()
    this.#node?.disconnect()
    if (this.#node) this.#node.port.onmessage = null

    for (const track of this.#stream?.getTracks() ?? []) track.stop()

    // Close the context explicitly. An abandoned AudioContext keeps the
    // device open, and macOS keeps showing the orange mic indicator — which
    // users reasonably read as the app still listening.
    await this.#ctx?.close().catch(() => {})

    this.#node = null
    this.#source = null
    this.#stream = null
    this.#ctx = null
  }

  /** The rate the device is actually running at, for diagnostics. */
  get deviceRate(): number {
    return this.#deviceRate
  }
}

export { TARGET_RATE }
