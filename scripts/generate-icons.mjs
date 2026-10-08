// ShapeShift - regenerate images/icon*.png and images/logo.svg.
// Usage: node scripts/generate-icons.mjs
//
// The canonical mark lives in scripts/brand-spec.mjs. This script rasterises
// that exact geometry and writes the SVG master from the same string, so the
// toolbar icon, the popup, the control room and the README cannot drift apart.
// PNG bytes come from node:zlib alone - no image dependency, nothing fetched.
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MARK, AURORA, markSvg } from './brand-spec.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const OUT_DIR = join(ROOT, 'images');

// icon.png is the store/readme master (not referenced by manifest.json); the
// numbered sizes are what the manifest loads.
const OUTPUTS = [
  ['icon.png', 256],
  ['icon16.png', 16],
  ['icon32.png', 32],
  ['icon48.png', 48],
  ['icon128.png', 128]
];
const LOGO = ['logo.svg', 128];

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

function hexToRgb (hex) {
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16)
  ];
}

// Same stops, same order, same ramp as the SVG gradient.
const RAMP = AURORA.map((stop) => ({ at: Number(stop.offset), rgb: hexToRgb(stop.color) }));

function aurora (t) {
  const v = Math.max(0, Math.min(1, t));
  for (let i = 1; i < RAMP.length; i++) {
    const a = RAMP[i - 1];
    const b = RAMP[i];
    if (v <= b.at || i === RAMP.length - 1) {
      const k = b.at === a.at ? 0 : (v - a.at) / (b.at - a.at);
      return [
        mix(a.rgb[0], b.rgb[0], k),
        mix(a.rgb[1], b.rgb[1], k),
        mix(a.rgb[2], b.rgb[2], k)
      ];
    }
  }
  return RAMP[RAMP.length - 1].rgb;
}

// Signed distance to a rounded rectangle centred on the origin.
function roundRectSdf (px, py, hw, hh, r) {
  const dx = Math.abs(px) - (hw - r);
  const dy = Math.abs(py) - (hh - r);
  return Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) + Math.min(Math.max(dx, dy), 0) - r;
}

// Rotate the sample into the frame's local axes, then measure the square.
function frameSdf (px, py, half, r) {
  const a = (-MARK.square.rotation * Math.PI) / 180;
  const dx = px - MARK.size;
  const dy = py - MARK.size;
  const lx = dx * Math.cos(a) - dy * Math.sin(a);
  const ly = dx * Math.sin(a) + dy * Math.cos(a);
  return roundRectSdf(lx, ly, half, half, r);
}

// Coverage of a shape from its signed distance (1 px antialiasing band).
function coverage (sdf) {
  return Math.max(0, Math.min(1, 0.5 - sdf));
}

function drawIcon (size) {
  const rgba = Buffer.alloc(size * size * 4);
  const unit = size / MARK.viewBox;
  const tileR = size * MARK.tileRadiusRatio;
  const half = size / 2;

  const s = MARK.square;
  const outerHalf = s.half + MARK.stroke / 2;
  const innerHalf = s.half - MARK.stroke / 2;
  const outerR = s.radius + MARK.stroke / 2;
  const innerR = Math.max(s.radius - MARK.stroke / 2, 0.2);
  const coreR = MARK.core.r;

  // The SVG gradient runs corner to corner across (4,4)-(28,28).
  const rampSpan = 48;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;

      // Obsidian rounded tile, antialiased.
      const tile = roundRectSdf(x + 0.5 - half, y + 0.5 - half, half, half, tileR);
      const alpha = coverage(tile);
      if (alpha <= 0) continue;

      // Base: --bg-0 lifted along the diagonal so the tile never reads flat.
      const t = (x + y) / (2 * size);
      let r = mix(0x07, 0x0D, t);
      let g = mix(0x0A, 0x12, t);
      let b = mix(0x17, 0x24, t);

      const ux = (x + 0.5) / unit;
      const uy = (y + 0.5) / unit;
      const ramp = (ux + uy - 8) / rampSpan;

      // Frame = outer rounded square minus the inner one, matching the SVG
      // stroke centred on the path.
      const ring = Math.max(0,
        coverage(frameSdf(ux, uy, outerHalf, outerR) * unit) -
        coverage(frameSdf(ux, uy, innerHalf, innerR) * unit));
      const core = coverage((Math.hypot(ux - MARK.size, uy - MARK.size) - coreR) * unit);
      const glyph = Math.max(ring, core);

      if (glyph > 0) {
        const [ar, ag, ab] = aurora(ramp);
        r = mix(r, ar, glyph);
        g = mix(g, ag, glyph);
        b = mix(b, ab, glyph);
      } else if (size >= 48) {
        // Faint aurora bloom behind the mark. Skipped on the toolbar sizes,
        // where it only muddies the 16 px silhouette.
        const bloom = Math.max(0, 1 - Math.hypot(ux - MARK.size, uy - MARK.size) / 15) ** 2 * 0.16;
        if (bloom > 0) {
          const [ar, ag, ab] = aurora(ramp);
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
for (const [name, size] of OUTPUTS) {
  const file = join(OUT_DIR, name);
  writeFileSync(file, encodePng(size, drawIcon(size)));
  console.log(`wrote ${file}`);
}

const [logoName, logoSize] = LOGO;
const logoFile = join(OUT_DIR, logoName);
writeFileSync(logoFile, `<?xml version="1.0" encoding="UTF-8"?>\n${markSvg({ id: 'ssLogo', size: logoSize })}\n`);
console.log(`wrote ${logoFile}`);
console.log(`Generated ${OUTPUTS.length} icons + ${logoName} in images/`);
