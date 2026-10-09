// ShapeShift - the single source of truth for the brand mark.
//
// The concept is the product in one glyph: a rounded square rotated 45 degrees
// reads as a diamond, and a solid circle sits at its centre. Angular frame,
// round core - the same shape caught in two states, mid-shift. One idea, two
// primitives, legible from 16 px to 256 px.
//
//   frame  rounded square rotated 45 degrees, drawn as an aurora outline
//   core   solid circle at the centre: the shape the frame became
//   aurora teal -> indigo -> violet, the exact ramp that already paints --edge,
//          the progress rings and the switch tracks
//
// Change a number here, run `pnpm run icons`, and `pnpm run verify` proves the
// inline copies in popup/options still match.

const round = (value) => String(Number(value.toFixed(3)));

export const MARK = Object.freeze({
  viewBox: 32,
  size: 16, // centre of the design space
  square: Object.freeze({ half: 8.6, radius: 4.6, rotation: 45 }),
  core: Object.freeze({ r: 4.4 }),
  stroke: 2.6,
  // Corner radius of the obsidian tile as a fraction of its edge. The UI tiles
  // use the same ratio (.brand-mark 10/31, .mark 13/42).
  tileRadiusRatio: 0.32
});

export const AURORA = Object.freeze([
  Object.freeze({ offset: '0', color: '#5eead4' }),
  Object.freeze({ offset: '.52', color: '#818cf8' }),
  Object.freeze({ offset: '1', color: '#c084fc' })
]);

function stops () {
  return AURORA.map((stop) => `<stop offset="${stop.offset}" stop-color="${stop.color}"/>`).join('');
}

// The exact fragments the inline HTML copies have to carry. Exported so
// scripts/verify.mjs can compare against the spec instead of maintaining a
// second, hand-edited copy of the same numbers.
export function markParts () {
  const s = MARK.square;
  const offset = MARK.size - s.half;
  const edge = s.half * 2;
  return {
    transform: `rotate(${s.rotation} ${MARK.size} ${MARK.size})`,
    rect: `x="${round(offset)}" y="${round(offset)}" width="${round(edge)}" height="${round(edge)}" rx="${round(s.radius)}"`,
    circle: `cx="${MARK.size}" cy="${MARK.size}" r="${round(MARK.core.r)}"`
  };
}

// 45 degrees across the glyph's own bounding box.
export function markGradient (id) {
  return `<linearGradient id="${id}" x1="4" y1="4" x2="28" y2="28" gradientUnits="userSpaceOnUse">${stops()}</linearGradient>`;
}

// The mark as an inline SVG string. `id` namespaces the gradient so several
// copies can share one document without stealing each other's paint server.
export function markSvg ({ id, size }) {
  const parts = markParts();
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="${size}" height="${size}" fill="none">` +
    `<defs>${markGradient(id)}</defs>` +
    `<g transform="${parts.transform}">` +
    `<rect ${parts.rect} stroke="url(#${id})" stroke-width="${round(MARK.stroke)}"/>` +
    '</g>' +
    `<circle ${parts.circle} fill="url(#${id})"/>` +
    '</svg>';
}

// The same aurora laid out for the 96x96 score rings, which reference it from
// CSS with url(#id).
export function ringGradient (id) {
  return `<linearGradient id="${id}" x1="8" y1="8" x2="88" y2="88" gradientUnits="userSpaceOnUse">${stops()}</linearGradient>`;
}
