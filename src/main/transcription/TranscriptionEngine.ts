import type { ModelId } from '@shared/types'

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
