import type { ModelId, ModelInfo } from './types'

/**
 * The model catalogue.
 *
 * All four are English-only, int8-quantized, and load through the same
 * sherpa-onnx API — so supporting all of them is a download manager and a
 * dropdown, not four code paths.
 *
 * Sizes are measured from the HuggingFace repos, not estimated. They are
 * shown in the picker: a user choosing "Most accurate" should know it costs
 * 661 MB before they commit to the download.
 */
export const MODELS: Record<ModelId, ModelInfo> = {
  'whisper-base-en': {
    id: 'whisper-base-en',
    label: 'Fastest, smallest',
    sizeBytes: 208_576_005,
    description: 'Whisper base.en. Lowest disk and memory cost. Good for quick notes.',
    streaming: false,
  },
  'moonshine-base-en': {
    id: 'moonshine-base-en',
    label: 'Recommended',
    sizeBytes: 250_807_309,
    description:
      'Moonshine base. Matches Whisper large-v3 accuracy on English at a fraction of the size, and is built for streaming — so the transcript appears as people speak.',
    streaming: true,
    recommended: true,
  },
  'parakeet-tdt-v2': {
    id: 'parakeet-tdt-v2',
    label: 'Most accurate',
    sizeBytes: 482_468_385,
    description:
      'NVIDIA Parakeet TDT 0.6B v2. Best English accuracy available locally and very fast.',
    streaming: false,
  },
  'whisper-small-en': {
    id: 'whisper-small-en',
    label: 'Largest',
    sizeBytes: 635_693_775,
    description:
      'Whisper small.en. More accurate than base, but the biggest download and slowest of the four.',
    streaming: false,
  },
}

export const DEFAULT_MODEL: ModelId = 'moonshine-base-en'

/**
 * sherpa-onnx publishes each model as a tarball on its releases page.
 * Downloaded once into userData/models/<id>/ and reused thereafter.
 */
const RELEASES = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models'

export const MODEL_DOWNLOADS: Record<ModelId, { url: string; dirName: string }> = {
  'whisper-base-en': {
    url: `${RELEASES}/sherpa-onnx-whisper-base.en.tar.bz2`,
    dirName: 'sherpa-onnx-whisper-base.en',
  },
  'moonshine-base-en': {
    url: `${RELEASES}/sherpa-onnx-moonshine-base-en-int8.tar.bz2`,
    dirName: 'sherpa-onnx-moonshine-base-en-int8',
  },
  'whisper-small-en': {
    url: `${RELEASES}/sherpa-onnx-whisper-small.en.tar.bz2`,
    dirName: 'sherpa-onnx-whisper-small.en',
  },
  'parakeet-tdt-v2': {
    url: `${RELEASES}/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8.tar.bz2`,
    dirName: 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8',
  },
}

/** Silero VAD. Tiny, and mandatory — see transcription/vad.ts for why. */
export const VAD_MODEL = {
  url: `${RELEASES}/silero_vad.onnx`,
  fileName: 'silero_vad.onnx',
  sizeBytes: 643_854,
}

export function formatSize(bytes: number): string {
  return `${Math.round(bytes / 1_000_000)} MB`
}
