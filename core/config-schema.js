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
    enableAudioNoise: true, audioNoiseStrength: 1e-7,
    enableNavigatorFuzz: true,
    navigator: { fuzzHardwareConcurrency: true, fuzzDeviceMemory: true, shuffleLanguages: true },
    perOriginFingerprint: true,
    enableWebRTCProtection: true,
    webrtc: { blockIPLeak: true, randomizeSDP: true, forceRelay: false },
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
    autoRotateFingerprint: false, rotationIntervalHours: 24, rotateOnStartup: false,
    // Security §3: rotation used to reload every open tab and raise an OS
    // notification with no way to opt out. Both are now explicit switches so
    // the extension never acts on tabs the user did not ask it to touch.
    notifyOnRotation: true, reloadTabsOnRotation: true
  };

  // Legacy flat option keys -> nested config groups. The Options page still
  // writes these flat names, so ssNormalizeConfig() folds them into the groups
  // the hooks actually read.
  const flatToNested = {
    fuzzHardwareConcurrency: ['navigator', 'fuzzHardwareConcurrency'],
    fuzzDeviceMemory: ['navigator', 'fuzzDeviceMemory'],
    shuffleLanguages: ['navigator', 'shuffleLanguages'],
    blockIPLeak: ['webrtc', 'blockIPLeak'],
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
