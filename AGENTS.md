# AGENTS.md — ShapeShift

Guidance for AI coding agents (and humans acting like them) working in this repository.

## 1. What this project is

**ShapeShift** is a Chromium Manifest V3 extension that gives every website a different, stable device fingerprint. Created by **Phạm Văn Định**, it ships with a premium control-room UI.

Core idea: derive a deterministic PRNG seed from `(persistent salt, page origin)` and use it to perturb fingerprinting surfaces — Canvas, WebGL, Audio, WebRTC, Fonts, Screen, Navigator, Timezone, Sensors, Touch, Media, Geolocation, Detection.

## 2. Repository layout

```
manifest.json                 MV3 manifest (permissions, content scripts, WAR)
background/service-worker.js  Rotation alarms, stats aggregation, message router
core/                         Pure engine, no DOM assumptions
  config.js                     Config load/merge/defaults from chrome.storage
  hash.js                       Deterministic seed derivation (KDF)
  prng.js                       Xoshiro128** + mulberry32 PRNGs
  salts.js                      Persistent per-install salt management
  timing.js                     Timing/jitter helpers used by hooks
  stealth.js                    Patch tracking + global cleanup
content/                      Content scripts (ISOLATED world)
  hooks_*.js                    One file per protected surface
  bootstrap.js                  Builds PRNG/env from config + origin
  stats_tracker.js              Counts intercepted reads
  content_main.js               Installs all registered hooks
  page_world_injector.js        MAIN-world bridge + WebGL patch (page context)
  test_fingerprint.js / _page.js  Self-test harness
popup/                        Toolbar popup — status, per-site toggle, rotation
options/                      Full-page settings UI (the "control room")
scripts/                      Node utilities (verify, build, icons, migration)
```

## 3. Non-negotiable rules

1. **Original work only.** Do not add copied code, attribution, or references to any third-party project, and do not introduce a `refers/` directory.
2. **Namespace is `ss` / `ss`-prefixed.** The retired `fp`-prefixed namespace must not come back. New globals, storage keys, and message types must use the `ss` prefix.
   - Storage keys: `ssConfig`, `ss_salt`, `ss_stats`, `ss_site_settings`, `ss_rotation_info`
   - Globals: `ssConfig`, `ssPRNG`, `ssNoise`, `ssEnv`, `ssReady`, `ssStealth`, ...
   - Messages: `SS_STATS`, `SS_INIT_PAGE_HOOKS`
3. **No network calls, ever.** The extension is fully offline and collects nothing. Do not add `fetch`/`XMLHttpRequest`/analytics to runtime code.
4. **Determinism is the product.** The same `(salt, origin, config)` must always produce the same spoofed values. Never introduce `Math.random()` or `Date.now()` into a seed-derivation path — use the seeded PRNG from `core/prng.js`.
5. **Isolated vs MAIN world.** Anything a page can observe must be patched in the MAIN world (`page_world_injector.js` + `*_page_patch.js`). ISOLATED-world files only load config and compute values. Do not `eval` page code from an ISOLATED script.
6. **Every hook is reversible and enumerable-safe.** Register through `globalThis.ssHookInstallers`, guard with `ssStealth.isPatched()` / `markPatched()`, and keep patched properties non-enumerable when they shadow natives.

## 4. Adding a new protected surface

1. Create `content/hooks_<surface>.js` following the existing file shape: push an installer onto `globalThis.ssHookInstallers`, guard with `ssStealth`, read values from `ssConfig`, perturb using `ssPRNG`, and call `ssStatsTracker.increment('<surface>Reads')`.
2. Add the file to the **ISOLATED** `content_scripts[0].js` array in `manifest.json`, before `bootstrap.js`.
3. If the page must see the patch, add a MAIN-world counterpart and list it in `web_accessible_resources` if it is injected by URL.
4. Add a toggle + default in both `options/options.js` (`DEFAULTS` and a `GROUPS` entry) and the popup module list in `popup/popup.js` if it deserves a chip.
5. Document it in `README.md` (feature list + Protected APIs table).

## 5. UI conventions

The UI is intentionally opinionated: deep-space glass, aurora accents, Inter for text and JetBrains Mono for numerics.

- Reuse the CSS variables in `options/options.css` and `popup/popup.css` (`--bg-0`, `--surface`, `--stroke`, `--accent`, `--text-dim`, ...). Do not hard-code new hex colors unless you also add a variable.
- Accent gradient = `linear-gradient(120deg, var(--accent), var(--accent-2))`.
- Interactive elements need `:hover`, `:active`, and `:focus-visible` states.
- Respect `@media (prefers-reduced-motion: reduce)`.
- Build DOM with `document.createElement` + `textContent`. Never inject user or page-derived strings via `innerHTML`.
- All user-facing copy is English, sentence case, no trailing period on labels.

## 6. Storage contract

| Key | Shape | Owner |
|---|---|---|
| `ssConfig` | flat config object (see `options/options.js` `DEFAULTS`) | options page |
| `ss_salt` | hex string | `core/salts.js` |
| `ss_stats` | counters, e.g. `totalCanvasReads`, `sitesProtected` | `stats_tracker.js` / service worker |
| `ss_site_settings` | `{ "<origin>": { enabled: boolean, reason?: string } }` | popup + options |
| `ss_rotation_info` | `{ lastRotation: ISO, rotationCount: number }` | service worker |

Absence of an origin in `ss_site_settings` means **protection is ON** for that origin. A pause is recorded explicitly as `{ enabled: false }`.

## 7. Commands

```bash
pnpm run verify       # structural + syntax check of the whole extension
pnpm run lint         # same script with lint mode
pnpm run test         # alias for verify
pnpm run build        # package the runtime tree into dist/
pnpm run icons        # regenerate images/icon*.png
pnpm run migrate      # one-shot fp* -> ss* migration (idempotent)
```

Run `pnpm run verify` before every commit. It is the project's only automated gate.

## 8. Manual verification checklist

1. `chrome://extensions` → Developer mode → **Load unpacked** → pick the repo root.
2. Open https://amiunique.org/fingerprint and confirm the console shows `[shapeshift][page] All hooks installed successfully`.
3. Toggle the popup switch off, reload, confirm the site now sees real values.
4. Press **Generate new identity** in Settings → Identity, reload, confirm the fingerprint changed but stays stable across further reloads.
5. Verify no `fp`-prefixed keys remain in `chrome.storage.local`.

## 9. Commit conventions

The full standard — types, scopes, body and footer rules, breaking changes — lives in
[`CONTRIBUTING.md`](CONTRIBUTING.md) section 5. The short version:

- Conventional Commits: `feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `test:`, `perf:`, `build:`, `ci:`, `style:`, `revert:`.
- Scope by area where useful: `feat(options): ...`, `fix(webgl): ...`.
- Subject is imperative, lowercase, no trailing period, max 72 characters.
- `BREAKING CHANGE:` footer plus `!` after the type for breaking changes.
- One logical change per commit. Never commit `node_modules/` or build output.
- Keep the working tree clean: `git status` must show only intended files.
