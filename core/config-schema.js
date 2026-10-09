// Single source of truth for the ShapeShift configuration schema.
//
// Architecture §4: the defaults used to be copy-pasted into core/config.js,
// popup/popup.js and options/options.js with drifting contents, which is what
// made the Options switches silently disagree with the hooks. This file is
// loaded before core/config.js (see manifest.json) and exposes the defaults,
// the schema version plus its migrations, and the legacy flat-key -> nested
// group map that keeps older stored configs readable.
(function () {
  'use strict';

  const defaults = {
    debug: false,
    enableCanvasNoise: true, canvasNoiseStrength: 2,
    enableWebGLMasking: true, webglJitter: 2, maskWebGLVendorStrings: true, shuffleWebGLExtensions: true,
    // P2 7.3: navigator.gpu was completely unprotected, so a page could read
    // the real GPU out of GPUAdapter.info while WebGL reported a persona.
    enableWebGPUProtection: true,
    // P2 7.3: navigator.keyboard.getLayoutMap() resolved to the HOST keyboard
    // layout, a locale tell nothing else covered - a German layout behind an
    // en-US user agent is a one-line contradiction.
    enableKeyboardProtection: true,
    enableAudioNoise: true, audioNoiseStrength: 1e-7,
    enableNavigatorFuzz: true,
    navigator: { fuzzHardwareConcurrency: true, fuzzDeviceMemory: true, shuffleLanguages: true },
    perOriginFingerprint: true,
    enableWebRTCProtection: true,
    // P2 7.2: one explicit tri-state replaces the three overlapping WebRTC
    // booleans. `off` leaves the session description untouched,
    // `block-host-srflx` strips the candidates that carry a local or public
    // address, and `relay-only` additionally forces iceTransportPolicy so no
    // host candidate is gathered at all. The legacy booleans stay declared so a
    // stored config from an older build keeps working: both worlds derive the
    // same effective mode from them when `mode` is absent.
    webrtc: { mode: 'block-host-srflx', blockIPLeak: true, randomizeSDP: true, forceRelay: false },
    enableMediaDeviceProtection: true,
    mediaDevices: { randomizeDeviceIds: true, spoofDeviceLabels: true },
    enableScreenProtection: true,
    screen: { useRealDistribution: true },
    enableFontProtection: true,
    enableTimezoneProtection: true,
    enableSensorProtection: true,
    sensors: { hideGamepads: true },
    enableTouchProtection: true,
    enableUserAgentProtection: true,
    enableMediaProtection: true,
    enableGeolocationProtection: true,
    geolocation: { noiseLevel: 0.001 },
    enableDetectionResistance: true,
    // P2: the Options page and the hooks both referenced a timing-jitter knob
    // that never existed in the schema, so reading it always produced
    // `undefined` and the switch silently did nothing. Declare it once here.
    timingJitter: 0,
    useStrongKDF: true, kdfIterations: 1000, useGaussianNoise: true,
    // P2 7.4 (persona profile): the coherent OS family used to be derivable
    // only from the seed, so a user could not ask for a specific one. 'auto'
    // keeps the derived pick; the three explicit values pin the family in BOTH
    // worlds, which is what makes the UA platform, the WebGL renderer, the
    // WebGPU adapter and the keyboard layout agree by construction.
    persona: 'auto',
    autoRotateFingerprint: false, rotationIntervalHours: 24, rotateOnStartup: false,
    // Security §3: rotation used to reload every open tab and raise an OS
    // notification with no way to opt out. Both are now explicit switches so
    // the extension never acts on tabs the user did not ask it to touch.
    //
    // Anti-fraud §1: reloadTabsOnRotation defaults to FALSE. Reloading every
    // open tab made one rotation look like a hundred device changes to every
    // site the user had open - including sites with a live login session - so
    // each tab presented a brand-new fingerprint on an unchanged session
    // cookie. That is precisely the session-hijacking pattern Cloudflare
    // challenges. When the user does opt in, only the ACTIVE tab of each
    // window is reloaded (see rotationReloadScope), so the blast radius of one
    // rotation stays one page.
    notifyOnRotation: true, reloadTabsOnRotation: false,
    // 'active' (default) reloads only the focused tab of each window; 'all'
    // restores the old, invasive behaviour for users who ask for it.
    rotationReloadScope: 'active',
    // Anti-fraud §1: a rotation that leaves the session cookies untouched is
    // the strongest hijack signal there is - a new machine on an old session.
    // Clearing the site's cookies and storage makes the new identity coherent
    // (new device AND new session), at the cost of logging the user out. It is
    // therefore opt-in and defaults to false.
    clearSiteDataOnRotation: false
  };

  // Legacy flat option keys -> nested config groups. The Options page still
  // writes these flat names, so ssNormalizeConfig() folds them into the groups
  // the hooks actually read.
  const flatToNested = {
    fuzzHardwareConcurrency: ['navigator', 'fuzzHardwareConcurrency'],
    fuzzDeviceMemory: ['navigator', 'fuzzDeviceMemory'],
    shuffleLanguages: ['navigator', 'shuffleLanguages'],
    blockIPLeak: ['webrtc', 'blockIPLeak'],
    webrtcMode: ['webrtc', 'mode'],
    randomizeSDP: ['webrtc', 'randomizeSDP'],
    forceRelay: ['webrtc', 'forceRelay'],
    randomizeDeviceIds: ['mediaDevices', 'randomizeDeviceIds'],
    spoofDeviceLabels: ['mediaDevices', 'spoofDeviceLabels'],
    useRealDistribution: ['screen', 'useRealDistribution'],
    hideGamepads: ['sensors', 'hideGamepads'],
    noiseLevel: ['geolocation', 'noiseLevel']
  };

  // Bump `version` whenever a key is renamed or a group is restructured, and
  // add a step below keyed by the version it upgrades *from*.
  const version = 1;

  const migrations = {
    0: function (stored) {
      // v0 had no ssConfigVersion field; flat option keys were the norm and
      // ssNormalizeConfig() already folds them into their nested groups.
      stored.ssConfigVersion = 1;
      return stored;
    }
  };

  // Flat view of the defaults: top-level scalars stay as-is and every nested
  // group is expanded into its flat key. The Options page renders flat keys
  // (fuzzDeviceMemory, blockIPLeak, ...) while the hooks read the nested
  // groups, so both sides now derive from this one file instead of keeping
  // three drifting copies of DEFAULTS.
  const flatDefaults = {};
  for (const k in defaults) {
    const v = defaults[k];
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      for (const gk in v) flatDefaults[gk] = v[gk];
    } else {
      flatDefaults[k] = v;
    }
  }

  globalThis.ssConfigSchema = {
    version: version,
    defaults: defaults,
    flatDefaults: flatDefaults,
    flatToNested: flatToNested,
    migrations: migrations
  };

  // Convenience aliases so popup.js / options.js can render defaults without
  // keeping their own copy.
  globalThis.ssDefaultConfig = defaults;
  globalThis.ssFlatDefaults = flatDefaults;
  globalThis.ssFlatToNested = flatToNested;
})();
