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

export interface ModelDownload {
  url: string
  /** Top-level directory inside the tarball. */
  dirName: string
  /**
   * SHA-256 of the tarball, pinned.
   *
   * Upstream publishes these in `checksum.txt` at the same release tag, but a
   * checksum fetched from the host that served the file only proves the
   * transfer was intact — it cannot prove the file is the one we expect. A
   * pinned digest does both, and costs nothing extra: release assets are
   * immutable, so this only changes when we deliberately move to a new model.
   *
   * All four were verified by downloading and hashing on 8 Aug 2026.
   */
  sha256: string
  /**
   * Files that MUST exist and be non-empty for the model to count as present.
   *
   * Every family lays its files out differently, so this cannot be derived —
   * it has to be declared. Crucially, presence is checked against this list
   * rather than against the directory: a half-extracted directory exists too,
   * and treating that as ready is exactly how "failed to load model" becomes
   * the top defect class (ARCHITECTURE §4.4).
   */
  required: readonly string[]
  /**
   * Files to delete after extraction.
   *
   * The Whisper tarballs ship full-precision AND int8 weights; we only ever
   * load int8, so the fp32 copies are pure waste — 924 MB of the 1.3 GB that
   * whisper-small.en unpacks to. `test_wavs` goes too; it is sample data.
   */
  prune: readonly string[]
  /**
   * Peak disk needed to install, in bytes: the tarball plus everything it
   * unpacks to, both on disk at once before pruning.
   *
   * Measured, not estimated — and far larger than the download for the
   * Whisper models, which is why the check cannot simply use `sizeBytes`.
   */
  installPeakBytes: number
}

export const MODEL_DOWNLOADS: Record<ModelId, ModelDownload> = {
  'whisper-base-en': {
    url: `${RELEASES}/sherpa-onnx-whisper-base.en.tar.bz2`,
    dirName: 'sherpa-onnx-whisper-base.en',
    sha256: '475bc7052ce299c007f6d5d5407ba8601f819a2867f6eecee510ed17df581542',
    required: ['base.en-encoder.int8.onnx', 'base.en-decoder.int8.onnx', 'base.en-tokens.txt'],
    // 447 MB unpacked, of which 289 MB is fp32 weights we never load.
    prune: ['base.en-encoder.onnx', 'base.en-decoder.onnx', 'test_wavs'],
    installPeakBytes: 209_000_000 + 447_000_000,
  },
  'moonshine-base-en': {
    url: `${RELEASES}/sherpa-onnx-moonshine-base-en-int8.tar.bz2`,
    dirName: 'sherpa-onnx-moonshine-base-en-int8',
    sha256: '21870cecaa2e44e4e2bf63e02d1072bed183ccd10284871353bd9d24dad14e5e',
    // Four stages, not the encoder/decoder pair the other families use.
    required: [
      'preprocess.onnx',
      'encode.int8.onnx',
      'uncached_decode.int8.onnx',
      'cached_decode.int8.onnx',
      'tokens.txt',
    ],
    // Already an int8-only build — nothing redundant to remove.
    prune: ['test_wavs'],
    installPeakBytes: 251_000_000 + 251_000_000,
  },
  'whisper-small-en': {
    url: `${RELEASES}/sherpa-onnx-whisper-small.en.tar.bz2`,
    dirName: 'sherpa-onnx-whisper-small.en',
    sha256: '0cdba2b8aaab69e04847f3427cc9709574112e67913a1a84b7fec3a8729faa9a',
    required: ['small.en-encoder.int8.onnx', 'small.en-decoder.int8.onnx', 'small.en-tokens.txt'],
    // The worst offender: 1.3 GB unpacked, 924 MB of it fp32 weights.
    prune: ['small.en-encoder.onnx', 'small.en-decoder.onnx', 'test_wavs'],
    installPeakBytes: 636_000_000 + 1_300_000_000,
  },
  'parakeet-tdt-v2': {
    url: `${RELEASES}/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8.tar.bz2`,
    dirName: 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8',
    sha256: '157c157bc51155e03e37d2466522a3a737dd9c72bb25f36eb18912964161e1ad',
    // Transducer: encoder/decoder/joiner rather than encoder/decoder.
    required: [
      'encoder.int8.onnx',
      'decoder.int8.onnx',
      'joiner.int8.onnx',
      'tokens.txt',
    ],
    prune: ['test_wavs'],
    installPeakBytes: 482_000_000 + 634_000_000,
  },
}

/**
 * What the model actually occupies once installed, after pruning.
 *
 * `sizeBytes` is the download; this is what the user gives up on disk, and for
 * the Whisper models the two differ by enough that showing only the download
 * would be misleading. Both belong in the picker.
 */
export const MODEL_INSTALLED_BYTES: Record<ModelId, number> = {
  'whisper-base-en': 156_000_000,
  'moonshine-base-en': 251_000_000,
  'whisper-small-en': 358_000_000,
  'parakeet-tdt-v2': 631_000_000,
}

/**
 * Silero VAD. Tiny, and mandatory — see transcription/vad.ts for why.
 *
 * It ships as a bare `.onnx`, not a tarball, so it needs no extraction. But it
 * is a hard prerequisite for every model: without it the worker cannot run
 * ASR at all, so it is fetched alongside whichever model the user picks
 * rather than being a separate thing they could forget.
 *
 * Digest verified by download on 8 Aug 2026, same as the four ASR models.
 */
export const VAD_MODEL = {
  url: `${RELEASES}/silero_vad.onnx`,
  fileName: 'silero_vad.onnx',
  sizeBytes: 643_854,
  sha256: '9e2449e1087496d8d4caba907f23e0bd3f78d91fa552479bb9c23ac09cbb1fd6',
}

export function formatSize(bytes: number): string {
  return `${Math.round(bytes / 1_000_000)} MB`
}
