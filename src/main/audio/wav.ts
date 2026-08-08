import { open } from 'node:fs/promises'
import type { Writable } from 'node:stream'

const HEADER_BYTES = 44

export interface WavFormat {
  sampleRate: number
  channels: number
  /** Bits per sample. Only 16 is used here. */
  bitDepth?: number
}

/**
 * Write a placeholder RIFF/WAVE header with zeroed sizes.
 *
 * The two size fields are only knowable once recording ends, so they are
 * patched by `finalizeWavHeader`. Crucially, the audio data itself is valid
 * from the first byte — a session killed mid-meeting leaves a file whose
 * samples are all intact and recoverable, even though its header claims a
 * length of zero.
 */
export function writeWavHeader(stream: Writable, fmt: WavFormat): void {
  const { sampleRate, channels, bitDepth = 16 } = fmt
  const byteRate = (sampleRate * channels * bitDepth) / 8
  const blockAlign = (channels * bitDepth) / 8

  const h = Buffer.alloc(HEADER_BYTES)
  h.write('RIFF', 0)
  h.writeUInt32LE(0, 4) // patched later
  h.write('WAVE', 8)
  h.write('fmt ', 12)
  h.writeUInt32LE(16, 16) // PCM chunk size
  h.writeUInt16LE(1, 20) // format = PCM
  h.writeUInt16LE(channels, 22)
  h.writeUInt32LE(sampleRate, 24)
  h.writeUInt32LE(byteRate, 28)
  h.writeUInt16LE(blockAlign, 32)
  h.writeUInt16LE(bitDepth, 34)
  h.write('data', 36)
  h.writeUInt32LE(0, 40) // patched later

  stream.write(h)
}

/** Patch the RIFF and data sizes now that the payload length is known. */
export async function finalizeWavHeader(path: string, dataBytes: number): Promise<void> {
  const fh = await open(path, 'r+')
  try {
    const riff = Buffer.alloc(4)
    riff.writeUInt32LE(HEADER_BYTES - 8 + dataBytes, 0)
    await fh.write(riff, 0, 4, 4)

    const data = Buffer.alloc(4)
    data.writeUInt32LE(dataBytes, 0)
    await fh.write(data, 0, 4, 40)
  } finally {
    await fh.close()
  }
}

/**
 * Recover a WAV whose header was never patched (the process died mid-session).
 * Infers the payload length from the file size on disk.
 */
export async function repairWavHeader(path: string, fileSize: number): Promise<void> {
  if (fileSize <= HEADER_BYTES) return
  await finalizeWavHeader(path, fileSize - HEADER_BYTES)
}
