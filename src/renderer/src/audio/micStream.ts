import { MicRecorder, TARGET_RATE } from './MicRecorder'

/**
 * Joins the microphone to the main process.
 *
 * Two halves that are deliberately kept apart: `MicRecorder` knows about Web
 * Audio and nothing about IPC; the preload's audio port knows about IPC and
 * nothing about audio. This is the only file that knows both, which is what
 * keeps the worklet testable without an Electron host.
 */

export interface MicStreamHandle {
  stop: () => Promise<void>
  /** Wall-clock ms of the first mic buffer, for track alignment. Null if none. */
  firstChunkAt: () => number | null
}

export interface MicStreamOptions {
  onError?: (err: Error) => void
}

export async function startMicStream(opts: MicStreamOptions = {}): Promise<MicStreamHandle> {
  const port = window.oratio.recording.openAudioPort()

  const recorder = new MicRecorder({
    // Passed as a Float32Array, never as `samples.buffer`. A bare
    // ArrayBuffer does not survive contextBridge and — the part that costs a
    // day — `postMessage` accepts the detached result silently, producing a
    // recording of zero bytes with no error anywhere. The transfer that
    // actually matters happens preload-side, past the bridge.
    onChunk: (samples) => port.send(samples),

    onRateChange: (from, to) => port.control({ type: 'rate-change', from, to }),

    onError: (err) => opts.onError?.(err),
  })

  try {
    await recorder.start()
  } catch (err) {
    // getUserMedia rejects when the user denies the prompt, which is a normal
    // outcome rather than a crash — but the port must not be left open, or
    // main goes on believing a mic stream exists.
    port.close()
    throw err
  }

  port.control({ type: 'hello', track: 'mic', deviceRate: recorder.deviceRate })

  return {
    stop: async () => {
      await recorder.stop()
      // Announce the end before closing, so main can finalize the track
      // rather than inferring it from a port that simply went quiet.
      port.control({ type: 'end' })
      port.close()
    },
    firstChunkAt: () => recorder.firstChunkAt,
  }
}

export { TARGET_RATE }
