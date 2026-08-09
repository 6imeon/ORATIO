import { SHERPA_EXTERNAL_BUFFER, type RawSegment } from '../TranscriptionEngine'
import { detectSpeechByEnergy } from '../energyVad'
import { DEFAULT_VAD_OPTIONS } from '../vad'
import type { ModelId } from '@shared/types'

/**
 * THE ONLY MODULE IN THE CODEBASE THAT MAY REQUIRE sherpa-onnx-node.
 *
 * ARCHITECTURE §4.2. Two reasons this is a hard rule rather than a preference:
 *
 *  1. `enableExternalBuffer` defaults to `true` in sherpa's own JS, and
 *     Electron's V8 memory cage rejects external buffers outright — so the
 *     default-argument version of this pipeline throws on EVERY recording.
 *     A rule that must be remembered at twenty call sites is a rule that gets
 *     broken at one of them; funnelling every call through here makes it
 *     structural instead.
 *  2. The native addon must only ever be loaded inside the ASR
 *     `utilityProcess` (§1.3). A stray require in the main process would load
 *     a second copy of the library into the process that must never crash.
 *
 * It also keeps sherpa's three different model-family shapes from leaking
 * upward: the queue talks in `RawSegment[]` and never learns which family it
 * is running.
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
const sherpa = require('sherpa-onnx-node')

/** All four models are 16 kHz. Anything else must be resampled before ASR. */
const SAMPLE_RATE = 16_000

/**
 * ASR runs on one thread and VAD on another.
 *
 * Not a tuning knob so much as a courtesy: transcription is a background job
 * competing with a live meeting for CPU, and saturating every core makes the
 * machine that is *recording the call* stutter. ARCHITECTURE §4.6 notes ORT
 * thread contention as a real reported failure, not a theoretical one.
 */
const ASR_THREADS = 2

interface Recognizer {
  createStream(): Stream
  decode(stream: Stream): void
  getResult(stream: Stream): { text: string }
}

interface Stream {
  acceptWaveform(obj: { samples: Float32Array; sampleRate: number }): void
}

interface VadHandle {
  acceptWaveform(samples: Float32Array): void
  isEmpty(): boolean
  front(enableExternalBuffer: boolean): { start: number; samples: Float32Array }
  pop(): void
  flush(): void
}

/**
 * Build the sherpa model config for a family.
 *
 * Each family lays its files out differently — Whisper is encoder/decoder,
 * Moonshine is a four-stage pipeline, Parakeet is a transducer with a joiner —
 * but they all decode through the same `OfflineRecognizer`, which is what
 * makes four models a dropdown rather than four code paths.
 *
 * `files` comes from ModelManager.resolve(), so the keys are exactly the
 * manifest entries that were verified present and non-empty.
 */
function modelConfig(modelId: ModelId, files: Record<string, string>): unknown {
  const need = (name: string): string => {
    const path = files[name]
    // resolve() guarantees this, so a miss means the manifest and this
    // function have drifted apart — a programming error, not a user one.
    if (!path) throw new Error(`Model ${modelId} is missing ${name}`)
    return path
  }

  const common = { numThreads: ASR_THREADS, debug: false, provider: 'cpu' }

  switch (modelId) {
    case 'whisper-base-en':
    case 'whisper-small-en': {
      const prefix = modelId === 'whisper-base-en' ? 'base.en' : 'small.en'
      return {
        ...common,
        whisper: {
          encoder: need(`${prefix}-encoder.int8.onnx`),
          decoder: need(`${prefix}-decoder.int8.onnx`),
          // English-only weights: naming the language skips Whisper's
          // language-detection pass, which can misfire on the first seconds
          // of a meeting and transcribe English as something else.
          language: 'en',
          task: 'transcribe',
        },
        tokens: need(`${prefix}-tokens.txt`),
      }
    }

    case 'moonshine-base-en':
      return {
        ...common,
        moonshine: {
          preprocessor: need('preprocess.onnx'),
          encoder: need('encode.int8.onnx'),
          uncachedDecoder: need('uncached_decode.int8.onnx'),
          cachedDecoder: need('cached_decode.int8.onnx'),
        },
        tokens: need('tokens.txt'),
      }

    case 'parakeet-tdt-v2':
      return {
        ...common,
        transducer: {
          encoder: need('encoder.int8.onnx'),
          decoder: need('decoder.int8.onnx'),
          joiner: need('joiner.int8.onnx'),
        },
        modelType: 'nemo_transducer',
        tokens: need('tokens.txt'),
      }
  }
}

/**
 * A loaded model plus its VAD, living inside the ASR worker.
 *
 * Held for the lifetime of one job: the model loads once and is amortised
 * across both tracks, then the whole process is killed. Process exit is the
 * only reliable deallocator here (ARCHITECTURE §1.3).
 */
export class SherpaSession {
  private recognizer: Recognizer | null = null
  private vadModelPath: string | null = null
  private vadEnabled = true

  /**
   * Whether onnxruntime can run here at all. False routes VAD to the energy
   * detector; ASR itself has no fallback (see `load`).
   */
  private onnxUsable = true

  load(
    modelId: ModelId,
    files: Record<string, string>,
    vadModelPath: string,
    vadEnabled: boolean,
    onnxUsable = true,
  ): void {
    this.onnxUsable = onnxUsable

    /*
     * There is no fallback for ASR, only for VAD.
     *
     * Constructing the recognizer initialises an onnxruntime thread pool, which
     * executes AVX2 before any of our code regains control — on a CPU without
     * it the process dies with STATUS_ILLEGAL_INSTRUCTION and no catch block
     * ever runs. So this must return a *reportable error* before touching
     * sherpa, rather than letting the worker vanish and leaving the queue
     * holding a job whose failure has no explanation.
     *
     * Transcription is local-only by invariant, so a cloud path is not an
     * option here — this machine genuinely cannot transcribe, and saying so is
     * the honest outcome. Recording still works: the audio is kept and stays
     * transcribable on another machine, which is why this is a per-job error
     * and not a startup refusal.
     */
    if (!onnxUsable) {
      throw new Error(
        'This computer cannot run local transcription: its processor lacks AVX2, ' +
          'which the speech-recognition engine requires. Recordings are still saved ' +
          'and can be transcribed on another computer.',
      )
    }

    this.recognizer = new sherpa.OfflineRecognizer({
      modelConfig: modelConfig(modelId, files),
    }) as Recognizer
    this.vadModelPath = vadModelPath
    this.vadEnabled = vadEnabled
  }

  /**
   * Transcribe a finished WAV, VAD first.
   *
   * The VAD pass is what keeps the transcript honest: Whisper-family models
   * hallucinate confidently on silence, and a system-audio tap is mostly
   * silence whenever nobody is speaking. Non-speech is dropped before the
   * model ever sees it.
   *
   * Timings come out relative to this track's own start; the queue shifts them
   * onto the shared clock using `TrackMeta.startOffsetMs`.
   */
  transcribe(wavPath: string, onProgress: (fraction: number) => void): RawSegment[] {
    const recognizer = this.recognizer
    if (!recognizer) throw new Error('transcribe called before load')

    // enableExternalBuffer=false, or this throws under the V8 cage.
    const wave = sherpa.readWave(wavPath, SHERPA_EXTERNAL_BUFFER) as {
      samples: Float32Array
      sampleRate: number
    }

    if (wave.sampleRate !== SAMPLE_RATE) {
      // Capture writes 16 kHz, so this means something upstream changed. Fail
      // loudly rather than transcribing at the wrong rate, which produces
      // plausible-looking nonsense instead of an error.
      throw new Error(`Expected ${SAMPLE_RATE} Hz audio, got ${wave.sampleRate} Hz`)
    }

    const regions = this.vadEnabled
      ? this.detectSpeech(wave.samples)
      : [{ startSample: 0, samples: wave.samples }]

    const out: RawSegment[] = []
    for (const [i, region] of regions.entries()) {
      const stream = recognizer.createStream()
      stream.acceptWaveform({ samples: region.samples, sampleRate: SAMPLE_RATE })
      recognizer.decode(stream)
      const text = recognizer.getResult(stream).text.trim()

      if (text) {
        const start = region.startSample / SAMPLE_RATE
        out.push({
          start,
          end: start + region.samples.length / SAMPLE_RATE,
          text,
        })
      }

      onProgress((i + 1) / regions.length)
    }

    return out
  }

  release(): void {
    // Dropping the reference is all we can do from JS; the weights are freed
    // when the process exits, which is why the worker is killed per job.
    this.recognizer = null
  }

  /**
   * Split a track into speech regions with Silero VAD.
   *
   * Returns sample offsets rather than seconds because that is what sherpa
   * gives us — `SpeechSegment.start` is an index into the waveform, and
   * converting once here avoids rounding twice.
   */
  private detectSpeech(
    samples: Float32Array,
  ): Array<{ startSample: number; samples: Float32Array }> {
    if (!this.vadModelPath) throw new Error('VAD model path not set')

    /*
     * On a machine that cannot run onnxruntime, Silero is not an option: it is
     * an ONNX session, so constructing it kills this process outright rather
     * than throwing (cpuFeatures.ts). Degrade to the energy detector instead.
     *
     * Never to *no* VAD — VAD-before-ASR is an invariant, and handing a whole
     * track to a Whisper-family model fills the transcript with hallucinated
     * text on every silent stretch.
     */
    if (!this.onnxUsable) {
      return detectSpeechByEnergy(samples, SAMPLE_RATE)
    }

    const vad = new sherpa.Vad(
      {
        sileroVad: {
          model: this.vadModelPath,
          threshold: DEFAULT_VAD_OPTIONS.threshold,
          minSpeechDuration: DEFAULT_VAD_OPTIONS.minSpeechDurationMs / 1000,
          minSilenceDuration: DEFAULT_VAD_OPTIONS.minSilenceDurationMs / 1000,
          // Caps region length. Read as an ordering parameter rather than a
          // memory one — it is what lets an interjection sort into the middle
          // of a continuous far-end turn instead of after it. Derived in
          // `vad.ts`; do not raise it back toward Whisper's 30 s window
          // without re-reading that.
          maxSpeechDuration: DEFAULT_VAD_OPTIONS.maxSpeechDurationMs / 1000,
        },
        sampleRate: SAMPLE_RATE,
        numThreads: 1,
        debug: false,
      },
      // Buffer seconds. Regions are drained as they are detected, so this
      // bounds momentary backlog rather than the length of the recording.
      60,
    ) as VadHandle

    const regions: Array<{ startSample: number; samples: Float32Array }> = []
    const drain = (): void => {
      while (!vad.isEmpty()) {
        // Again: false, or the V8 cage rejects the returned buffer.
        const seg = vad.front(SHERPA_EXTERNAL_BUFFER)
        regions.push({ startSample: seg.start, samples: seg.samples })
        vad.pop()
      }
    }

    // Feed in windows rather than one giant call, so the detector can emit
    // regions as it goes instead of buffering an entire meeting.
    const WINDOW = 512
    for (let i = 0; i < samples.length; i += WINDOW) {
      vad.acceptWaveform(samples.subarray(i, Math.min(i + WINDOW, samples.length)))
      drain()
    }

    // Without flush, speech still open when the audio ends is discarded — the
    // last utterance of a meeting is exactly the one that gets lost.
    vad.flush()
    drain()

    return regions
  }
}
