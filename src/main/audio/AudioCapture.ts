/**
 * Platform-agnostic capture contract.
 *
 * macOS is the only implementation today. Windows lands later behind this
 * same interface (WASAPI process loopback, which is actually better — it can
 * capture a single process, so you record Zoom without recording Spotify).
 * Nothing above this file may reference Core Audio, AudioTee, or `.caf`.
 */

export interface CaptureOptions {
  /** Absolute path for the microphone track. */
  micPath: string
  /** Absolute path for the system-audio track. */
  systemPath: string
}

export interface TrackResult {
  path: string
  /**
   * Wall-clock ms (epoch) of this track's FIRST buffer — not when start()
   * was called. The two devices never begin on the same instant, and the
   * merged transcript drifts if you assume they do.
   */
  firstBufferAt: number | null
  /** Peak amplitude seen across the whole track, 0..1. Zero means silence. */
  peak: number
  bytesWritten: number
  /**
   * Samples actually written. Duration must be derived from this, never from
   * elapsed wall-clock: OS suspend freezes the event loop, and a track that
   * lost 90 seconds to sleep is 90 seconds shorter than the clock says
   * (ARCHITECTURE §3).
   */
  samples: number
  /**
   * Offsets, in ms from this track's own start, where capture was
   * interrupted — a device rate change or a system suspend. Audio either side
   * is valid; the timeline across the gap is not.
   */
  discontinuities: number[]
}

export interface CaptureResult {
  mic: TrackResult
  system: TrackResult
}

export interface CaptureEvents {
  /** Emitted frequently while recording; drives the level meters. */
  level: (track: 'mic' | 'system', peak: number) => void
  /**
   * Raw PCM for streaming transcription. Mono, 16 kHz, Float32 — already
   * resampled, so consumers never deal with device formats.
   */
  pcm: (track: 'mic' | 'system', samples: Float32Array) => void
  /**
   * A track produced exact digital silence for LIVENESS_CHECK_MS. Every
   * macOS audio failure mode reports success and then delivers zeroes, so
   * this is the only way to learn about it — and learning about it two
   * minutes in is worth far more than learning about it at stop().
   */
  dead: (track: 'mic' | 'system') => void
  error: (err: Error) => void
}

export interface AudioCapture {
  readonly platform: 'darwin' | 'win32'
  isRecording(): boolean
  start(opts: CaptureOptions): Promise<void>
  stop(): Promise<CaptureResult>
  on<K extends keyof CaptureEvents>(event: K, listener: CaptureEvents[K]): void
  off<K extends keyof CaptureEvents>(event: K, listener: CaptureEvents[K]): void
}

/** Sample rate every downstream consumer can rely on. sherpa-onnx wants 16k. */
export const TARGET_SAMPLE_RATE = 16_000

/**
 * If a track's peak is still exactly zero after this long, the capture is
 * almost certainly dead rather than merely quiet — real microphones always
 * emit some noise floor.
 *
 * This mirrors the liveness check in quill's MicRecorder. Every macOS audio
 * failure mode (missing entitlement on a helper binary, a tap-only aggregate
 * device, an unsupported voice-processing route) returns SUCCESS and then
 * delivers digital silence. Detecting it at runtime is the only reliable
 * defence.
 */
export const LIVENESS_CHECK_MS = 3_000
