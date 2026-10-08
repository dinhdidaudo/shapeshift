# Build and packaging

ShapeShift is plain JavaScript and loads unpacked. There is **no bundler, no
transpiler and no runtime dependency** — the files in this repository are the
files Chrome runs.

## Prerequisites

- Node.js >= 18.0.0 (used only for the scripts in `scripts/`)
- npm >= 9.0.0 (only to run the script shortcuts)

There is nothing to `npm install`. Every script uses only the Node standard
library.

## Commands

| Command | What it does |
|---|---|
| `npm run verify` | Structural + syntax gate for the whole extension. **Run before every commit.** |
| `npm run lint` | The same gate in lint mode. |
| `npm test` | Runs the structural gate **and** the core unit tests. |
| `npm run build` | Runs the gate, then copies the runtime tree to `dist/`. |
| `npm run icons` | Regenerates `images/icon*.png` (pure Node, no image libraries). |
| `npm run migrate` | One-shot `fp*` -> `ss*` namespace migration. Idempotent. |

## Packaging

```bash
npm run build            # -> dist/
node scripts/build.mjs --out some/other/dir
```

The build runs `scripts/verify.mjs` first and aborts if the gate fails. It then
copies the runtime tree (`manifest.json`, `background/`, `core/`, `content/`,
`popup/`, `options/`, `images/`) plus the licence and changelog into `dist/`.
`dist/` is git-ignored.

## Loading the extension

### Chrome / Edge

1. Run `npm run verify`.
2. Open `chrome://extensions/`.
3. Enable **Developer mode**.
4. Click **Load unpacked**.
5. Select either the repository root (development) or `dist/` (packaged).

Firefox and Safari are not supported: the manifest targets Chromium MV3 and the
hooks rely on `world: "MAIN"` content scripts.

## Project layout

```
manifest.json                 MV3 manifest (permissions, content scripts, WAR)
background/service-worker.js  Rotation alarms, stats aggregation, message router
core/                         Pure engine, no DOM assumptions
  config.js                     Config load/merge/defaults from chrome.storage
  hash.js                       Deterministic seed derivation (KDF)
  prng.js                       Xoshiro128** + mulberry32 PRNGs
  salts.js                      Persistent per-install salt management
  timing.js                     Timing/jitter helpers
  stealth.js                    Patch tracking + global cleanup
content/                      Content scripts (ISOLATED world)
  hooks_*.js                    One file per protected surface
  bootstrap.js                  Builds PRNG/env from config + origin
  stats_tracker.js              Counts intercepted reads
  content_main.js               Installs all registered hooks
  page_world_injector.js        MAIN-world bridge + WebGL patch
  test_fingerprint.js / _page.js  Self-test harness
popup/                        Toolbar popup
options/                      Full-page settings UI
scripts/                      Node utilities (verify, test, build, icons, migration)
refers/                       READ-ONLY upstream reference. Never edit.
```

## Verification gate

`scripts/verify.mjs` is the structural gate. It checks:

- `manifest.json` parses, uses MV3, and every referenced path exists
- hooks load before `bootstrap.js`, and `content_main.js` loads last
- every runtime JavaScript file parses (`node --check`)
- no retired `fp*` identifiers outside `refers/`
- no `innerHTML` in the popup or options controllers
- every `chrome.storage.local` key matches the documented storage contract
- required project files are present

`scripts/test.mjs` covers the deterministic core, which the structural gate
cannot see. It loads `core/hash.js`, `core/prng.js` and `core/config.js` and
pins the contract that makes per-origin shaping stable:

- `ssHashString` is deterministic, uint32-bounded and input-separating
- the strong KDF is deterministic and separates salt, origin and iteration count
- the PRNG is reproducible for a seed, stays in `[0,1)` and separates seeds
- `ssNormalizeConfig` folds legacy flat keys into their nested groups
- the canvas noise default stays identical in `core/config.js`, the ISOLATED
  hook and the MAIN-world injector

## Troubleshooting

### The extension does not load

- Ensure `manifest.json` is at the root you selected.
- Run `npm run verify` and fix the reported failure.
- Check the DevTools console for `[shapeshift]` errors.

### Changes not reflected

- Reload the extension from `chrome://extensions/`, then reload the page.
- Confirm **Settings -> Advanced -> Debug logging** is on and look for
  `[shapeshift][page] All hooks installed successfully`.
