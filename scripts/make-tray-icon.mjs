/**
 * Oratio tray icon — final.
 *
 * A speech bubble with two offset lines knocked out of it.
 *
 * Why this mark: the bubble says "a conversation", and the two lines are
 * different lengths and horizontally offset so they read as two speakers taking
 * turns rather than as a waveform. That is the product's one non-negotiable
 * idea — mic and system are captured as two tracks and never mixed, which is
 * what buys speaker attribution for free — expressed as the thing that split
 * actually gives you.
 *
 * Why knocked out rather than stroked: a menu-bar template image is pure
 * coverage (macOS discards colour and keeps alpha), so a solid shape with holes
 * carries far more presence at 18px than 1px outlines, which grey out into
 * mush. Every dimension below is tuned against the 18px render, not the 144px
 * one — a mark that only works when enlarged is the wrong mark.
 *
 * Emitted at 18px and 36px (@2x). Electron picks the right one per display.
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import { deflateSync } from 'node:zlib'

const OUT = process.argv[2] ?? 'resources'

function encodePng(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4)
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(body) >>> 0)
    return Buffer.concat([len, body, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

let CRC_TABLE = null
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256)
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      CRC_TABLE[n] = c
    }
  }
  let c = -1
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return c ^ -1
}

/** 8x8 supersampling per pixel — what keeps the corners and tail from aliasing. */
const SS = 8
function render(size, shape) {
  const rgba = Buffer.alloc(size * size * 4)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let hits = 0
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          if (shape((x + (sx + 0.5) / SS) / size, (y + (sy + 0.5) / SS) / size)) hits++
        }
      }
      const i = (y * size + x) * 4
      // Alpha only; RGB stays 0. macOS keeps just the alpha for a template
      // image and inverts it for light and dark menu bars.
      rgba[i + 3] = Math.round((hits / (SS * SS)) * 255)
    }
  }
  return rgba
}

function segDist(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1
  const dy = y2 - y1
  const len2 = dx * dx + dy * dy
  let t = len2 === 0 ? 0 : ((px - x1) * dx + (py - y1) * dy) / len2
  t = Math.max(0, Math.min(1, t))
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy))
}

const roundRect = (x0, y0, x1, y1, r) => (px, py) => {
  const cx = Math.min(Math.max(px, x0 + r), x1 - r)
  const cy = Math.min(Math.max(py, y0 + r), y1 - r)
  return Math.hypot(px - cx, py - cy) <= r
}

/** A rounded horizontal bar: one speaker's turn. */
const line = (x0, x1, cy, halfH) => (px, py) => segDist(px, py, x0, cy, x1, cy) <= halfH

/**
 * The mark.
 *
 * Proportions worth keeping if this is ever redrawn:
 *  - the bubble is inset ~10% all round, so it never touches the menu-bar edge
 *  - the two lines are 0.055 half-height ≈ 2px at 18px, the thinnest hole that
 *    survives without closing up
 *  - they are offset by 0.14 horizontally, which is what makes them read as two
 *    speakers rather than one waveform
 *  - the tail is on the LEFT, matching the reading direction of the lines
 */
function mark(px, py) {
  const body = roundRect(0.09, 0.13, 0.91, 0.72, 0.16)

  /**
   * Tail: a short, WIDE triangle under the left of the bubble.
   *
   * Two things learned by rendering it at 18px rather than trusting the 144px
   * version. It must stop short of the edge — a tail clipped by the canvas
   * reads as a rendering fault, and the menu bar gives no margin to lose. And
   * it must stay fat: the first version tapered to a point and simply vanished
   * below about 3px, because a triangle that is elegant at 144px is one
   * antialiased grey pixel at 18px. It ends at 0.86 with real width still left.
   */
  const tail = (x, y) => {
    if (y < 0.66 || y > 0.86) return false
    const t = (y - 0.66) / 0.2
    return x > 0.22 && x < 0.46 - t * 0.14
  }

  const lines = (x, y) =>
    // upper: starts left, shorter — the first voice
    line(0.23, 0.6, 0.31, 0.055)(x, y) ||
    // lower: starts right of it, longer — the reply
    line(0.37, 0.77, 0.53, 0.055)(x, y)

  return (body(px, py) || tail(px, py)) && !lines(px, py)
}

mkdirSync(OUT, { recursive: true })
writeFileSync(`${OUT}/trayTemplate.png`, encodePng(18, 18, render(18, mark)))
writeFileSync(`${OUT}/trayTemplate@2x.png`, encodePng(36, 36, render(36, mark)))
// A large render for eyeballing detail; not shipped.
if (process.env.PREVIEW) {
  writeFileSync(`${OUT}/preview@8x.png`, encodePng(144, 144, render(144, mark)))
}
console.log(`wrote trayTemplate.png (18) and trayTemplate@2x.png (36) to ${OUT}/`)
