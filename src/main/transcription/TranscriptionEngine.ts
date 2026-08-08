import type { ModelId } from '@shared/types'

/**
 * MUST be passed to every sherpa-onnx call that accepts it.
 *
 * sherpa defaults `enableExternalBuffer` to `true`, which makes it hand back
 * an ArrayBuffer pointing at externally-allocated memory. Electron 21+ runs
 * V8's memory cage and forbids exactly that:
 *
 *   sherpa.readWave(path, true)  -> Error: External buffers are not allowed
 *   sherpa.readWave(path, false) -> 32000 samples
 *
 * Measured on Electron 43.2.0 / sherpa-onnx-node 1.13.4.
 *
 * This is not a corner case: vad.js defaults it to `true` in BOTH get() and
 * front(), and VAD is mandatory here — so the default-argument version of
 * this pipeline throws on every recording. The cost of `false` is one buffer
 * copy, which is noise next to inference time.
 *
 * See docs/ARCHITECTURE.md §1.1.
 */
export const SHERPA_EXTERNAL_BUFFER = false

export interface RawSegment {
  /** Seconds from the start of THIS track. */
  start: number
  end: number
  text: string
}

/**
 * A loaded local ASR model.
 *
 * Every model in the picker loads through the same sherpa-onnx API, so this
 * interface has exactly one implementation. It exists to keep the queue and
 * the merge logic from knowing anything about sherpa.
 *
 * Transcription is ALWAYS local. There is deliberately no cloud engine and
 * no fallback that would send audio off the machine — that guarantee is the
 * product.
 */
export interface TranscriptionEngine {
  readonly modelId: ModelId
  readonly streaming: boolean

  /** Load weights into memory. Expensive; call once per drain. */
  prepare(): Promise<void>

  /** Transcribe a finished WAV file. */
  transcribeFile(wavPath: string): Promise<RawSegment[]>

  /**
   * Feed audio during a live session. Only meaningful when `streaming` is
   * true; other models return null and the UI shows nothing until stop.
   */
  transcribeChunk?(samples: Float32Array): Promise<string | null>

  /** Free the weights. Called when the queue empties so an idle app is small. */
  release(): Promise<void>
}
