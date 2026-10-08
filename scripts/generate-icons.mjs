// ShapeShift - regenerate images/icon*.png with zero dependencies.
// Usage: node scripts/generate-icons.mjs
//
// Draws the unified ShapeShift mark: a rounded obsidian tile with an aurora
// gradient and the two-triangle "shift" glyph used by the popup and the
// control room. Writes real PNG files using only node:zlib.
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const OUT_DIR = join(ROOT, 'images');
const SIZES = [16, 32, 48, 128];

// --- PNG encoding -----------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32 (buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function chunk (type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function encodePng (size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // colour type: RGBA
  ihdr[10] = 0;  // deflate
  ihdr[11] = 0;  // adaptive filtering
  ihdr[12] = 0;  // no interlace

  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0; // filter type: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

// --- artwork ----------------------------------------------------------------

function mix (a, b, t) {
  return a + (b - a) * t;
}

// Aurora ramp: sky -> indigo -> violet, matching --edge in both stylesheets.
function aurora (t) {
  const clamped = Math.max(0, Math.min(1, t));
  if (clamped < 0.55) {
    const k = clamped / 0.55;
    return [mix(0x7D, 0x6D, k), mix(0xD3, 0x8B, k), mix(0xFC, 0xFF, k)];
  }
  const k = (clamped - 0.55) / 0.45;
  return [mix(0x6D, 0xA7, k), mix(0x8B, 0x8B, k), mix(0xFF, 0xFA, k)];
}

// Barycentric coverage for the triangle (x1,y1)-(x2,y2)-(x3,y3) at (px,py).
function triCoverage (px, py, x1, y1, x2, y2, x3, y3) {
  const d1 = (px - x2) * (y1 - y2) - (x1 - x2) * (py - y2);
  const d2 = (px - x3) * (y2 - y3) - (x2 - x3) * (py - y3);
  const d3 = (px - x1) * (y3 - y1) - (x3 - x1) * (py - y1);
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
  return hasNeg && hasPos ? 0 : 1;
}

function drawIcon (size) {
  const rgba = Buffer.alloc(size * size * 4);
  const s = size;
  const radius = s * 0.23;

  // The mark occupies the middle of the tile, matching the SVG's 32x32 box.
  const unit = s / 32;
  const up = [19, 3.4, 30.6, 14.6, 7.4, 14.6];          // upper triangle
  const down = [13, 28.6, 1.4, 17.4, 24.6, 17.4];        // lower triangle

  for (let y = 0; y < s; y++) {
    for (let x = 0; x < s; x++) {
      const i = (y * s + x) * 4;

      // Rounded-square mask with antialiasing.
      const dx = Math.max(radius - x, x - (s - 1 - radius), 0);
      const dy = Math.max(radius - y, y - (s - 1 - radius), 0);
      const corner = Math.sqrt(dx * dx + dy * dy);
      const alpha = Math.max(0, Math.min(1, radius - corner + 0.5));
      if (alpha <= 0) continue;

      // Obsidian base: near-black navy with a faint indigo lift top-left.
      const t = (x + y) / (2 * s);
      let r = mix(0x08, 0x0D, t);
      let g = mix(0x0C, 0x12, t);
      let b = mix(0x18, 0x24, t);

      // Glyph pixels, sampled in the 32x32 design space.
      const ux = (x + 0.5) / unit;
      const uy = (y + 0.5) / unit;
      const inUp = triCoverage(ux, uy, up[0], up[1], up[2], up[3], up[4], up[5]);
      const inDown = triCoverage(ux, uy, down[0], down[1], down[2], down[3], down[4], down[5]);

      if (inUp || inDown) {
        // Gradient runs along the mark's own diagonal, like the SVG.
        const ramp = Math.max(0, Math.min(1, (ux + uy) / 32));
        const [ar, ag, ab] = aurora(ramp * 1.15);
        const strength = inUp ? 1 : 0.58;  // lower triangle is the faded twin
        r = mix(r, ar, strength);
        g = mix(g, ag, strength);
        b = mix(b, ab, strength);
      } else {
        // Subtle aurora bloom behind the glyph so the tile never reads flat.
        const bloom = Math.max(0, 1 - Math.hypot(ux - 16, uy - 16) / 18) ** 2 * 0.22;
        if (bloom > 0) {
          const [ar, ag, ab] = aurora((ux + uy) / 32);
          r = mix(r, ar, bloom);
          g = mix(g, ag, bloom);
          b = mix(b, ab, bloom);
        }
      }

      rgba[i] = Math.round(r);
      rgba[i + 1] = Math.round(g);
      rgba[i + 2] = Math.round(b);
      rgba[i + 3] = Math.round(alpha * 255);
    }
  }
  return rgba;
}

// --- main -------------------------------------------------------------------

mkdirSync(OUT_DIR, { recursive: true });
for (const size of SIZES) {
  const file = join(OUT_DIR, `icon${size}.png`);
  writeFileSync(file, encodePng(size, drawIcon(size)));
  console.log(`wrote ${file}`);
}
console.log(`Generated ${SIZES.length} icons in images/`);
