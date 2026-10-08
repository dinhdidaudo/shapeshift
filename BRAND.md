# ShapeShift brand

One mark, one aurora, one set of numbers. This file is the human-readable twin of
[`scripts/brand-spec.mjs`](scripts/brand-spec.mjs), which is the machine-readable source of truth.

## The mark

A rounded square rotated 45 degrees reads as a diamond; a solid circle sits at its centre.
Angular frame, round core: the same shape caught in two states, mid-shift. Two primitives,
perfectly balanced, legible from 16 px to 256 px.

| Part | Geometry (32 x 32 design space) | Paint |
|------|--------------------------------|-------|
| Frame | rounded square, `half=8.6`, `rx=4.6`, rotated `45 deg` about `(16,16)`, `stroke-width=2.6` | aurora gradient stroke |
| Core | circle at `(16,16)`, `r=4.4` | aurora gradient fill |
| Tile | corner radius = 32% of the edge | obsidian `#070a17` lifted along the diagonal |

The rotation is the idea: the frame is the axis-aligned square the user started with, the core is
the shape it became. Nothing about the mark is off-centre - balance is what reads as premium at
small sizes.

## The aurora

`--teal` -> `--indigo` -> `--violet`, stops at `0` / `.52` / `1`, running 45 degrees across the mark.
The identical ramp already paints `--edge`, the progress rings and the switch tracks, so the brand
and the interface share one spectrum.

| Stop | Hex | Token |
|------|-----|-------|
| 0 | `#5eead4` | `--teal` |
| .52 | `#818cf8` | `--indigo` / `--accent` |
| 1 | `#c084fc` | `--violet` |

## Where the mark appears

| Surface | File | Form |
|---------|------|------|
| Toolbar + store icon | `images/icon*.png` | obsidian tile + aurora mark |
| Logo master | `images/logo.svg` | transparent background, aurora mark |
| Popup header | `popup/popup.html` | inline SVG, gradient `ssMarkPopup` |
| Control-room sidebar | `options/options.html` | inline SVG, gradient `ssMarkOptions` |
| Score rings | `popup/popup.html`, `options/options.html` | gradient `ssRingPopup` / `ssRingOptions` |

## Rules

- Never hand-edit `images/icon*.png` or `images/logo.svg`; run `pnpm run icons`.
- Change geometry in `scripts/brand-spec.mjs`, then re-run `pnpm run icons`.
- Keep the inline HTML copies matching `markParts()`: `pnpm run verify` fails otherwise.
- Do not introduce a second accent ramp. New UI colour goes through the CSS variables.
- UI tiles keep the 32% corner ratio so the CSS chip and the toolbar icon read as one family.
