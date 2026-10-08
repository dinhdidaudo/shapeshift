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
      for (const gk in value) {
        const gv = value[gk];
        if (typeof gv === 'boolean' || (typeof gv === 'number' && isFinite(gv))) copy[gk] = gv;
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
            ctx = this.getContext('2d', { willReadFrequently: true });
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
            const ctx = this.getContext('2d', { willReadFrequently: true });
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
        const spoofed = sampleResolution();
        const spoofedPixelRatio = spoofed.width >= 2560 ? 2 : 1;
        const colorDepths = [24, 24, 24, 30, 32];
        const spoofedColorDepth = colorDepths[Math.floor(prng() * colorDepths.length)];

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
        defineGetter(window.screen, 'availHeight', () => spoofed.height - 40);
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

        // Find timezones with the same offset as real timezone
        const offsetKey = String(realOffset);
        const availableZones = timezonesByOffset[offsetKey] || [];

        if (availableZones.length > 0) {
          // Pick a random timezone from the same offset group
          const spoofedZone = availableZones[Math.floor(prng() * availableZones.length)];

          // Hook Intl.DateTimeFormat to return spoofed timezone
          const OrigDateTimeFormat = Intl.DateTimeFormat;
          Intl.DateTimeFormat = function(...args) {
            const instance = new OrigDateTimeFormat(...args);
            const origResolvedOptions = instance.resolvedOptions;

            instance.resolvedOptions = function() {
              const options = origResolvedOptions.call(this);
              options.timeZone = spoofedZone;
              return options;
            };

            return instance;
          };

          // Copy static properties
          Object.setPrototypeOf(Intl.DateTimeFormat, OrigDateTimeFormat);
          Object.setPrototypeOf(Intl.DateTimeFormat.prototype, OrigDateTimeFormat.prototype);

          log('[shapeshift][page][timezone] Real offset:', realOffset, 'Spoofed zone:', spoofedZone);
        } else {
          log('[shapeshift][page][timezone] No alternative timezones for offset:', realOffset);
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

            if (maskVendors && vendorParams.includes(p) && typeof value === 'string') {
              const suffix = (Math.floor(prng() * 0xFFFF) || 1) >>> 0;
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

    log('[shapeshift][page] All hooks installed successfully');
  }, { once: true }); // One-shot: a second SS_INIT_PAGE_HOOKS must never re-install
                      // hooks or swap the seed the page already received.

  // Re-announce readiness (with the nonce) once all hooks are installed. The
  // first announcement already ran synchronously at document_start; this second
  // one covers the case where the ISOLATED bootstrap registered its listener
  // only after that turn.
  announceReady();
})();
