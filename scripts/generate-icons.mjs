// ShapeShift - regenerate images/icon*.png with zero dependencies.
// Usage: node scripts/generate-icons.mjs
//
// Draws the ShapeShift mark (deep-space tile + aurora slash) at every size
// declared in manifest.json and writes real PNG files using only node:zlib.
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

function drawIcon (size) {
  const rgba = Buffer.alloc(size * size * 4);
  const radius = size * 0.22;
  const cx = (size - 1) / 2;
  const cy = (size - 1) / 2;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;

      // Rounded-square mask with 1px antialiasing.
      const dx = Math.max(radius - x, x - (size - 1 - radius), 0);
      const dy = Math.max(radius - y, y - (size - 1 - radius), 0);
      const corner = Math.sqrt(dx * dx + dy * dy);
      const alpha = Math.max(0, Math.min(1, radius - corner + 0.5));
      if (alpha <= 0) continue;

      // Deep-space base: dark navy to indigo diagonal.
      const t = (x + y) / (2 * size);
      let r = mix(0x0A, 0x1B, t);
      let g = mix(0x0E, 0x1F, t);
      let b = mix(0x1E, 0x4A, t);

      // Aurora slash from bottom-left to top-right.
      const dist = Math.abs((x - y) - (size * 0.12)) / (size * 0.26);
      if (dist < 1) {
        const glow = (1 - dist) ** 2;
        r = mix(r, 0x4F, glow);
        g = mix(g, 0xE3, glow);
        b = mix(b, 0xC8, glow);
      }

      // Bright core where the slash crosses the centre.
      const coreDist = Math.hypot(x - cx, y - cy) / (size * 0.18);
      if (coreDist < 1) {
        const core = (1 - coreDist) ** 2 * 0.85;
        r = mix(r, 0xE9, core);
        g = mix(g, 0xFF, core);
        b = mix(b, 0xF6, core);
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
