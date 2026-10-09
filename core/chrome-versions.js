// Shared table of REAL Chrome desktop stable versions.
//
// Why this file exists: hooks_useragent.js and page_world_injector.js used to
// synthesise a Chrome version from the seed as
//
//     build = 6000 + (hash % 500);  patch = (hash >>> 8) % 200;
//
// which produced strings like `Chrome/126.0.6234.187` - a build number that
// has never shipped. Cloudflare (and every other bot-management vendor) keeps a
// database of real Chrome releases and binds `cf_clearance` to the exact
// User-Agent that earned it, so a fabricated build number both fails the UA
// plausibility check and invalidates the clearance cookie on the next
// navigation. That is the direct cause of the "verify you are human" loop after
// a rotation.
//
// The fix is to stop inventing versions and pick from a list of versions that
// actually shipped. Every entry is a full 4-part stable release: a page that
// cross-checks navigator.userAgent against navigator.userAgentData.fullVersionList
// now sees one real version in both places.
//
// MAIN world note: page_world_injector.js cannot load this file (manifest.json
// injects it alone into the MAIN world), so the identical table is inlined
// there. The two copies MUST stay in sync - page_world_injector.js carries a
// pointer back to this comment.
(function () {
  'use strict';

  // Ascending order, stable desktop releases only. Keep the array sorted by
  // major: pickChromeVersion() relies on the order to fall back to "the newest
  // version we know" when the real browser is ahead of this table.
  const CHROME_STABLE_VERSIONS = [
    '126.0.6478.127',
    '127.0.6533.100',
    '128.0.6613.120',
    '129.0.6668.90',
    '130.0.6723.119',
    '131.0.6778.86',
    '132.0.6834.84',
    '133.0.6943.99',
    '134.0.6998.89',
    '135.0.7049.85',
    '136.0.7103.93',
    '137.0.7151.68',
    '138.0.7204.97',
    '139.0.7258.66',
    '140.0.7339.80',
    '141.0.7390.55'
  ];

  // The real major of the browser this is running in, or null when it cannot be
  // read (UA-reduced build, a non-Chromium host, a stripped token).
  function realChromeMajor () {
    try {
      const m = /Chrome\/(\d+)/.exec(navigator.userAgent);
      return m ? Number(m[1]) : null;
    } catch (e) {
      return null;
    }
  }

  // Pick one entry from the table. `hash` must be the SAME value in both worlds
  // (both derive it from the same seed with the same FNV-1a fold), so the two
  // worlds can never advertise two different versions for one machine.
  //
  // Entries older than the real browser are skipped: advertising Chrome/126 from
  // a Chrome/141 client is a downgrade no real update path produces, and it is
  // also the shape a spoofing extension has. When the browser is newer than
  // everything in the table we fall back to the newest known release rather
  // than to a fabricated number.
  function pickChromeVersion (hash) {
    const realMajor = realChromeMajor();
    let candidates = CHROME_STABLE_VERSIONS;
    if (realMajor !== null) {
      const fresh = CHROME_STABLE_VERSIONS.filter(function (v) {
        return Number(v.split('.')[0]) >= realMajor;
      });
      if (fresh.length > 0) candidates = fresh;
    }
    const idx = Math.abs(Number(hash) || 0) % candidates.length;
    const full = candidates[idx];
    const parts = full.split('.');
    return { major: parts[0], minor: parts[1], build: parts[2], patch: parts[3], full: full };
  }

  globalThis.ssChromeStableVersions = CHROME_STABLE_VERSIONS;
  globalThis.ssPickChromeVersion = pickChromeVersion;
})();
