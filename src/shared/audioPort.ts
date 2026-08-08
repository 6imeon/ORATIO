/**
 * The mic PCM transport, shared so both ends agree on it.
 *
 * PCM does NOT travel over `ipcRenderer.invoke` or `send`. Neither can
 * transfer an ArrayBuffer, so every chunk would be structured-cloned — and
 * UI.md §0 measures a 1 MB copy over IPC at ~70 ms. A dedicated MessagePort
 * transfers instead, which detaches the buffer and copies nothing.
 *
 * The port is handed over once, at the start of a recording, via this one
 * `postMessage` channel. Everything after that flows on the port itself and
 * never touches the main IPC router.
 */

/** Renderer → main, carrying the transferred MessagePort. */
export const AUDIO_PORT_CHANNEL = 'audio:port'

/** Sent on the port before any audio, so main knows what it is receiving. */
export interface AudioPortHello {
  type: 'hello'
  track: 'mic'
  /** The device's native rate, pre-resample. Diagnostics only — PCM is 16 kHz. */
  deviceRate: number
}

/** Sent on the port when the device changed rate mid-recording. */
export interface AudioPortRateChange {
  type: 'rate-change'
  from: number
  to: number
}

/** Sent on the port when the renderer's capture has fully stopped. */
export interface AudioPortEnd {
  type: 'end'
}

export type AudioPortMessage = AudioPortHello | AudioPortRateChange | AudioPortEnd

/**
 * PCM travels wrapped in `{ pcm }` rather than as a bare top-level buffer.
 *
 * Not a stylistic choice. A bare ArrayBuffer posted through a
 * contextBridge-exposed function never arrives at main — and `postMessage`
 * raises nothing, so every chunk is silently dropped and the WAV is zero
 * bytes with a clean log. A TypedArray inside a plain object survives
 * Electron's serializer intact.
 */
export interface AudioPortPcm {
  pcm: Float32Array
}

/**
 * Pull PCM out of a port message, or null if it is a control message.
 * Tolerates the Uint8Array form the serializer may produce.
 */
export function extractPcm(data: unknown): Float32Array | null {
  const wrapped = (data as AudioPortPcm | null)?.pcm
  if (!wrapped) return null

  if (wrapped instanceof Float32Array) return wrapped

  // Some serializer paths deliver the bytes as a plain view; reinterpret
  // rather than reject, since the payload is correct either way.
  if (ArrayBuffer.isView(wrapped)) {
    const v = wrapped as ArrayBufferView
    return new Float32Array(v.buffer, v.byteOffset, v.byteLength / 4)
  }
  return null
}
