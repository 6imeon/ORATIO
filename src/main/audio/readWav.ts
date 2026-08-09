import { readFile } from 'node:fs/promises'

/**
 * Read one of our own 16-bit mono WAVs back into samples.
 *
 * Deliberately narrow: it reads the files `wav.ts` writes, not arbitrary WAVs.
 * That is what keeps it twenty lines rather than a dependency — no compressed
 * formats, no 24/32-bit, no multi-channel, no exotic chunk layouts.
 *
 * Not sherpa's `readWave`, even though the ASR worker uses it: sherpa-onnx must
 * never be required outside that worker's wrapper module (CLAUDE.md), because
 * loading a native addon in main is exactly the thing the utilityProcess
 * architecture exists to avoid.
 */

export interface WavData {
  samples: Float32Array
  sampleRate: number
}

/**
 * Chunks are walked rather than assumed to be at fixed offsets.
 *
 * A canonical WAV is `fmt ` then `data`, and ours are — but writers routinely
 * insert `LIST`/`INFO` between them, and an offset-based reader would then
 * read metadata as audio and return noise. Walking is barely more code and
 * cannot make that mistake.
 */
export async function readWav(path: string): Promise<WavData> {
  const buf = await readFile(path)

  if (buf.length < 12 || buf.toString('ascii', 0, 4) !== 'RIFF') {
    throw new Error(`Not a WAV file: ${path}`)
  }

  let sampleRate = 0
  let bitsPerSample = 0
  let channels = 0
  let dataStart = -1
  let dataLength = 0

  let offset = 12
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4)
    const size = buf.readUInt32LE(offset + 4)

    if (id === 'fmt ') {
      channels = buf.readUInt16LE(offset + 10)
      sampleRate = buf.readUInt32LE(offset + 12)
      bitsPerSample = buf.readUInt16LE(offset + 22)
    } else if (id === 'data') {
      dataStart = offset + 8
      dataLength = size
      break
    }

    // Chunks are word-aligned: an odd size is followed by a pad byte that is
    // not counted in the size field. Missing this desynchronises every
    // subsequent chunk.
    offset += 8 + size + (size % 2)
  }

  if (dataStart < 0) throw new Error(`WAV has no data chunk: ${path}`)
  if (bitsPerSample !== 16) {
    throw new Error(`Expected 16-bit WAV, got ${bitsPerSample}-bit: ${path}`)
  }

  /**
   * Trust the file's length over the header's.
   *
   * A recording interrupted by a crash has a header claiming more data than
   * was written — `repairWavHeader` fixes that on the next launch, but this
   * may run on a file it has not reached yet. Taking the minimum means a
   * truncated file reads short instead of running off the end of the buffer.
   */
  const available = Math.min(dataLength, buf.length - dataStart)
  const frames = Math.floor(available / 2)

  const samples = new Float32Array(frames)
  for (let i = 0; i < frames; i++) {
    // Int16 to [-1, 1). 32768 rather than 32767 so the mapping is exact and
    // -1.0 is representable, which is what every audio API expects.
    samples[i] = buf.readInt16LE(dataStart + i * 2) / 32768
  }

  // Mono is an invariant of our own capture, so this is an assertion about our
  // writer rather than a format limitation to handle.
  if (channels !== 1) {
    throw new Error(`Expected mono WAV, got ${channels} channels: ${path}`)
  }

  return { samples, sampleRate }
}

/**
 * Root-mean-square level of a time range, in dBFS.
 *
 * RMS rather than peak because it reflects loudness over the window, and a
 * single transient — a keyboard click, a door — should not make a quiet stretch
 * look loud. Returns `-Infinity` for digital silence, which compares correctly
 * against any threshold without a special case at the call site.
 */
export function rmsDb(
  samples: Float32Array,
  sampleRate: number,
  startMs: number,
  endMs: number,
): number {
  const from = Math.max(0, Math.floor((startMs * sampleRate) / 1000))
  const to = Math.min(samples.length, Math.floor((endMs * sampleRate) / 1000))
  if (to <= from) return -Infinity

  let sum = 0
  for (let i = from; i < to; i++) {
    const v = samples[i] ?? 0
    sum += v * v
  }

  const rms = Math.sqrt(sum / (to - from))
  return rms <= 0 ? -Infinity : 20 * Math.log10(rms)
}
