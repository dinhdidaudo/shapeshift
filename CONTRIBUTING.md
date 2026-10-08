# Contributing to ShapeShift

Thanks for taking the time to contribute. This document explains how to set up the project, what the code standards are, and — most importantly — **how to write commit messages** in this repository.

ShapeShift is a Chromium Manifest V3 extension that gives every website a different, stable device fingerprint. It is deliberately small, offline, and deterministic. Contributions that respect those three properties are welcome.

---

## Table of contents

1. [Before you start](#1-before-you-start)
2. [Setting up](#2-setting-up)
3. [Project layout](#3-project-layout)
4. [Coding standards](#4-coding-standards)
5. [Commit message standard](#5-commit-message-standard)
6. [Branch naming](#6-branch-naming)
7. [Pull request process](#7-pull-request-process)
8. [Reporting bugs](#8-reporting-bugs)
9. [License](#9-license)

---

## 1. Before you start

Read [`AGENTS.md`](AGENTS.md) first. It is the authoritative description of the architecture, the non-negotiable rules, and the storage contract. If a change conflicts with `AGENTS.md`, the change is wrong — or `AGENTS.md` must be updated in the same commit.

Three rules are absolute:

- **No network calls.** No `fetch`, no `XMLHttpRequest`, no analytics. The extension is fully offline.
- **Determinism.** The same `(salt, origin, config)` must always produce the same spoofed values. Never introduce `Math.random()` or `Date.now()` into a seed-derivation path.
- **Original work only.** ShapeShift is an independent project: do not add copied code, attribution, or references to any third-party project.

---

## 2. Setting up

```bash
# 1. Clone
git clone git@github.com:dinhdidaudo/shapeshift.git
cd shapeshift

# 2. Verify the working tree is healthy
pnpm run verify

# 3. Load it in Chrome
#    chrome://extensions -> Developer mode -> Load unpacked -> select the repo root
```

There are no runtime dependencies and nothing to install. `pnpm run verify` uses only Node's standard library.

### Commands

| Command | What it does |
|---|---|
| `pnpm run verify` | Structural + syntax gate. **Run before every commit.** |
| `pnpm run lint` | Same gate in lint mode. |
| `pnpm test` | Alias for `pnpm run verify`. |
| `pnpm run build` | Runs the gate, then packages the runtime tree into `dist/`. |
| `pnpm run icons` | Regenerate `images/icon*.png`. |
| `pnpm run migrate` | One-shot `fp*` -> `ss*` migration. Idempotent. |

`pnpm run verify` is the project's only automated gate. A pull request that does not pass it will not be merged.

---

## 3. Project layout

```
manifest.json                 MV3 manifest
background/service-worker.js  Rotation alarms, stats aggregation, message router
core/                         Pure engine, no DOM assumptions
content/                      Content scripts (ISOLATED world) + MAIN-world patches
popup/                        Toolbar popup
options/                      Full-page settings UI
scripts/                      Node utilities (verify, build, icons, migration)
```

---

## 4. Coding standards

### JavaScript

- Plain ES2020+, no build step for runtime files. `scripts/` may use ES modules.
- No `innerHTML` in `popup/` or `options/`. Build DOM with `document.createElement` and `textContent`. `pnpm run verify` enforces this.
- Register hooks through `globalThis.ssHookInstallers`; guard with `ssStealth.isPatched()` / `markPatched()`.
- Keep patched properties non-enumerable when they shadow natives.
- Namespace everything with `ss`: storage keys (`ssConfig`, `ss_salt`, ...), globals (`ssPRNG`, `ssEnv`, ...), message types (`SS_STATS`, ...). The legacy `fp` prefix is retired.

### UI

The UI is opinionated: deep-space glass, aurora accents, Inter for text, JetBrains Mono for numerics.

- Reuse the CSS variables in `options/options.css` and `popup/popup.css`. Do not hard-code new hex colors unless you also add a variable.
- Interactive elements need `:hover`, `:active`, and `:focus-visible` states.
- Respect `@media (prefers-reduced-motion: reduce)`.
- All user-facing copy is English, sentence case, no trailing period on labels.

### Adding a protected surface

1. Create `content/hooks_<surface>.js` following the existing file shape.
2. Add it to the ISOLATED `content_scripts[0].js` array in `manifest.json`, **before** `bootstrap.js`.
3. If the page must observe the patch, add a MAIN-world counterpart.
4. Add a toggle and default in `options/options.js` and a chip in `popup/popup.js` if it deserves one.
5. Document it in `README.md` (feature list + Protected APIs table).

---

## 5. Commit message standard

This repository uses **[Conventional Commits v1.0.0](https://www.conventionalcommits.org/en/v1.0.0/)**. Every commit on `main` must follow the format below. Commit messages are read by humans and by tooling; treat them as part of the product.

### 5.1 Format

```
<type>(<scope>): <subject>

<body>

<footer>
```

- **`type`** — required, lowercase, from the list below.
- **`scope`** — optional, lowercase, names the area you touched.
- **`subject`** — required, imperative mood, no trailing period, max 72 characters, first letter lowercase.
- **`body`** — optional, wrapped at 72 characters, separated from the subject by one blank line. Explain **what** and **why**, not how.
- **`footer`** — optional. Breaking changes and issue references live here.

### 5.2 Types

| Type | Use for |
|---|---|
| `feat` | A new user-facing capability or a new protected surface. |
| `fix` | A bug fix that changes observable behavior. |
| `perf` | A change that improves speed or memory without changing behavior. |
| `refactor` | A change that neither fixes a bug nor adds a feature. |
| `docs` | Documentation only — `README.md`, `AGENTS.md`, `CONTRIBUTING.md`, `BUILD.md`, `CHANGELOG.md`, code comments. |
| `test` | Adding or correcting tests, including the self-test harness in `content/`. |
| `build` | Build system, packaging, `webpack.config.js`, `package.json` scripts. |
| `ci` | Continuous integration configuration. |
| `chore` | Maintenance that does not fit any of the above — dependency bumps, `.gitignore` edits. |
| `style` | Formatting only, no change in meaning. |
| `revert` | Reverts a previous commit. The body must reference the reverted SHA. |

### 5.3 Scopes

Use a scope when the change is confined to one area. Omit it when the change is repo-wide.

| Scope | Area |
|---|---|
| `canvas`, `webgl`, `audio`, `webrtc`, `fonts`, `screen`, `navigator`, `timezone`, `sensors`, `touch`, `media`, `geolocation`, `detection` | A single protected surface (`content/hooks_*.js`). |
| `core` | `core/` — PRNG, hashing, salts, stealth, timing. |
| `content` | Content-script infrastructure that is not a single surface. |
| `background` | The service worker. |
| `popup` | The toolbar popup. |
| `options` | The settings page. |
| `storage` | The storage contract itself. |
| `manifest` | `manifest.json`. |
| `scripts` | `scripts/`. |
| `deps` | `package.json` dependencies. |
| `release` | Version bumps and release preparation. |

### 5.4 Subject line rules

- **Imperative mood.** Write `add geolocation hook`, not `added` or `adds`.
- **No trailing period.**
- **Lowercase after the colon.**
- **Max 72 characters** for the whole first line, including the type and scope.
- **Be specific.** `fix: bug` is not acceptable. `fix(webgl): stop NaN leaking from getParameter` is.

Good:

```
feat(timezone): add IANA zone aliasing per origin
fix(canvas): keep toDataURL stable across reloads
perf(core): skip PRNG warm-up when the seed is unchanged
docs: document the storage contract in CONTRIBUTING.md
```

Bad:

```
Update stuff                     <- no type
feat: Added a new thing.         <- past tense, trailing period
fix:bug                          <- missing space
docs(README) Fix typo            <- capitalised subject, no colon
```

### 5.5 Body

The body is required when the subject alone does not explain the change. Wrap at 72 characters. Cover:

- **What** changed.
- **Why** it was needed — the bug, the limitation, the user report.
- **Anything a reviewer must know** — a tradeoff, a rejected alternative, a follow-up.

```
fix(webrtc): stop leaking the local IP through mDNS candidates

The SDP filter only rewrote host candidates, so mDNS hostnames still
resolved to the real address on networks without a resolver. The filter
now drops mDNS candidates entirely and rewrites the rest.

Verified against the WebRTC leak test in the manual checklist.
```

### 5.6 Breaking changes

A breaking change must be called out twice: once with `!` after the type or scope, and once in a `BREAKING CHANGE:` footer.

```
feat(storage)!: rename ssConfig keys to the new surface names

All per-surface keys are now `<surface>Enabled` instead of `enable<Surface>`.
Existing installs are migrated on first run.

BREAKING CHANGE: configs written by v2.0.0 are read-only until the
migration in core/config.js runs. Downgrading requires clearing
chrome.storage.local.
```

The footer may also be written as `BREAKING-CHANGE:`.

### 5.7 Footers

- Close issues with `Closes #12` or `Fixes #12` on their own line.
- Reference related work with `Refs #34`.
- Attribute co-authors with `Co-authored-by: Name <email>`.
- Multiple footers are separated by blank lines.

```
fix(screen): use the real device pixel ratio when spoofing bounds

Fixes #18
Co-authored-by: Nguyen Van A <a@example.com>
```

### 5.8 Commit hygiene

- **One logical change per commit.** If you need the word "and" in the subject, split the commit.
- **Never commit** `node_modules/`, `dist/`, `build/`, `*.zip`, or any `.env` file. `.gitignore` already covers these.
- **Run `pnpm run verify` before committing.** It must print `PASS`.
- **Keep the tree clean.** `git status` must show only files you intend to commit.
- **Do not rewrite history on `main`.** Rebase your feature branch instead.

### 5.9 Examples for this repository

```
feat(sensors): add deviceorientation noise for per-origin bearings
fix(options): persist the preset selection across reloads
docs(agents): clarify the MAIN-world patching rule
refactor(core): extract seed derivation into core/hash.js
test(canvas): assert the same origin yields identical pixels
chore(deps): bump webpack to 5.97.1
build: emit manifest.json into dist during packaging
```

---

## 6. Branch naming

Use a prefix that matches the commit type, then a short kebab-case description:

```
feat/timezone-aliasing
fix/canvas-reload-stability
docs/contributing-guide
chore/drop-legacy-namespace
```

---

## 7. Pull request process

1. Branch off `main` with a name from [section 6](#6-branch-naming).
2. Make your change. Keep commits atomic and conventional.
3. Run `pnpm run verify`. It must print `PASS - n/n checks passed`.
4. Complete the manual checklist in [`AGENTS.md`](AGENTS.md) section 8 for any change that touches a hook.
5. Update `CHANGELOG.md` under an `Unreleased` heading if the change is user-visible.
6. Open the pull request against `main`. In the description, state what changed, why, and how you verified it.
7. A maintainer reviews. Address feedback with new commits — do not force-push during review.

A pull request is ready to merge when:

- `pnpm run verify` passes.
- The manual checklist passes for hook changes.
- Documentation is updated in the same pull request.
- The commit history follows the standard in [section 5](#5-commit-message-standard).

---

## 8. Reporting bugs

Open an issue at <https://github.com/dinhdidaudo/shapeshift/issues> and include:

- Chrome version and operating system.
- ShapeShift version, from the About panel in Settings.
- The site where the problem occurs, if it is site-specific.
- Console output with **Settings -> Advanced -> Debug mode** enabled. Lines are prefixed `[shapeshift]`.
- Whether the problem disappears when you pause protection for that site.

For a fingerprint mismatch, include the before/after output from the AmIUnique procedure in `README.md`.

---

## 9. License

By contributing, you agree that your contributions are licensed under the MIT License that covers this project. See [`LICENSE`](LICENSE).
