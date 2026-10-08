# Security policy

## Reporting a vulnerability

Open a private security advisory on the GitHub repository
(`https://github.com/dinhdidaudo/shapeshift/security/advisories/new`) rather than a
public issue. Include the extension version, the browser build, and a minimal
reproduction. You should receive an acknowledgement within seven days.

Please do not open a public issue for anything that lets a page:

- read the per-origin salt or the derived seed,
- force the extension to adopt an attacker-chosen seed or config,
- distinguish a ShapeShift-protected browser from an unprotected one, or
- make the extension perform a network request.

## Threat model

ShapeShift defends against **passive fingerprinting**: a site reading Canvas,
WebGL, Audio, WebRTC, Navigator, Screen, Fonts, Timezone, Sensor, Touch, Media
and Geolocation APIs in order to build a stable device identifier.

It does **not** defend against:

- a site that already knows your real fingerprint from another context,
- server-side correlation of IP address, TLS fingerprint, and request timing,
- extension enumeration by other extensions,
- a compromised browser profile or a malicious extension with broader
  permissions.

The perturbation is intentionally **stable per origin**: the same
`(salt, origin, config)` always produces the same spoofed values. A site cannot
detect the shim by reading twice, and an identity survives reloads until the
salt is rotated.

## Data handling

ShapeShift is fully offline. It makes no network requests, contains no
analytics, and has no remote code. Everything it stores lives in
`chrome.storage.local` on your machine:

| Key | Contents |
|---|---|
| `ss_salt` | Random per-install salt (the root of every derived seed) |
| `ssConfig` | Your settings |
| `ss_stats` | Local counters of intercepted reads |
| `ss_site_settings` | Origins where you paused protection |
| `ss_rotation_info` | Last rotation timestamp and count |

Removing the extension removes all of it.

## Known limitations

- The MAIN-world injector receives the per-origin seed through
  `window.postMessage(..., location.origin)`. A script running in the page can
  observe that message, so the seed is not treated as a secret: it is only an
  input to values the page can already read back through the hooked APIs.
  Rotating the identity (`Generate new identity`, or auto rotation) invalidates
  any seed a page captured earlier.
- A page script cannot force the injector to adopt an attacker-chosen seed. The
  injector runs at `document_start`, before any page script, and publishes a
  fresh per-load nonce with `SS_PAGE_WORLD_READY` on its first synchronous turn.
  `SS_INIT_PAGE_HOOKS` is only honoured when it echoes that nonce, so a page
  that misses the initial announcement can neither win the race to the one-shot
  latch nor re-initialise the hooks afterwards. The config payload is still
  whitelisted and clamped as a defence-in-depth measure. When
  `crypto.getRandomValues` is unavailable the injector generates no nonce and
  falls back to the one-shot latch plus the whitelist.
- `web_accessible_resources` exposes the page-world self-test helper
  (`content/test_fingerprint_page.js`) to `https://*/*`. A determined site can
  probe that URL to detect the extension. The hooks themselves do not depend on
  that exposure; it exists only so the built-in fingerprint self-test can sample
  WebGL from the page context.
