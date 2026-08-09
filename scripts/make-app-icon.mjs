/**
 * Oratio app icon.
 *
 * Generates build/icon.png at 1024x1024, which electron-builder converts into
 * the .icns. Run: `node scripts/make-app-icon.mjs`
 *
 * Design brief, and why each decision:
 *
 *   The mark is the same idea as the menu-bar icon — a speech bubble with two
 *   offset lines — so the two read as one family. But an app icon is a
 *   different object: it is full colour, it sits on a rounded rectangle Apple
 *   calls a squircle, and it is seen at 1024px in Finder and at 16px in a list
 *   view on the same day. So this is not the tray glyph scaled up; it is drawn
 *   with its own weights.
 *
 *   Colour: a deep indigo-to-violet ground. Chosen against the alternatives —
 *   a recorder app reaches for red (says "REC", and a permanently-red icon in
 *   your Dock reads as always-recording, which is precisely the anxiety this
 *   product should not create) or for waveform-green (generic audio-tool). A
 *   dark, calm ground says "this is a place your meetings live" and stays
 *   legible on both light and dark Dock backgrounds.
 *
 *   The bubble is near-white, so the contrast does the work at small sizes. No
 *   text, no gradient inside the glyph, no drop shadow on the lines: every one
 *   of those disappears below 32px and just muddies the shape.
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import { deflateSync } from 'node:zlib'

const OUT = process.argv[2] ?? 'build'
const SIZE = 1024

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

// ------------------------------------------------------------------ geometry

function segDist(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1
  const dy = y2 - y1
  const len2 = dx * dx + dy * dy
  let t = len2 === 0 ? 0 : ((px - x1) * dx + (py - y1) * dy) / len2
  t = Math.max(0, Math.min(1, t))
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy))
}

/**
 * Signed distance to a superellipse — Apple's "squircle".
 *
 * A plain rounded rectangle looks subtly wrong next to system icons, because
 * macOS uses a continuous curvature shape where the straight edge eases into
 * the corner rather than meeting an arc tangentially.
 *
 * n controls how square the tile reads: n=4 is noticeably round, n=8 is nearly
 * a rectangle. Apple's mask sits around n≈5.5-6 — flatter sides and a tighter
 * corner turn than the n=5 this started at, which looked like a rounded rect
 * from a different OS when placed next to Finder and Safari in the Dock.
 */
function squircleSdf(px, py, cx, cy, r, n = 5.8) {
  const dx = Math.abs(px - cx) / r
  const dy = Math.abs(py - cy) / r
  return Math.pow(Math.pow(dx, n) + Math.pow(dy, n), 1 / n) - 1
}

const lerp = (a, b, t) => a + (b - a) * t
const clamp01 = (v) => Math.max(0, Math.min(1, v))

/** sRGB hex -> [r,g,b] 0..255 */
const rgb = (hex) => [
  parseInt(hex.slice(1, 3), 16),
  parseInt(hex.slice(3, 5), 16),
  parseInt(hex.slice(5, 7), 16),
]

// Palette. Deep indigo at the top-left easing to violet at the bottom-right,
// with a lighter rim at the very top so the tile reads as lit from above the
// way macOS icons are.
const TOP = rgb('#3D35C7')
const BOTTOM = rgb('#8B3FF0')
const RIM = rgb('#9D8CFF')
const BUBBLE = rgb('#FFFFFF')

/**
 * The mark, in 0..1 icon space.
 *
 * Note the bubble sits in the upper ~72% with the tail below it, and the whole
 * group is optically centred rather than geometrically centred — a bubble with
 * a tail has more visual mass at the top, so centring the bounding box makes it
 * look high. Nudged down by 2%.
 */
const NUDGE = 0.02

function bubbleCoverage(px, py) {
  const x = px
  const y = py - NUDGE

  // Rounded-rect body via a distance field, so the edge antialiases cleanly.
  const x0 = 0.22
  const y0 = 0.245
  const x1 = 0.78
  const y1 = 0.62
  const r = 0.105
  const cx = Math.min(Math.max(x, x0 + r), x1 - r)
  const cy = Math.min(Math.max(y, y0 + r), y1 - r)
  const dBody = Math.hypot(x - cx, y - cy) - r

  /**
   * Tail: a wedge under the lower-left of the bubble.
   *
   * Both edges taper. The first version kept the left edge vertical and only
   * angled the right, which made the tail read as a rectangle with a slice
   * taken off rather than as a point — the corner where it met the bubble was
   * a visible notch at 128px. Tapering both sides toward a rounded tip reads
   * as one continuous shape.
   */
  let dTail = 1
  if (y >= 0.55 && y <= 0.755) {
    const t = clamp01((y - 0.55) / 0.205)
    // Ease the taper so it is fuller near the bubble and narrows late.
    const e = t * t
    const left = lerp(0.315, 0.352, e)
    const right = lerp(0.475, 0.368, e)
    if (x >= left && x <= right) dTail = -0.01
    else dTail = Math.min(Math.abs(x - left), Math.abs(x - right))
  }

  return Math.min(dBody, dTail)
}

/** The two knocked-out speaker lines. Distance field, negative inside. */
function linesCoverage(px, py) {
  const x = px
  const y = py - NUDGE
  const h = 0.036
  const d1 = segDist(x, y, 0.295, 0.355, 0.585, 0.355) - h
  const d2 = segDist(x, y, 0.415, 0.5, 0.705, 0.5) - h
  return Math.min(d1, d2)
}

// ------------------------------------------------------------------- render

const SS = 3 // supersampling per axis; 1024px needs less than an 18px glyph
const rgba = Buffer.alloc(SIZE * SIZE * 4)

// Feather width in icon space — one pixel, so edges are crisp but not jagged.
const PX = 1 / SIZE

for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    let rAcc = 0
    let gAcc = 0
    let bAcc = 0
    let aAcc = 0

    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const px = (x + (sx + 0.5) / SS) / SIZE
        const py = (y + (sy + 0.5) / SS) / SIZE

        // Tile mask. Apple's grid leaves the icon at ~90% of the canvas, with
        // the remainder as transparent margin the system uses for shadow.
        const tile = squircleSdf(px, py, 0.5, 0.5, 0.451)
        const tileA = clamp01(0.5 - tile / (PX * 2.5))
        if (tileA <= 0) continue

        // Ground: diagonal gradient, plus a soft rim light along the top edge.
        const t = clamp01((px * 0.45 + py * 0.75))
        let cr = lerp(TOP[0], BOTTOM[0], t)
        let cg = lerp(TOP[1], BOTTOM[1], t)
        let cb = lerp(TOP[2], BOTTOM[2], t)

        const rim = clamp01(1 - py / 0.22) * 0.5
        cr = lerp(cr, RIM[0], rim)
        cg = lerp(cg, RIM[1], rim)
        cb = lerp(cb, RIM[2], rim)

        // The glyph: bubble minus lines.
        const dB = bubbleCoverage(px, py)
        const dL = linesCoverage(px, py)
        const bubbleA = clamp01(0.5 - dB / (PX * 2.5))
        const lineA = clamp01(0.5 - dL / (PX * 2.5))
        const glyphA = bubbleA * (1 - lineA)

        cr = lerp(cr, BUBBLE[0], glyphA)
        cg = lerp(cg, BUBBLE[1], glyphA)
        cb = lerp(cb, BUBBLE[2], glyphA)

        rAcc += cr * tileA
        gAcc += cg * tileA
        bAcc += cb * tileA
        aAcc += tileA
      }
    }

    const n = SS * SS
    const i = (y * SIZE + x) * 4
    const a = aAcc / n
    // Un-premultiply so the PNG carries straight alpha.
    rgba[i] = a > 0 ? Math.round(rAcc / n / a) : 0
    rgba[i + 1] = a > 0 ? Math.round(gAcc / n / a) : 0
    rgba[i + 2] = a > 0 ? Math.round(bAcc / n / a) : 0
    rgba[i + 3] = Math.round(a * 255)
  }
}

mkdirSync(OUT, { recursive: true })
writeFileSync(`${OUT}/icon.png`, encodePng(SIZE, SIZE, rgba))
console.log(`wrote ${OUT}/icon.png (${SIZE}x${SIZE})`)
