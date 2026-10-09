// Page-world injector - runs in MAIN world to hook actual page APIs
// This script has NO access to chrome.* APIs but can modify page JavaScript
(function () {
  'use strict';

  // Minimal PRNG (Xoshiro128**) - same as core/prng.js
  function createPRNG(seed) {
    function splitmix32(a) {
      return function() {
        a |= 0;
        a = a + 0x9e3779b9 | 0;
        let t = a ^ a >>> 16;
        t = Math.imul(t, 0x21f0aaad);
        t = t ^ t >>> 15;
        t = Math.imul(t, 0x735a2d97);
        return ((t = t ^ t >>> 15) >>> 0) / 4294967296;
      };
    }

    const smix = splitmix32(seed >>> 0);
    const state = new Uint32Array(4);
    state[0] = (smix() * 0xFFFFFFFF) >>> 0;
    state[1] = (smix() * 0xFFFFFFFF) >>> 0;
    state[2] = (smix() * 0xFFFFFFFF) >>> 0;
    state[3] = (smix() * 0xFFFFFFFF) >>> 0;

    function rotl(x, k) {
      return ((x << k) | (x >>> (32 - k))) >>> 0;
    }

    return function next() {
      const result = rotl(Math.imul(state[1], 5), 7) * 9;
      const t = (state[1] << 9) >>> 0;

      state[2] ^= state[0];
      state[3] ^= state[1];
      state[1] ^= state[2];
      state[0] ^= state[3];
      state[2] ^= t;
      state[3] = rotl(state[3], 11);

      return (result >>> 0) / 4294967296;
    };
  }

  // FNV-1a hash, identical to core/hash.js. MAIN world does not load the core
  // files, so the same derivation is inlined here to keep per-surface noise
  // stable across reads and consistent with the ISOLATED hooks.
  function hashString(str) {
    let h1 = 0x811C9DC5;
    const s = String(str);
    for (let i = 0; i < s.length; i++) {
      h1 ^= s.charCodeAt(i);
      h1 = Math.imul(h1, 0x01000193);
      h1 >>>= 0;
    }
    return h1 >>> 0;
  }

  // -------------------------------------------------------------------------
  // Config sanitation (P0 1.6 / Security 3).
  //
  // The MAIN world cannot authenticate a window message: a genuine bootstrap
  // post and a page script's post look identical (event.source is the window
  // in both cases) and the page can read every field the injector receives.
  // Two guards keep that from being exploitable:
  //   1. a one-shot latch, so hooks install exactly once and a later forged
  //      message can never re-install them or swap the seed; and
  //   2. this whitelist, so even a forged *first* message can only choose from
  //      known keys with clamped magnitudes instead of injecting arbitrary
  //      properties into the hook installers.
  // The seed is deliberately not treated as a secret: it is only an input to
  // values the page can already read back through the hooked APIs.
  // -------------------------------------------------------------------------
  const CONFIG_BOUNDS = {
    canvasNoiseStrength: [0, 10],
    webglJitter: [0, 10],
    audioNoiseStrength: [0, 1],
    kdfIterations: [1, 100000],
    rotationIntervalHours: [0.5, 8760]
  };
  const CONFIG_BOOLEAN_KEYS = [
    'debug', 'enableCanvasNoise', 'enableWebGLMasking', 'maskWebGLVendorStrings',
    'shuffleWebGLExtensions', 'enableAudioNoise', 'enableNavigatorFuzz',
    'perOriginFingerprint', 'enableWebRTCProtection', 'enableMediaDeviceProtection',
    'enableScreenProtection', 'enableFontProtection', 'enableTimezoneProtection',
    'enableSensorProtection', 'enableTouchProtection', 'enableUserAgentProtection',
    'enableMediaProtection', 'enableGeolocationProtection', 'enableDetectionResistance',
    'useStrongKDF', 'useGaussianNoise', 'autoRotateFingerprint', 'rotateOnStartup'
  ];
  // P1 2.14: the group loop used to copy every boolean/number key it found, so
  // a forged `screen: { foo: 1e9 }` (or `geolocation: { noiseLevel: 1e9 }`)
  // reached the hooks unclamped. Groups are now whitelisted per key exactly
  // like the top-level scalars: booleans by name, numbers by name + bounds.
  const CONFIG_GROUP_BOOLEAN_KEYS = {
    navigator: ['fuzzHardwareConcurrency', 'fuzzDeviceMemory', 'shuffleLanguages'],
    webrtc: ['blockIPLeak', 'randomizeSDP', 'forceRelay'],
    mediaDevices: ['randomizeDeviceIds', 'spoofDeviceLabels'],
    screen: ['useRealDistribution'],
    sensors: ['hideGamepads'],
    geolocation: []
  };
  const CONFIG_GROUP_BOUNDS = {
    geolocation: { noiseLevel: [0, 1] }
  };
  const CONFIG_GROUP_KEYS = [
    'navigator', 'webrtc', 'mediaDevices', 'screen', 'sensors', 'geolocation'
  ];

  function sanitizeConfig(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const out = {};
    for (let i = 0; i < CONFIG_BOOLEAN_KEYS.length; i++) {
      const key = CONFIG_BOOLEAN_KEYS[i];
      if (typeof raw[key] === 'boolean') out[key] = raw[key];
    }
    for (const key in CONFIG_BOUNDS) {
      const value = raw[key];
      if (typeof value !== 'number' || !isFinite(value)) continue;
      const bounds = CONFIG_BOUNDS[key];
      out[key] = Math.min(bounds[1], Math.max(bounds[0], value));
    }
    for (let i = 0; i < CONFIG_GROUP_KEYS.length; i++) {
      const group = CONFIG_GROUP_KEYS[i];
      const value = raw[group];
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      const copy = {};
      const boolKeys = CONFIG_GROUP_BOOLEAN_KEYS[group] || [];
      for (let j = 0; j < boolKeys.length; j++) {
        const gk = boolKeys[j];
        if (typeof value[gk] === 'boolean') copy[gk] = value[gk];
      }
      const groupBounds = CONFIG_GROUP_BOUNDS[group] || {};
      for (const gk in groupBounds) {
        const gv = value[gk];
        if (typeof gv !== 'number' || !isFinite(gv)) continue;
        const bounds = groupBounds[gk];
        copy[gk] = Math.min(bounds[1], Math.max(bounds[0], gv));
      }
      out[group] = copy;
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // Handshake nonce (P0 1.6 / Security §3).
  //
  // A window message cannot be authenticated, but it CAN be made
  // unpredictable: this script runs at document_start, before any page script,
  // and publishes READY (with a fresh per-load nonce) on its very first
  // synchronous turn. A page script that registers a listener afterwards has
  // missed it. SS_INIT_PAGE_HOOKS is then refused unless it echoes that nonce,
  // so an inline page script can no longer beat the genuine bootstrap message
  // to the one-shot latch and install hooks with a poisoned seed.
  // -------------------------------------------------------------------------
  const ssNonce = (function () {
    try {
      const cryptoObj = window.crypto || window.msCrypto;
      if (!cryptoObj || !cryptoObj.getRandomValues) return null;
      const buf = new Uint8Array(16);
      cryptoObj.getRandomValues(buf);
      let hex = '';
      for (let i = 0; i < buf.length; i++) hex += buf[i].toString(16).padStart(2, '0');
      return hex;
    } catch (e) {
      return null;
    }
  })();
  const ssNonceRequired = typeof ssNonce === 'string' && ssNonce.length === 32;

  function announceReady() {
    window.postMessage({
      type: 'SS_PAGE_WORLD_READY',
      protocol: 1,
      nonce: ssNonce
    }, location.origin);
  }

  // Publish the nonce now, while no page script exists yet, and again on
  // request in case the ISOLATED bootstrap registered its listener late.
  announceReady();

  // Listen for config from ISOLATED world
  let ssInitialized = false;
  window.addEventListener('message', function(event) {
    if (event.source !== window) return;
    if (event.origin !== location.origin) return;
    if (!event.data) return;
    if (event.data.type === 'SS_PAGE_WORLD_HELLO') {
      if (event.data.protocol !== 1) return;
      announceReady();
      return;
    }
    if (event.data.type !== 'SS_INIT_PAGE_HOOKS') return;
    if (event.data.protocol !== 1) return;
    if (ssNonceRequired && event.data.nonce !== ssNonce) return;
    if (ssInitialized) return; // Guard against page-forged re-init

    // Validate BEFORE flipping the one-shot guard: a malformed first message
    // used to latch ssInitialized, so the genuine bootstrap message that
    // followed was ignored and no MAIN-world hook ever installed.
    const config = sanitizeConfig(event.data.config);
    const seed = event.data.seed;
    if (!config || typeof seed !== 'number' || !isFinite(seed)) {
      return;
    }

    ssInitialized = true;

    const debug = config.debug || false;
    const log = debug ? console.log.bind(console) : () => {};

    log('[shapeshift][page] Initializing page-world hooks with config:', config);

    const prng = createPRNG(seed);

    // Gaussian noise
    let spareGaussian = null;
    function gaussianNoise(mean = 0, stddev = 1) {
      if (spareGaussian !== null) {
        const value = spareGaussian;
        spareGaussian = null;
        return mean + stddev * value;
      }

      const u1 = prng();
      const u2 = prng();
      const radius = Math.sqrt(-2 * Math.log(u1));
      const theta = 2 * Math.PI * u2;

      spareGaussian = radius * Math.sin(theta);
      return mean + stddev * (radius * Math.cos(theta));
    }

    const noise = config.useGaussianNoise
      ? (scale = 1) => gaussianNoise(0, scale)
      : (scale = 1) => (prng() - 0.5) * scale;

    // ========================================================================
    // CANVAS HOOKS
    // ========================================================================
    if (config.enableCanvasNoise) {
      try {
        // Must match core/config.js (canvasNoiseStrength: 2) and the ISOLATED
        // hooks so both worlds apply the same magnitude.
        const noiseStrength = config.canvasNoiseStrength ?? 2;
        const canvasSeed = seed >>> 0;
        const origGetImageData = CanvasRenderingContext2D.prototype.getImageData;
        const origToDataURL = HTMLCanvasElement.prototype.toDataURL;
        const origToBlob = HTMLCanvasElement.prototype.toBlob;

        // Per-byte noise keyed on (seed, index) so two reads of the same canvas
        // return identical pixels. A streaming PRNG would change on every read,
        // which is itself a detectable signal.
        function pixelNoise(index) {
          const h = hashString(canvasSeed + ':' + index);
          return ((h / 4294967296) - 0.5) * noiseStrength;
        }

        function noisedImageData(ctx, x, y, w, h) {
          const imgData = origGetImageData.call(ctx, x, y, w, h);
          const data = imgData.data;
          for (let i = 0; i < data.length; i += 4) {
            data[i] += pixelNoise(i);
            data[i + 1] += pixelNoise(i + 1);
            data[i + 2] += pixelNoise(i + 2);
          }
          return imgData;
        }

        CanvasRenderingContext2D.prototype.getImageData = function(x, y, w, h) {
          return noisedImageData(this, x, y, w, h);
        };

        // Export helpers: noised pixels must only exist for the duration of the
        // export. Writing them into the backing store permanently mutated the
        // canvas, so a second toDataURL()/toBlob() stacked noise on top of the
        // already-noised pixels and the canvas the page sees drifted from the
        // one it drew. Snapshot, noised copy, export, restore.
        function noisedCopyOf(ctx, width, height) {
          const original = origGetImageData.call(ctx, 0, 0, width, height);
          const copy = ctx.createImageData(original.width, original.height);
          copy.data.set(original.data);
          for (let i = 0; i < copy.data.length; i += 4) {
            copy.data[i] += pixelNoise(i);
            copy.data[i + 1] += pixelNoise(i + 1);
            copy.data[i + 2] += pixelNoise(i + 2);
          }
          return { original: original, noised: copy };
        }

        HTMLCanvasElement.prototype.toDataURL = function() {
          let snapshot = null;
          let ctx = null;
          try {
            // Plain getContext: willReadFrequently silently switches an
            // existing canvas to software rendering and warns when a 2d
            // context already exists with other attributes.
            ctx = this.getContext('2d');
            if (ctx && origGetImageData) {
              snapshot = noisedCopyOf(ctx, this.width, this.height);
              ctx.putImageData(snapshot.noised, 0, 0);
            }
          } catch (e) { /* ignore */ }
          try {
            return origToDataURL.apply(this, arguments);
          } finally {
            if (ctx && snapshot) {
              try { ctx.putImageData(snapshot.original, 0, 0); } catch (e) { /* ignore */ }
            }
          }
        };

        HTMLCanvasElement.prototype.toBlob = function() {
          const args = arguments;
          const canvas = this;
          const restore = function () {
            if (canvas.__ssCtx && canvas.__ssSnapshot) {
              try { canvas.__ssCtx.putImageData(canvas.__ssSnapshot, 0, 0); } catch (e) { /* ignore */ }
            }
            canvas.__ssCtx = null;
            canvas.__ssSnapshot = null;
          };
          try {
            const ctx = this.getContext('2d');
            if (ctx && origGetImageData) {
              const snapshot = noisedCopyOf(ctx, this.width, this.height);
              this.__ssCtx = ctx;
              this.__ssSnapshot = snapshot.original;
              ctx.putImageData(snapshot.noised, 0, 0);
            }
          } catch (e) { /* ignore */ }
          // Restore after the callback runs: toBlob is asynchronous, so the
          // backing store must stay noised until the encoder has read it.
          const wrappedCallback = typeof args[0] === 'function'
            ? function (blob) { restore(); return args[0](blob); }
            : undefined;
          try {
            return wrappedCallback
              ? origToBlob.call(this, wrappedCallback, args[1])
              : origToBlob.apply(this, args);
          } catch (e) {
            restore();
            throw e;
          }
        };

        log('[shapeshift][page][canvas] Hooks installed');
      } catch (e) {
        log('[shapeshift][page][canvas] Failed:', e);
      }
    }

    // ========================================================================
    // SCREEN HOOKS
    // ========================================================================
    if (config.enableScreenProtection) {
      try {
        const commonResolutions = [
          { width: 1920, height: 1080, weight: 0.35 },
          { width: 1366, height: 768, weight: 0.15 },
          { width: 2560, height: 1440, weight: 0.12 },
          { width: 1536, height: 864, weight: 0.10 },
          { width: 1440, height: 900, weight: 0.08 },
          { width: 1600, height: 900, weight: 0.07 },
          { width: 3840, height: 2160, weight: 0.05 },
          { width: 2880, height: 1800, weight: 0.04 },
          { width: 1280, height: 720, weight: 0.04 }
        ];

        function sampleResolution() {
          const r = prng();
          let cumulative = 0;
          for (const res of commonResolutions) {
            cumulative += res.weight;
            if (r < cumulative) {
              return { width: res.width, height: res.height };
            }
          }
          return { width: 1920, height: 1080 };
        }

        const realWidth = window.screen.width;
        const realHeight = window.screen.height;
        const realPixelRatio = window.devicePixelRatio || 1;
        const spoofed = sampleResolution();

        // P1 2.10: the MAIN world is the only copy the page can read, so it must
        // not contradict itself. Scale the REAL devicePixelRatio by how far the
        // spoofed width moved, so screen.width / dpr still implies a CSS screen
        // size close to the real one instead of snapping to 1 or 2 and clashing
        // with window.innerWidth.
        const widthScale = realWidth > 0 ? spoofed.width / realWidth : 1;
        const spoofedPixelRatio = Math.min(4, Math.max(1, Math.round(realPixelRatio * widthScale * 100) / 100));

        const colorDepths = [24, 24, 24, 30, 32];
        const spoofedColorDepth = colorDepths[Math.floor(prng() * colorDepths.length)];

        // P1 2.10: availHeight is not height - 40 everywhere (macOS has no
        // taskbar; Windows taskbars are not 40 px). Measure the real gap between
        // the screen and its work area and scale that gap to the spoofed height.
        const realAvailHeight = Number(window.screen.availHeight);
        const realGap = Number.isFinite(realAvailHeight) && realAvailHeight > 0 && realAvailHeight <= realHeight
          ? realHeight - realAvailHeight
          : 0;
        const availOffset = realGap > 0
          ? Math.max(1, Math.round(realGap * (spoofed.height / (realHeight || spoofed.height))))
          : 0;

        log(`[shapeshift][page][screen] Real: ${realWidth}x${realHeight}, Spoofed: ${spoofed.width}x${spoofed.height}`);

        function defineGetter(obj, prop, getter) {
          try {
            Object.defineProperty(obj, prop, {
              get: getter,
              enumerable: true,
              configurable: true
            });
          } catch (e) {
            log(`[shapeshift][page][screen] Failed to define ${prop}:`, e.message);
          }
        }

        defineGetter(window.screen, 'width', () => spoofed.width);
        defineGetter(window.screen, 'height', () => spoofed.height);
        defineGetter(window.screen, 'availWidth', () => spoofed.width);
        defineGetter(window.screen, 'availHeight', () => spoofed.height - availOffset);
        defineGetter(window.screen, 'colorDepth', () => spoofedColorDepth);
        defineGetter(window.screen, 'pixelDepth', () => spoofedColorDepth);
        defineGetter(window, 'devicePixelRatio', () => spoofedPixelRatio);

        log('[shapeshift][page][screen] Hooks installed');
      } catch (e) {
        log('[shapeshift][page][screen] Failed:', e);
      }
    }

    // ========================================================================
    // NAVIGATOR HOOKS
    // ========================================================================
    if (config.enableNavigatorFuzz) {
      try {
        const nav = navigator;
        const realHardwareConcurrency = nav.hardwareConcurrency || 4;
        const realDeviceMemory = nav.deviceMemory || 8;

        const fuzzedConcurrency = Math.max(2, realHardwareConcurrency + Math.floor((prng() - 0.5) * 4));
        const fuzzedMemory = Math.max(4, realDeviceMemory + Math.floor((prng() - 0.5) * 4));

        // configurable: true so a later stage (or a user re-init) can redefine
        // the property; a non-configurable descriptor here permanently blocked
        // every other hook from touching deviceMemory.
        if (config.navigator?.fuzzHardwareConcurrency !== false) {
          Object.defineProperty(navigator, 'hardwareConcurrency', {
            get: () => fuzzedConcurrency,
            enumerable: true,
            configurable: true
          });
        }

        if (config.navigator?.fuzzDeviceMemory !== false && 'deviceMemory' in navigator) {
          Object.defineProperty(navigator, 'deviceMemory', {
            get: () => fuzzedMemory,
            enumerable: true,
            configurable: true
          });
        }

        log('[shapeshift][page][navigator] Hooks installed, HC:', fuzzedConcurrency, 'Memory:', fuzzedMemory);
      } catch (e) {
        log('[shapeshift][page][navigator] Failed:', e);
      }
    }

    // ========================================================================
    // TIMEZONE HOOKS
    // ========================================================================
    if (config.enableTimezoneProtection) {
      try {
        // Get real timezone offset (don't change this - keeps times correct)
        const realOffset = new Date().getTimezoneOffset();
        const OrigIntlDateTimeFormat = Intl.DateTimeFormat;

        // Map of UTC offsets to IANA timezone identifiers
        // Grouped by offset so we can pick a different zone with same offset
        // NOTE: getTimezoneOffset() returns POSITIVE for zones BEHIND UTC (e.g., PST = 480)
        //       and NEGATIVE for zones AHEAD of UTC (e.g., China = -480)
        const timezonesByOffset = {
          '720': ['Pacific/Wake', 'Pacific/Wallis'],
          '660': ['Pacific/Midway', 'Pacific/Niue', 'Pacific/Pago_Pago'],
          '600': ['Pacific/Honolulu', 'Pacific/Rarotonga', 'Pacific/Tahiti'],
          '570': ['Pacific/Marquesas'],
          '540': ['America/Anchorage', 'America/Juneau', 'America/Nome', 'America/Sitka', 'America/Yakutat'],
          '480': ['America/Los_Angeles', 'America/Vancouver', 'America/Tijuana', 'America/Dawson', 'America/Whitehorse'],
          '420': ['America/Denver', 'America/Phoenix', 'America/Edmonton', 'America/Hermosillo', 'America/Chihuahua', 'America/Mazatlan'],
          '360': ['America/Chicago', 'America/Mexico_City', 'America/Regina', 'America/Winnipeg', 'America/Guatemala', 'America/Belize'],
          '300': ['America/New_York', 'America/Toronto', 'America/Havana', 'America/Panama', 'America/Lima', 'America/Bogota'],
          '240': ['America/Caracas', 'America/Halifax', 'America/Santiago', 'America/La_Paz', 'America/Manaus'],
          '210': ['America/St_Johns'],
          '180': ['America/Sao_Paulo', 'America/Argentina/Buenos_Aires', 'America/Montevideo', 'America/Godthab'],
          '120': ['Atlantic/South_Georgia'],
          '60': ['Atlantic/Azores', 'Atlantic/Cape_Verde'],
          '0': ['Europe/London', 'Europe/Dublin', 'Europe/Lisbon', 'Africa/Casablanca', 'Atlantic/Reykjavik', 'UTC'],
          '-60': ['Europe/Paris', 'Europe/Berlin', 'Europe/Rome', 'Europe/Madrid', 'Europe/Brussels', 'Europe/Amsterdam', 'Europe/Stockholm', 'Africa/Lagos'],
          '-120': ['Europe/Athens', 'Europe/Helsinki', 'Europe/Kiev', 'Africa/Cairo', 'Asia/Jerusalem', 'Europe/Bucharest', 'Africa/Johannesburg'],
          '-180': ['Europe/Moscow', 'Asia/Baghdad', 'Asia/Riyadh', 'Africa/Nairobi', 'Asia/Kuwait'],
          '-210': ['Asia/Tehran'],
          '-240': ['Asia/Dubai', 'Asia/Baku', 'Asia/Tbilisi', 'Asia/Muscat'],
          '-270': ['Asia/Kabul'],
          '-300': ['Asia/Karachi', 'Asia/Tashkent', 'Asia/Yekaterinburg'],
          '-330': ['Asia/Kolkata', 'Asia/Colombo'],
          '-345': ['Asia/Kathmandu'],
          '-360': ['Asia/Dhaka', 'Asia/Almaty', 'Asia/Omsk'],
          '-390': ['Asia/Yangon'],
          '-420': ['Asia/Bangkok', 'Asia/Jakarta', 'Asia/Ho_Chi_Minh'],
          '-480': ['Asia/Shanghai', 'Asia/Hong_Kong', 'Asia/Singapore', 'Asia/Taipei', 'Asia/Manila', 'Australia/Perth'],
          '-540': ['Asia/Tokyo', 'Asia/Seoul', 'Asia/Pyongyang'],
          '-570': ['Australia/Adelaide', 'Australia/Darwin'],
          '-600': ['Australia/Sydney', 'Australia/Melbourne', 'Australia/Brisbane', 'Pacific/Guam'],
          '-630': ['Australia/Lord_Howe'],
          '-660': ['Pacific/Noumea', 'Pacific/Guadalcanal'],
          '-720': ['Pacific/Auckland', 'Pacific/Fiji'],
          '-780': ['Pacific/Tongatapu', 'Pacific/Apia']
        };

        // P0 1.5: a spoofed zone name only stays internally consistent when
        // its offset matches the real one on EVERY date the page might probe,
        // not just today. Two zones can share a winter offset yet differ in
        // DST rules (America/Phoenix vs America/Denver), in which case
        // resolvedOptions().timeZone would contradict getTimezoneOffset() and
        // formatter.format() for half the year. Filter candidates by comparing
        // their offset today AND ~6 months out, so the pair straddles both DST
        // phases regardless of hemisphere.
        function zoneOffsetMinutes(zone, date) {
          try {
            const dtf = new OrigIntlDateTimeFormat('en-US', {
              timeZone: zone, hour12: false,
              year: 'numeric', month: '2-digit', day: '2-digit',
              hour: '2-digit', minute: '2-digit', second: '2-digit'
            });
            const parts = dtf.formatToParts(date);
            const m = {};
            for (let i = 0; i < parts.length; i++) {
              if (parts[i].type !== 'literal') m[parts[i].type] = parts[i].value;
            }
            const asUTC = Date.UTC(+m.year, +m.month - 1, +m.day, +m.hour, +m.minute, +m.second);
            return Math.round((asUTC - date.getTime()) / 60000);
          } catch (e) {
            return null;
          }
        }

        const offsetKey = String(realOffset);
        const candidates = timezonesByOffset[offsetKey] || [];

        const realZone = OrigIntlDateTimeFormat().resolvedOptions().timeZone;
        const sampleA = new Date();
        const sampleB = new Date(Date.now() + 182 * 24 * 60 * 60 * 1000);
        const realA = zoneOffsetMinutes(realZone, sampleA);
        const realB = zoneOffsetMinutes(realZone, sampleB);

        const availableZones = candidates.filter(function (z) {
          return zoneOffsetMinutes(z, sampleA) === realA &&
                 zoneOffsetMinutes(z, sampleB) === realB;
        });

        if (availableZones.length > 0) {
          // Pick a random timezone from the DST-consistent group
          const spoofedZone = availableZones[Math.floor(prng() * availableZones.length)];

          // Hook Intl.DateTimeFormat to return spoofed timezone
          Intl.DateTimeFormat = function(...args) {
            const instance = new OrigIntlDateTimeFormat(...args);
            const origResolvedOptions = instance.resolvedOptions;

            instance.resolvedOptions = function() {
              const options = origResolvedOptions.call(this);
              options.timeZone = spoofedZone;
              return options;
            };

            return instance;
          };

          // Copy static properties
          Object.setPrototypeOf(Intl.DateTimeFormat, OrigIntlDateTimeFormat);
          Object.setPrototypeOf(Intl.DateTimeFormat.prototype, OrigIntlDateTimeFormat.prototype);

          log('[shapeshift][page][timezone] Real offset:', realOffset, 'Spoofed zone:', spoofedZone);
        } else {
          log('[shapeshift][page][timezone] No DST-consistent zones for offset:', realOffset);
        }
      } catch (e) {
        log('[shapeshift][page][timezone] Failed:', e);
      }
    }

    // ========================================================================
    // WEBGL HOOKS
    // ========================================================================
    if (config.enableWebGLMasking) {
      try {
        const jitter = config.webglJitter ?? 2;
        const maskVendors = config.maskWebGLVendorStrings !== false;
        const shuffleExt = config.shuffleWebGLExtensions !== false;

        function patchWebGL(proto) {
          if (!proto || !proto.getParameter) return;
          const origGetParameter = proto.getParameter;

          proto.getParameter = function(p) {
            const value = origGetParameter.call(this, p);

            if (typeof value === 'number') {
              return value + jitter;
            }

            const gl = this;
            const vendorParams = [
              gl.VENDOR,
              gl.RENDERER,
              gl.UNMASKED_VENDOR_WEBGL,
              gl.UNMASKED_RENDERER_WEBGL
            ].filter(Boolean);

            // P1 2.1: key the suffix on (seed, param, value) so repeated
            // getParameter(VENDOR) reads return the same string. A streaming
            // PRNG here made two reads disagree, which is trivially detectable.
            if (maskVendors && vendorParams.includes(p) && typeof value === 'string') {
              const suffix = (hashString(seed + ':webgl:' + p + ':' + value) % 0xFFFF) || 1;
              return value + ' (ss-' + suffix + ')';
            }

            return value;
          };

          // Extension shuffling lives here (P1 2.23 / Security 3). It used to be
          // applied by a second, separately injected page-world script that
          // wrapped these same prototypes a second time, so numeric parameters
          // were jittered twice and the suffix was applied on top of an already
          // suffixed string. One patch site, one jitter.
          if (proto.getSupportedExtensions && shuffleExt) {
            const origGetSupportedExtensions = proto.getSupportedExtensions;
            proto.getSupportedExtensions = function () {
              const list = origGetSupportedExtensions.call(this);
              if (Array.isArray(list)) {
                return list.slice().reverse();
              }
              return list;
            };
          }
        }

        if (window.WebGLRenderingContext) patchWebGL(WebGLRenderingContext.prototype);
        if (window.WebGL2RenderingContext) patchWebGL(WebGL2RenderingContext.prototype);

        log('[shapeshift][page][webgl] Hooks installed');
      } catch (e) {
        log('[shapeshift][page][webgl] Failed:', e);
      }
    }

    // ========================================================================
    // AUDIO HOOKS
    // ========================================================================
    if (config.enableAudioNoise) {
      try {
        const audioNoiseStrength = config.audioNoiseStrength ?? 1e-7;
        const AudioContext = window.AudioContext || window.webkitAudioContext;

        if (AudioContext) {
          const audioSeed = seed >>> 0;
          const origGetChannelData = AudioBuffer.prototype.getChannelData;
          AudioBuffer.prototype.getChannelData = function(channel) {
            const data = origGetChannelData.call(this, channel);
            // Copy first: the native call returns the buffer's live Float32Array,
            // so writing into it corrupted the real audio samples and made the
            // noise accumulate on every read.
            const copy = new Float32Array(data.length);
            for (let i = 0; i < data.length; i++) {
              const h = hashString(audioSeed + ':a:' + i);
              copy[i] = data[i] + ((h / 4294967296) - 0.5) * audioNoiseStrength;
            }
            return copy;
          };

          log('[shapeshift][page][audio] Hooks installed');
        }
      } catch (e) {
        log('[shapeshift][page][audio] Failed:', e);
      }
    }

    // ========================================================================
    // FONT HOOKS (MAIN world)
    // ========================================================================
    if (config.enableFontProtection) {
      try {
        const fontSeed = seed >>> 0;
        const fontNoise = (key, scale) => {
          const h = hashString(fontSeed + ':font:' + key);
          return ((h / 4294967296) - 0.5) * scale;
        };

        const CanvasProto = CanvasRenderingContext2D.prototype;
        if (CanvasProto.measureText) {
          const origMeasureText = CanvasProto.measureText;
          CanvasProto.measureText = function (text) {
            const metrics = origMeasureText.call(this, text);
            // P1 2.8: only perturb finite numbers - undefined + noise made NaN.
            const nn = (value, scale, key) => (
              typeof value === 'number' && isFinite(value)
                ? value + fontNoise(key + ':' + text, scale)
                : value
            );
            const noised = {
              width: nn(metrics.width, metrics.width * 0.01, 'w'),
              actualBoundingBoxLeft: nn(metrics.actualBoundingBoxLeft, 0.01, 'abl'),
              actualBoundingBoxRight: nn(metrics.actualBoundingBoxRight, 0.01, 'abr'),
              actualBoundingBoxAscent: nn(metrics.actualBoundingBoxAscent, 0.01, 'aba'),
              actualBoundingBoxDescent: nn(metrics.actualBoundingBoxDescent, 0.01, 'abd'),
              fontBoundingBoxAscent: nn(metrics.fontBoundingBoxAscent, 0.01, 'fba'),
              fontBoundingBoxDescent: nn(metrics.fontBoundingBoxDescent, 0.01, 'fbd'),
              alphabeticBaseline: metrics.alphabeticBaseline,
              hangingBaseline: metrics.hangingBaseline,
              ideographicBaseline: metrics.ideographicBaseline,
              emHeightAscent: metrics.emHeightAscent,
              emHeightDescent: metrics.emHeightDescent
            };

            let out;
            try {
              out = Object.create(TextMetrics.prototype);
            } catch (e) {
              out = {};
            }
            for (const key in noised) {
              try {
                Object.defineProperty(out, key, {
                  value: noised[key], enumerable: true, configurable: true, writable: false
                });
              } catch (e) {
                out[key] = noised[key];
              }
            }
            return out;
          };
        }

        if (document.fonts && document.fonts.check) {
          const origCheck = document.fonts.check;
          document.fonts.check = function (font, text) {
            const result = origCheck.call(this, font, text);
            // P1 2.7: only upgrade absent -> present, deterministically.
            if (result === false) {
              const flip = (hashString(fontSeed + ':fontcheck:' + String(font) + String(text || '')) % 10) === 0;
              if (flip) return true;
            }
            return result;
          };
        }

        log('[shapeshift][page][fonts] Hooks installed');
      } catch (e) {
        log('[shapeshift][page][fonts] Failed:', e);
      }
    }

    // ========================================================================
    // WEBRTC HOOKS (MAIN world) - IP leak prevention, the highest-value surface
    // ========================================================================
    if (config.enableWebRTCProtection) {
      try {
        const blockIPLeak = !config.webrtc || config.webrtc.blockIPLeak !== false;
        const randomizeSDP = !config.webrtc || config.webrtc.randomizeSDP !== false;
        const webrtcSeed = seed >>> 0;

        if (window.RTCPeerConnection) {
          const OrigRTCPeerConnection = window.RTCPeerConnection;

          function scrubSdp(sdp) {
            let out = sdp;
            if (blockIPLeak) {
              const kept = [];
              const lines = out.split('\n');
              for (let i = 0; i < lines.length; i++) {
                const line = lines[i];
                if (/^a=candidate:/.test(line) &&
                    (/ typ host( |$)/.test(line) || / typ srflx( |$)/.test(line))) continue;
                kept.push(line);
              }
              out = kept.join('\n');
            }
            if (randomizeSDP) {
              out = out.replace(/^a=fingerprint:(\w+)\s+([0-9A-F:]+)$/gm, function (m, alg, fp) {
                const parts = fp.split(':');
                const mod = parts.map(function (part, idx) {
                  const num = parseInt(part, 16);
                  const off = hashString(webrtcSeed + ':fp:' + idx + ':' + part) % 256;
                  return ((num + off) % 256).toString(16).toUpperCase().padStart(2, '0');
                });
                return 'a=fingerprint:' + alg + ' ' + mod.join(':');
              });
              out = out.replace(/^a=ice-ufrag:(.+)$/gm, function (m, u) {
                return 'a=ice-ufrag:' + u + (hashString(webrtcSeed + ':ufrag:' + u) % 0xFFFF).toString(16);
              });
              out = out.replace(/^a=ice-pwd:(.+)$/gm, function (m, p) {
                return 'a=ice-pwd:' + p + (hashString(webrtcSeed + ':pwd:' + p) % 0xFFFF).toString(16);
              });
            }
            return out;
          }

          window.RTCPeerConnection = function (configuration, constraints) {
            const pc = new OrigRTCPeerConnection(configuration, constraints);
            const origSetLocal = pc.setLocalDescription;
            pc.setLocalDescription = function (description) {
              if (description && description.sdp) {
                const modifiedSdp = scrubSdp(description.sdp);
                let desc;
                try {
                  desc = new RTCSessionDescription({ type: description.type, sdp: modifiedSdp });
                } catch (e) {
                  desc = { type: description.type, sdp: modifiedSdp };
                }
                return origSetLocal.call(this, desc);
              }
              return origSetLocal.apply(this, arguments);
            };
            if (blockIPLeak) {
              const origAddIce = pc.addIceCandidate;
              pc.addIceCandidate = function (candidate) {
                const text = candidate && candidate.candidate;
                if (typeof text === 'string' &&
                    (text.indexOf('typ host') !== -1 || text.indexOf('typ srflx') !== -1)) {
                  return Promise.resolve();
                }
                return origAddIce.apply(this, arguments);
              };
            }
            return pc;
          };
          Object.setPrototypeOf(window.RTCPeerConnection, OrigRTCPeerConnection);
          window.RTCPeerConnection.prototype = OrigRTCPeerConnection.prototype;
        }

        log('[shapeshift][page][webrtc] Hooks installed');
      } catch (e) {
        log('[shapeshift][page][webrtc] Failed:', e);
      }
    }

    // ========================================================================
    // SENSOR HOOKS (MAIN world) - P0 1.1: these used to run only in the
    // ISOLATED world, so the page never saw them.
    // ========================================================================
    if (config.enableSensorProtection) {
      try {
        if (navigator.getBattery) {
          const origGetBattery = navigator.getBattery;
          navigator.getBattery = function () {
            return origGetBattery.call(this).then(function (battery) {
              const realCharging = battery.charging === true;
              const realDischargingTime = battery.dischargingTime;
              const spoofedLevel = Math.max(0.5, Math.min(1.0,
                0.75 + ((hashString(seed + ':battery') / 4294967296) - 0.5) * 0.1));
              return new Proxy(battery, {
                get (target, prop, receiver) {
                  if (prop === 'level') return spoofedLevel;
                  if (prop === 'chargingTime') return realCharging ? 0 : Infinity;
                  if (prop === 'dischargingTime') {
                    return realCharging
                      ? Infinity
                      : (typeof realDischargingTime === 'number' &&
                         isFinite(realDischargingTime) && realDischargingTime > 0
                        ? realDischargingTime : Infinity);
                  }
                  const value = Reflect.get(target, prop, receiver);
                  return typeof value === 'function' ? value.bind(target) : value;
                }
              });
            });
          };
        }

        if (performance.memory) {
          const baseUsed = performance.memory.usedJSHeapSize || 10000000;
          const baseLimit = performance.memory.jsHeapSizeLimit || 2172649472;
          const jitter = (k, scale) =>
            ((hashString(seed + ':' + k) / 4294967296) - 0.5) * scale;
          const noisedMemory = {
            get jsHeapSizeLimit () { return Math.floor(baseLimit + jitter('ml', baseLimit * 0.05)); },
            get totalJSHeapSize () { return Math.floor(baseUsed * 1.5 + jitter('mt', baseUsed * 0.1)); },
            get usedJSHeapSize () { return Math.floor(baseUsed + jitter('mu', baseUsed * 0.1)); }
          };
          Object.defineProperty(performance, 'memory', {
            get: () => noisedMemory, enumerable: true, configurable: true
          });
        }

        const connection = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
        if (connection) {
          const connectionTypes = ['4g', '4g', '4g', 'wifi', 'wifi'];
          const spoofedType = connectionTypes[
            hashString(seed + ':conn') % connectionTypes.length];
          const spoofedDownlink = spoofedType === 'wifi' ? 10 : 5;
          Object.defineProperty(connection, 'effectiveType', {
            get: () => spoofedType, enumerable: true, configurable: true
          });
          Object.defineProperty(connection, 'downlink', {
            get: () => spoofedDownlink, enumerable: true, configurable: true
          });
        }

        if (navigator.getGamepads) {
          navigator.getGamepads = function () { return []; };
        }

        // Plugin enumeration: shadow the real PluginArray/MimeTypeArray with an
        // empty native-like view so item()/namedItem()/iteration still exist.
        const realPlugins = navigator.plugins;
        const realMimeTypes = navigator.mimeTypes;
        const emptyView = (real) => new Proxy(real, {
          get (t, prop) {
            if (prop === 'length') return 0;
            if (prop === 'item' || prop === 'namedItem') return () => null;
            if (prop === Symbol.iterator) return function* () {};
            const v = Reflect.get(t, prop, t);
            return typeof v === 'function' ? v.bind(t) : v;
          },
          has () { return false; }
        });
        Object.defineProperty(navigator, 'plugins', {
          get: () => emptyView(realPlugins), enumerable: true, configurable: true
        });
        Object.defineProperty(navigator, 'mimeTypes', {
          get: () => emptyView(realMimeTypes), enumerable: true, configurable: true
        });

        log('[shapeshift][page][sensors] Hooks installed');
      } catch (e) {
        log('[shapeshift][page][sensors] Failed:', e);
      }
    }

    // ========================================================================
    // TOUCH HOOKS (MAIN world)
    // ========================================================================
    if (config.enableTouchProtection) {
      try {
        const touchCaps = [0, 0, 0, 0, 1, 5, 10];
        const spoofedTouch = touchCaps[hashString(seed + ':touch') % touchCaps.length];

        Object.defineProperty(navigator, 'maxTouchPoints', {
          get: () => spoofedTouch, enumerable: true, configurable: true
        });

        const shouldHaveTouch = spoofedTouch > 0;
        if (shouldHaveTouch) {
          if (!('ontouchstart' in window)) {
            try { window.ontouchstart = null; } catch (e) { /* ignore */ }
          }
        } else if ('ontouchstart' in window) {
          try {
            delete window.ontouchstart;
          } catch (e) {
            try {
              Object.defineProperty(window, 'ontouchstart', {
                get: () => undefined, configurable: true
              });
            } catch (e2) { /* best effort */ }
          }
        }

        const origMatchMedia = window.matchMedia;
        window.matchMedia = function (query) {
          const result = origMatchMedia.call(this, query);
          const lower = String(query).toLowerCase();
          if (lower.includes('pointer') || lower.includes('hover')) {
            function spoofedMatches () {
              if (lower.includes('pointer:') && lower.includes('coarse')) return shouldHaveTouch;
              if (lower.includes('pointer:') && lower.includes('fine')) return !shouldHaveTouch;
              if (lower.includes('hover:') && lower.includes('none')) return shouldHaveTouch;
              if (lower.includes('hover:') && lower.includes('hover')) return !shouldHaveTouch;
              return result.matches;
            }
            return new Proxy(result, {
              get (target, prop) {
                if (prop === 'matches') return spoofedMatches();
                const v = target[prop];
                return typeof v === 'function' ? v.bind(target) : v;
              }
            });
          }
          return result;
        };

        log('[shapeshift][page][touch] Hooks installed');
      } catch (e) {
        log('[shapeshift][page][touch] Failed:', e);
      }
    }

    // ========================================================================
    // USER AGENT HOOKS (MAIN world) - one persona shared by every surface so
    // navigator.userAgent and userAgentData never disagree (P1 2.9).
    // ========================================================================
    if (config.enableUserAgentProtection) {
      try {
        const platforms = [
          { platform: 'Win32', ua: 'Windows NT 10.0; Win64; x64', brands: ['Chromium', 'Google Chrome', 'Not-A.Brand'] },
          { platform: 'MacIntel', ua: 'Macintosh; Intel Mac OS X 10_15_7', brands: ['Chromium', 'Google Chrome', 'Not-A.Brand'] },
          { platform: 'Linux x86_64', ua: 'X11; Linux x86_64', brands: ['Chromium', 'Google Chrome', 'Not-A.Brand'] }
        ];
        const persona = platforms[hashString(seed + ':ua') % platforms.length];
        const majorMatch = /Chrome\/(\d+)/.exec(navigator.userAgent);
        const major = majorMatch ? majorMatch[1] : '126';

        const uaGet = () =>
          'Mozilla/5.0 (' + persona.ua + ') AppleWebKit/537.36 (KHTML, like Gecko) Chrome/' +
          major + '.0.0.0 Safari/537.36';

        Object.defineProperty(navigator, 'userAgent', {
          get: uaGet, enumerable: true, configurable: true
        });
        Object.defineProperty(navigator, 'appVersion', {
          get: () => uaGet().replace('Mozilla/', ''), enumerable: true, configurable: true
        });
        Object.defineProperty(navigator, 'platform', {
          get: () => persona.platform, enumerable: true, configurable: true
        });

        if (navigator.userAgentData) {
          const realUAD = navigator.userAgentData;
          const brands = persona.brands.map((brand, i) => ({
            brand, version: i === persona.brands.length - 1 ? '99' : major
          }));
          Object.defineProperty(navigator, 'userAgentData', {
            get: () => new Proxy(realUAD, {
              get (target, prop) {
                if (prop === 'brands') return brands;
                if (prop === 'platform') return persona.platform === 'MacIntel' ? 'macOS'
                  : (persona.platform === 'Win32' ? 'Windows' : 'Linux');
                if (prop === 'getHighEntropyValues') {
                  return (hints) => target.getHighEntropyValues(hints).then((values) => {
                    values.platformVersion = '10.0.0';
                    values.fullVersionList = brands;
                    return values;
                  });
                }
                const v = Reflect.get(target, prop, target);
                return typeof v === 'function' ? v.bind(target) : v;
              }
            }), enumerable: true, configurable: true
          });
        }

        log('[shapeshift][page][ua] Hooks installed, platform:', persona.platform);
      } catch (e) {
        log('[shapeshift][page][ua] Failed:', e);
      }
    }

    // ========================================================================
    // MEDIA HOOKS (MAIN world) - deterministic per input (P1 2.2 / 2.3).
    // ========================================================================
    if (config.enableMediaProtection) {
      try {
        const roll = (label, input) =>
          hashString(seed + ':' + label + ':' + String(input)) / 4294967296;

        if (HTMLMediaElement.prototype.canPlayType) {
          const origCanPlayType = HTMLMediaElement.prototype.canPlayType;
          HTMLMediaElement.prototype.canPlayType = function (type) {
            const result = origCanPlayType.call(this, type);
            if (roll('canplay', type) < 0.1) {
              if (result === 'maybe') return 'probably';
              if (result === 'probably') return 'maybe';
            }
            return result;
          };
        }

        if (window.MediaSource && MediaSource.isTypeSupported) {
          const origIsTypeSupported = MediaSource.isTypeSupported;
          MediaSource.isTypeSupported = function (type) {
            const result = origIsTypeSupported.call(this, type);
            const nonCritical = ['av01', 'vp9', 'opus'];
            if (nonCritical.some((c) => String(type).includes(c)) && roll('mstype', type) < 0.05) {
              return !result;
            }
            return result;
          };
        }

        if (navigator.mediaCapabilities && navigator.mediaCapabilities.decodingInfo) {
          const origDecodingInfo = navigator.mediaCapabilities.decodingInfo;
          navigator.mediaCapabilities.decodingInfo = function (configuration) {
            return origDecodingInfo.call(this, configuration).then((info) => {
              if (info.powerEfficient !== undefined &&
                  roll('power', JSON.stringify(configuration)) < 0.1) {
                info.powerEfficient = !info.powerEfficient;
              }
              return info;
            });
          };
        }

        // Swap a private copy, keyed on (seed, kind), instead of mutating the
        // native result in place.
        function stableSwap (caps, label) {
          if (!caps || !caps.codecs || caps.codecs.length < 2) return caps;
          const codecs = caps.codecs.slice();
          const r = roll(label, '');
          const i = Math.floor(r * codecs.length);
          const j = (i + 1 + Math.floor(r * 997) % (codecs.length - 1)) % codecs.length;
          const tmp = codecs[i];
          codecs[i] = codecs[j];
          codecs[j] = tmp;
          const copy = Object.assign({}, caps);
          copy.codecs = codecs;
          return copy;
        }

        if (window.RTCRtpSender && RTCRtpSender.getCapabilities) {
          const orig = RTCRtpSender.getCapabilities;
          RTCRtpSender.getCapabilities = function (kind) {
            return stableSwap(orig.call(this, kind), 'rtp-sender');
          };
        }
        if (window.RTCRtpReceiver && RTCRtpReceiver.getCapabilities) {
          const orig = RTCRtpReceiver.getCapabilities;
          RTCRtpReceiver.getCapabilities = function (kind) {
            return stableSwap(orig.call(this, kind), 'rtp-receiver');
          };
        }

        log('[shapeshift][page][media] Hooks installed');
      } catch (e) {
        log('[shapeshift][page][media] Failed:', e);
      }
    }

    // ========================================================================
    // GEOLOCATION HOOKS (MAIN world)
    // ========================================================================
    if (config.enableGeolocationProtection && navigator.geolocation) {
      try {
        // P0 1.1: this block used to be a no-op - both branches called straight
        // through to the native method, so the "Geolocation fuzzing" toggle
        // advertised a protection the page could never observe. Offset the
        // reported fix deterministically per origin instead.
        const geoNoise = (config.geolocation && typeof config.geolocation.noiseLevel === 'number')
          ? config.geolocation.noiseLevel
          : 0.001;
        const origGetCurrentPosition = navigator.geolocation.getCurrentPosition;
        const origWatchPosition = navigator.geolocation.watchPosition;

        // One stable offset per (seed, coordinate) pair: two reads of the same
        // real fix must not disagree, or the shim is trivially detectable.
        function shift (lat, lon) {
          const dLat = ((hashString(seed + ':geo:lat:' + lat) / 4294967296) - 0.5) * geoNoise;
          const dLon = ((hashString(seed + ':geo:lon:' + lon) / 4294967296) - 0.5) * geoNoise;
          return { latitude: lat + dLat, longitude: lon + dLon };
        }

        // Shadow the native getters on a copy that keeps the original prototype,
        // so `coords instanceof GeolocationCoordinates` still holds.
        function fuzzPosition (position) {
          if (!position || !position.coords) return position;
          const real = position.coords;
          const shifted = shift(real.latitude, real.longitude);
          const coords = Object.create(Object.getPrototypeOf(real));
          Object.defineProperties(coords, {
            latitude: { get: () => shifted.latitude, enumerable: true, configurable: true },
            longitude: { get: () => shifted.longitude, enumerable: true, configurable: true },
            accuracy: { get: () => real.accuracy, enumerable: true, configurable: true },
            altitude: { get: () => real.altitude, enumerable: true, configurable: true },
            altitudeAccuracy: { get: () => real.altitudeAccuracy, enumerable: true, configurable: true },
            heading: { get: () => real.heading, enumerable: true, configurable: true },
            speed: { get: () => real.speed, enumerable: true, configurable: true }
          });
          const copy = Object.create(Object.getPrototypeOf(position));
          Object.defineProperties(copy, {
            coords: { get: () => coords, enumerable: true, configurable: true },
            timestamp: { get: () => position.timestamp, enumerable: true, configurable: true }
          });
          return copy;
        }

        navigator.geolocation.getCurrentPosition = function (success, error, options) {
          if (typeof success !== 'function') {
            return origGetCurrentPosition.call(this, success, error, options);
          }
          return origGetCurrentPosition.call(this, function (position) {
            return success(fuzzPosition(position));
          }, error, options);
        };

        if (typeof origWatchPosition === 'function') {
          navigator.geolocation.watchPosition = function (success, error, options) {
            if (typeof success !== 'function') {
              return origWatchPosition.call(this, success, error, options);
            }
            return origWatchPosition.call(this, function (position) {
              return success(fuzzPosition(position));
            }, error, options);
          };
        }

        log('[shapeshift][page][geo] Hooks installed, noise:', geoNoise);
      } catch (e) {
        log('[shapeshift][page][geo] Failed:', e);
      }
    }

    // ========================================================================
    // DETECTION RESISTANCE (MAIN world) - only the surfaces the page can read.
    // ========================================================================
    if (config.enableDetectionResistance) {
      try {
        Object.defineProperty(navigator, 'webdriver', {
          get: () => false, enumerable: true, configurable: true
        });

        if (navigator.permissions && navigator.permissions.query) {
          const origQuery = navigator.permissions.query;
          navigator.permissions.query = function (params) {
            return origQuery.call(this, params).then((status) => {
              if (params && params.name === 'notifications') {
                return new Proxy(status, {
                  get (t, prop) {
                    if (prop === 'state') return Notification.permission;
                    const v = Reflect.get(t, prop, t);
                    return typeof v === 'function' ? v.bind(t) : v;
                  }
                });
              }
              return status;
            });
          };
        }
        log('[shapeshift][page][detection] Hooks installed');
      } catch (e) {
        log('[shapeshift][page][detection] Failed:', e);
      }
    }

    log('[shapeshift][page] All hooks installed successfully');
  }, { once: true }); // One-shot: a second SS_INIT_PAGE_HOOKS must never re-install
                      // hooks or swap the seed the page already received.

  // Re-announce readiness (with the nonce) once all hooks are installed. The
  // first announcement already ran synchronously at document_start; this second
  // one covers the case where the ISOLATED bootstrap registered its listener
  // only after that turn.
  announceReady();
})();
