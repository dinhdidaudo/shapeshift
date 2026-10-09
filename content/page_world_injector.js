// Page-world injector - runs in MAIN world to hook actual page APIs
// This script has NO access to chrome.* APIs but can modify page JavaScript
(function () {
  'use strict';

  // P1 (determinism): every value the MAIN world hands the page is now derived
  // from hashString(seed + ':surface:field'), not from a streaming PRNG. A
  // stream advanced once per read, so two reads of the same property disagreed
  // and the "noise" drifted without bound - a one-line oracle. The inlined
  // Xoshiro128** copy that used to live here was the last consumer; with it
  // gone the injector has no per-load mutable RNG state at all.

  // FNV-1a hash, identical to core/hash.js. MAIN world does not load the core
  // files, so the same derivation is inlined here to keep per-surface noise
  // stable across reads and consistent with the ISOLATED hooks.
  //
  // P1 (hot loop): `fnvUpdate` is exported inside this IIFE for the same reason
  // core/hash.js exports it - FNV-1a is a pure sequential fold, so a caller that
  // repeats a constant prefix (canvas byte noise) can fold the prefix once and
  // only fold the varying digits afterwards. That is byte-identical to hashing
  // the full string from scratch, and it removes the per-byte string build that
  // used to dominate a 1920x1080 getImageData() in the page's own thread.
  const FNV_OFFSET = 0x811C9DC5;
  const FNV_PRIME = 0x01000193;
  function fnvUpdate(state, value) {
    let h = state >>> 0;
    const s = String(value);
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, FNV_PRIME);
      h >>>= 0;
    }
    return h >>> 0;
  }
  function hashString(str) {
    return fnvUpdate(FNV_OFFSET, str);
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
  // P2 7.4 (persona profile): the only top-level STRING key in the config.
  // `sanitizeConfig` used to copy booleans and bounded numbers only, so a
  // `persona` value would never have reached the hooks even though the schema
  // declared it. Whitelist the four known values here, exactly like
  // WEBRTC_MODES does for the nested webrtc enum, so a forged message cannot
  // inject an arbitrary string into the persona picker.
  const PERSONA_MODES = ['auto', 'windows', 'mac', 'linux'];
  const CONFIG_BOOLEAN_KEYS = [
    'debug', 'enableCanvasNoise', 'enableWebGLMasking', 'maskWebGLVendorStrings',
    'shuffleWebGLExtensions', 'enableAudioNoise', 'enableNavigatorFuzz',
    'perOriginFingerprint', 'enableWebRTCProtection', 'enableMediaDeviceProtection',
    'enableScreenProtection', 'enableFontProtection', 'enableTimezoneProtection',
    'enableSensorProtection', 'enableTouchProtection', 'enableUserAgentProtection',
    'enableMediaProtection', 'enableGeolocationProtection', 'enableDetectionResistance',
    'enableWebGPUProtection', 'enableKeyboardProtection',
    'useStrongKDF', 'useGaussianNoise', 'autoRotateFingerprint', 'rotateOnStartup'
  ];
  // P1 2.14: the group loop used to copy every boolean/number key it found, so
  // a forged `screen: { foo: 1e9 }` (or `geolocation: { noiseLevel: 1e9 }`)
  // reached the hooks unclamped. Groups are now whitelisted per key exactly
  // like the top-level scalars: booleans by name, numbers by name + bounds.
  // P2 7.2: `webrtc.mode` is a string enum, not a boolean, so it needs its own
  // whitelist. Only the three known values are copied, and the effective mode is
  // then derived exactly like hooks_webrtc.js does - that shared derivation is
  // what stops the two worlds from disagreeing about the SDP rewrite policy.
  const WEBRTC_MODES = ['off', 'block-host-srflx', 'relay-only'];
  function effectiveWebrtcMode(group) {
    const g = group || {};
    if (WEBRTC_MODES.indexOf(g.mode) !== -1) return g.mode;
    if (g.forceRelay === true) return 'relay-only';
    if (g.blockIPLeak === false) return 'off';
    return 'block-host-srflx';
  }
  const CONFIG_GROUP_STRING_KEYS = {
    webrtc: ['mode']
  };
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
    if (PERSONA_MODES.indexOf(raw.persona) !== -1) out.persona = raw.persona;
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
      const strKeys = CONFIG_GROUP_STRING_KEYS[group] || [];
      for (let s = 0; s < strKeys.length; s++) {
        const sk = strKeys[s];
        const sv = value[sk];
        if (sk === 'mode') {
          if (WEBRTC_MODES.indexOf(sv) !== -1) copy[sk] = sv;
        } else if (typeof sv === 'string') {
          copy[sk] = sv;
        }
      }
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

    // P2 (statistics §7.1): the ISOLATED hooks already increment
    // ssStatsTracker, but every hook that lives in this file was invisible to
    // the counters - the page could read a canvas, a WebGL parameter or an
    // AudioBuffer a million times and the popup still reported zero. Report
    // each MAIN-world read back over the same window.postMessage channel the
    // handshake uses; stats_tracker.js picks these up and folds them into the
    // existing counters, so both worlds contribute to one number.
    // The category name is validated on the receiving side, and the message
    // carries no page data - only a fixed label - so nothing about the page
    // leaks through it.
    function bumpStat(category) {
      try {
        window.postMessage({
          type: 'SS_STAT',
          protocol: 1,
          category: category
        }, location.origin);
      } catch (e) { /* never break a hook over a counter */ }
    }

    log('[shapeshift][page] Initializing page-world hooks with config:', config);

    // P2 7.2 (coherent persona): every surface used to pick its persona
    // independently, so one origin could advertise a MacIntel platform, an
    // "ANGLE (Apple, Apple M1 ...)" renderer and a Win32-shaped client hint at
    // the same time - a combination no real machine produces, which is itself a
    // stronger fingerprint than any single real value. One ':persona' pick now
    // selects the OS family, and every surface filters its candidate list by it
    // so the bundle is coherent while each surface keeps its own ':gpu'/':ua'
    // stream. hooks_webgl.js computes the identical pick from the identical key.
    const PERSONA_OS = ['windows', 'mac', 'linux'];
    // P2 7.4: an explicit profile pins the family; 'auto' (or an absent key)
    // keeps the seed-derived pick. Both branches yield one of PERSONA_OS, so
    // every downstream `.filter((p) => p.os === personaOs)` is non-empty.
    const personaOs = PERSONA_OS.indexOf(config.persona) !== -1
      ? config.persona
      : PERSONA_OS[hashString(seed + ':persona') % PERSONA_OS.length];

    // P1 5.3 (own-property leak): real Chrome keeps every navigator field as an
    // accessor on Navigator.prototype; the instance's own property list is
    // EMPTY. Defining shadows on `navigator` itself put hardwareConcurrency,
    // deviceMemory, plugins, mimeTypes, maxTouchPoints, userAgent, appVersion,
    // platform, userAgentData and webdriver into
    // Object.getOwnPropertyNames(navigator) - a one-line detector that also
    // disagreed with the ISOLATED world. Every field below is now defined on
    // this prototype, exactly like hooks_screen.js does for Screen.
    const navProto = Object.getPrototypeOf(navigator) || navigator;

    // P1 (determinism): the streaming `prng`/`gaussianNoise`/`noise` trio used
    // to live here. Every call site has since moved to hashString(seed + …),
    // which is stable across reads and identical in both worlds, so the trio
    // was dead weight that only invited a future call site to reintroduce a
    // drifting value. `config.useGaussianNoise` is still accepted and clamped
    // by sanitizeConfig; it now only documents the intended distribution.

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
        //
        // P1 (hot loop): the old per-byte hash re-folded the whole `<seed>:`
        // prefix for every byte, so a 1920x1080 read built ~6M strings and
        // ~90M character folds in the page's own thread. The prefix state is
        // folded once here and each byte only folds its own index digits; FNV-1a
        // is a pure sequential fold, so the value is byte-identical to the old
        // formula and both worlds still agree on every pixel.
        const canvasPrefixState = fnvUpdate(FNV_OFFSET, canvasSeed + ':');
        function pixelNoise(index) {
          const h = fnvUpdate(canvasPrefixState, index);
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
          bumpStat('canvasReads');
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

        // P0: the previous version parked the 2d context and the snapshot on
        // the canvas element itself (`canvas.__ssCtx`, `canvas.__ssSnapshot`).
        // Those are page-visible own properties: a detector only has to call
        // Object.getOwnPropertyNames(canvas) after toBlob() to see the shim and
        // infer exactly what it does. Keep the pending restore in a closure-scoped
        // WeakMap instead, so nothing is ever written onto page objects.
        const pendingRestore = new WeakMap();

        HTMLCanvasElement.prototype.toBlob = function() {
          const args = arguments;
          const canvas = this;
          const restore = function () {
            const pending = pendingRestore.get(canvas);
            if (pending) {
              pendingRestore.delete(canvas);
              try { pending.ctx.putImageData(pending.original, 0, 0); } catch (e) { /* ignore */ }
            }
          };
          try {
            const ctx = this.getContext('2d');
            if (ctx && origGetImageData) {
              const snapshot = noisedCopyOf(ctx, this.width, this.height);
              pendingRestore.set(canvas, { ctx: ctx, original: snapshot.original });
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

        // P2: OffscreenCanvas is a modern canvas-fingerprint path that the
        // HTMLCanvasElement hooks above never see. getImageData is the read
        // surface; the export methods consume the backing store, so only the
        // returned pixels are noised here (no restore dance needed).
        const offscreenProto = window.OffscreenCanvasRenderingContext2D &&
          window.OffscreenCanvasRenderingContext2D.prototype;
        if (offscreenProto && offscreenProto.getImageData) {
          const origOffscreenGetImageData = offscreenProto.getImageData;
          offscreenProto.getImageData = function (x, y, w, h) {
            bumpStat('canvasReads');
            const imgData = origOffscreenGetImageData.call(this, x, y, w, h);
            const data = imgData.data;
            for (let i = 0; i < data.length; i += 4) {
              data[i] += pixelNoise(i);
              data[i + 1] += pixelNoise(i + 1);
              data[i + 2] += pixelNoise(i + 2);
            }
            return imgData;
          };
        }

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
          // P1: keyed on (seed, field) instead of the streaming PRNG, so two
          // loads of the same origin advertise the same screen. A rotating
          // resolution is itself a fingerprint and disagreed with the ISOLATED
          // world's screen hook.
          const r = hashString(seed + ':screen:resolution') / 4294967296;
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
        const spoofedColorDepth = colorDepths[
          hashString(seed + ':screen:colorDepth') % colorDepths.length];

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
            // P1: patched accessors must be non-enumerable, exactly like the
            // native Screen/Window getters they replace. An enumerable shadow
            // shows up in Object.keys(screen) and is a one-line oracle.
            // P2 4.4: this world is the only copy the page can read, so it is
            // also the only place a screen read can be observed - report it
            // over the same SS_STAT bridge the canvas and WebGL hooks use.
            Object.defineProperty(obj, prop, {
              get: function () {
                bumpStat('screenReads');
                return getter.call(this);
              },
              enumerable: false,
              configurable: true
            });
          } catch (e) {
            log(`[shapeshift][page][screen] Failed to define ${prop}:`, e.message);
          }
        }

        // P2 5.3 (own-property leak): these getters used to be defined on the
        // `window.screen` INSTANCE, so `Object.getOwnPropertyNames(screen)`
        // returned ten names where a real Chrome returns none (every screen
        // field is an accessor on Screen.prototype). One line revealed the
        // extension even though the values themselves looked plausible. Define
        // on the prototype, exactly like the MAIN-world navigator hooks and
        // hooks_useragent.js do.
        const screenProto = Object.getPrototypeOf(window.screen) || window.screen;
        defineGetter(screenProto, 'width', () => spoofed.width);
        defineGetter(screenProto, 'height', () => spoofed.height);
        defineGetter(screenProto, 'availWidth', () => spoofed.width);
        defineGetter(screenProto, 'availHeight', () => spoofed.height - availOffset);
        defineGetter(screenProto, 'colorDepth', () => spoofedColorDepth);
        defineGetter(screenProto, 'pixelDepth', () => spoofedColorDepth);
        // devicePixelRatio IS an own accessor of the window object natively, so
        // it stays on `window` itself.
        defineGetter(window, 'devicePixelRatio', () => spoofedPixelRatio);
        // P2: availLeft/availTop are separate high-entropy values that the
        // previous build left fully real (and disagreeing with a spoofed
        // availWidth). Derive them from the same seed so they stay consistent.
        // Real desktop screens report 0; a non-zero availLeft/availTop is a
        // multi-monitor tell, so pin both to 0 rather than inventing an offset
        // that would disagree with availWidth.
        defineGetter(screenProto, 'availLeft', () => 0);
        defineGetter(screenProto, 'availTop', () => 0);
        // (screen.orientation is re-asserted on its prototype below.)

        // P2 7.3: screen.orientation was hooked only in the ISOLATED world, so
        // the page read the untouched native object (owner/patch-state oracle).
        // It is re-asserted here on ScreenOrientation.prototype - not on the
        // instance - so Object.getOwnPropertyNames(screen.orientation) stays as
        // empty as it is natively, and the REAL values are preserved because
        // rewriting the angle breaks every orientation-driven app.
        const orientation = window.screen && window.screen.orientation;
        const OrientationCtor = window.ScreenOrientation;
        if (orientation && OrientationCtor && OrientationCtor.prototype) {
          for (const prop of ['type', 'angle']) {
            const desc = Object.getOwnPropertyDescriptor(OrientationCtor.prototype, prop);
            if (!desc || typeof desc.get !== 'function') continue;
            Object.defineProperty(OrientationCtor.prototype, prop, {
              get: function () { return desc.get.call(this); },
              enumerable: false,
              configurable: true
            });
          }
        }

        log('[shapeshift][page][screen] Hooks installed');
      } catch (e) {
        log('[shapeshift][page][screen] Failed:', e);
      }
    }

    // ========================================================================
    // NAVIGATOR HOOKS
    // ========================================================================
    // Shared with the worker shim further down: a worker realm that advertises
    // a different core count or memory class than the page is a one-round-trip
    // oracle, so both must repeat the SAME derived values instead of drawing
    // from two independent hash streams (P1 world-split).
    let ssNavCores = null;
    let ssNavMemory = null;
    if (config.enableNavigatorFuzz) {
      try {
        const nav = navigator;
        const realHardwareConcurrency = nav.hardwareConcurrency || 4;
        const realDeviceMemory = nav.deviceMemory || 8;

        // P1: keyed on (seed, field) rather than the streaming PRNG, so the
        // advertised core count and memory stay put across reloads and match
        // the ISOLATED navigator hook instead of drifting on every load.
        const fuzzedConcurrency = Math.max(2, realHardwareConcurrency +
          (hashString(seed + ':nav:cores') % 5) - 2);
        const fuzzedMemory = Math.max(4, realDeviceMemory +
          (hashString(seed + ':nav:memory') % 5) - 2);
        // Published for the worker shim, which must repeat these exact numbers
        // rather than re-fuzz the already-spoofed navigator getters.
        ssNavCores = fuzzedConcurrency;
        ssNavMemory = fuzzedMemory;

        // configurable: true so a later stage (or a user re-init) can redefine
        // the property; a non-configurable descriptor here permanently blocked
        // every other hook from touching deviceMemory.
        if (config.navigator?.fuzzHardwareConcurrency !== false) {
          Object.defineProperty(navProto, 'hardwareConcurrency', {
            get: () => { bumpStat('navigatorReads'); return fuzzedConcurrency; },
            enumerable: false,
            configurable: true
          });
        }

        if (config.navigator?.fuzzDeviceMemory !== false && 'deviceMemory' in navigator) {
          Object.defineProperty(navProto, 'deviceMemory', {
            get: () => { bumpStat('navigatorReads'); return fuzzedMemory; },
            enumerable: false,
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
        // P1 determinism: these probes used `new Date()` / `Date.now()`, so the
        // DST-consistent candidate set - and therefore the zone the seed picked
        // out of it - changed with the season: the same (salt, origin) could
        // advertise one zone today and a different one six months later. Probe
        // two fixed instants instead. The ISOLATED hook uses the same pair, so
        // the two worlds can never disagree about the candidate set.
        const sampleA = new Date(Date.UTC(2024, 0, 15, 12, 0, 0));
        const sampleB = new Date(Date.UTC(2024, 6, 15, 12, 0, 0));
        const realA = zoneOffsetMinutes(realZone, sampleA);
        const realB = zoneOffsetMinutes(realZone, sampleB);

        const availableZones = candidates.filter(function (z) {
          return zoneOffsetMinutes(z, sampleA) === realA &&
                 zoneOffsetMinutes(z, sampleB) === realB;
        });

        if (availableZones.length > 0) {
          // Pick a timezone from the DST-consistent group, keyed on
          // (seed, offset) so the same origin always advertises the same zone.
          const spoofedZone = availableZones[
            hashString(seed + ':tz:' + offsetKey) % availableZones.length];

          // P2 5.3 (own-property leak): this used to assign a fresh closure to
          // EVERY instance's own `resolvedOptions`. Real Chrome returns [] from
          // Object.getOwnPropertyNames(new Intl.DateTimeFormat()) while the
          // shim returned ['resolvedOptions'] - a one-line oracle - and
          // `.resolvedOptions.toString()` printed the hook source. Patch the
          // shared PROTOTYPE with one named function instead; the toString
          // guard below registers it so it answers the native form.
          const origResolvedOptions = OrigIntlDateTimeFormat.prototype.resolvedOptions;
          OrigIntlDateTimeFormat.prototype.resolvedOptions = function () {
            bumpStat('timezoneReads');
            const options = origResolvedOptions.call(this);
            options.timeZone = spoofedZone;
            return options;
          };

          // Hook Intl.DateTimeFormat to return spoofed timezone
          Intl.DateTimeFormat = function(...args) {
            return new OrigIntlDateTimeFormat(...args);
          };

          // Preserve the full static surface and the prototype chain, using the
          // exact spelling the ISOLATED hook uses (hooks_timezone.js). Handing
          // back the native prototype OBJECT - not a fresh object that merely
          // inherits from it - keeps Object.getOwnPropertyNames() on it equal to
          // the native list; setPrototypeOf left only ['constructor'] own, which
          // no real Intl.DateTimeFormat.prototype reports.
          Object.setPrototypeOf(Intl.DateTimeFormat, OrigIntlDateTimeFormat);
          Intl.DateTimeFormat.prototype = OrigIntlDateTimeFormat.prototype;

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
        // P0: parameters whose exact value IS the fingerprint (hardware limits,
        // precision bits) must not be shifted by a constant, or MAX_TEXTURE_SIZE
        // reports 16386 instead of 16384 and contradicts the same value read
        // from the ISOLATED world.
        const INTEGER_LIMIT_PARAMS = new Set([
          0x0D33 /* MAX_TEXTURE_SIZE */, 0x851C /* MAX_3D_TEXTURE_SIZE */,
          0x8073 /* MAX_ARRAY_TEXTURE_LAYERS */, 0x8869 /* MAX_VERTEX_ATTRIBS */,
          0x8B4D /* MAX_COMBINED_UNIFORM_BLOCKS */, 0x8DFB /* MAX_ELEMENT_INDEX */,
          0x8B4C /* MAX_UNIFORM_BLOCK_SIZE */, 0x0D3A /* MAX_VIEWPORT_DIMS */
        ]);
        // P0: every gl.getParameter integer query (MAX_TEXTURE_IMAGE_UNITS,
        // MAX_RENDERBUFFER_SIZE, MAX_VARYING_VECTORS, ...) must stay an integer.
        // The previous formula returned a fraction for every parameter outside
        // the eight-entry set above, so a single integer probe exposed the shim
        // immediately. Decide by the *returned value*, not by the enum: a whole
        // number stays whole, and a float/array/string is never rounded.
        const isIntegerValue = (v) => typeof v === 'number' && Number.isInteger(v);
        const maskVendors = config.maskWebGLVendorStrings !== false;
        const shuffleExt = config.shuffleWebGLExtensions !== false;
        // P0: real GPU vendor/renderer strings never contain an extension
        // namespace, and appending one both leaked the extension name into
        // page-readable output and was itself a one-line fingerprint. Pick a
        // plausible real pair deterministically from the seed instead.
        // P2 7.2 (coherent persona): each entry is tagged with the OS family it
        // can actually come from, and only the entries matching the shared
        // ':persona' pick are eligible. A D3D11/ANGLE renderer behind MacIntel -
        // or a Mesa renderer behind Win32 - is a combination no real machine
        // produces, which is a stronger fingerprint than any single real value.
        // hooks_webgl.js holds this identical list in this identical order with
        // the identical filter, so both worlds still answer with the same pair.
        const GPU_PERSONAS_ALL = [
          { os: 'windows', vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1660 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
          { os: 'windows', vendor: 'Google Inc. (Intel)', renderer: 'ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
          { os: 'windows', vendor: 'Google Inc. (AMD)', renderer: 'ANGLE (AMD, AMD Radeon RX 580 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
          { os: 'mac', vendor: 'Google Inc. (Apple)', renderer: 'ANGLE (Apple, Apple M1, OpenGL 4.1)' },
          { os: 'linux', vendor: 'Google Inc. (Intel)', renderer: 'ANGLE (Intel, Mesa Intel(R) UHD Graphics 620 (CML GT2), OpenGL 4.6 (Core Profile) Mesa 21.2.6)' },
          { os: 'linux', vendor: 'Google Inc. (AMD)', renderer: 'ANGLE (AMD, AMD Radeon RX 580 (POLARIS10, DRM 3.40.0, LLVM 12.0.1), OpenGL 4.6 (Core Profile) Mesa 21.2.6)' }
        ];
        const GPU_PERSONAS = GPU_PERSONAS_ALL.filter((p) => p.os === personaOs);
        const gpuPersona = GPU_PERSONAS[hashString(seed + ':gpu') % GPU_PERSONAS.length];
        const GPU_VENDOR_STRING = gpuPersona.vendor;
        const GPU_RENDERER_STRING = gpuPersona.renderer;

        function patchWebGL(proto) {
          if (!proto || !proto.getParameter) return;
          const origGetParameter = proto.getParameter;

          proto.getParameter = function(p) {
            bumpStat('webglCalls');
            const value = origGetParameter.call(this, p);

            if (typeof value === 'number') {
              // P0: integer-valued queries must stay integer, and the eight
              // hardware-limit params above must stay exact.
              if (INTEGER_LIMIT_PARAMS.has(p) || isIntegerValue(value)) return value;
              // Perturb only within a small relative band so derived quantities
              // (aspect ratios, unit scales) stay internally consistent. Key the
              // offset on (p, value) so two params that hash alike no longer
              // receive an identical shift.
              return value + ((hashString(seed + ':wgl:' + p + ':' + value) % 1000) / 1000 - 0.5) * jitter;
            }

            const gl = this;
            // P1: read the UNMASKED_* params by their literal enum values.
            // `gl.UNMASKED_VENDOR_WEBGL` is only defined once the
            // WEBGL_debug_renderer_info extension has been enabled on that
            // context, so the previous `filter(Boolean)` silently dropped both
            // and left the real GPU string exposed through 0x9245 / 0x9246 -
            // which is exactly what fingerprinters read.
            const UNMASKED_VENDOR = 0x9245;
            const UNMASKED_RENDERER = 0x9246;
            const vendorParams = [
              gl.VENDOR,
              gl.RENDERER,
              UNMASKED_VENDOR,
              UNMASKED_RENDERER
            ].filter((v) => typeof v === 'number' && v > 0);

            // P1 2.1: key the suffix on (seed, param, value) so repeated
            // getParameter(VENDOR) reads return the same string. A streaming
            // PRNG here made two reads disagree, which is trivially detectable.
            if (maskVendors && vendorParams.includes(p) && typeof value === 'string') {
              // P0: replace with a coherent persona string instead of appending
              // a marker. Real GPU strings never contain an extension namespace,
              // and '(ss-...)' leaked the extension name into page-readable
              // output. Vendor and renderer come from the same persona, so
              // VENDOR / RENDERER / UNMASKED_* never contradict each other.
              const isRenderer = p === gl.RENDERER || p === UNMASKED_RENDERER;
              return isRenderer ? GPU_RENDERER_STRING : GPU_VENDOR_STRING;
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
              if (!Array.isArray(list)) return list;
              // P0: a plain .reverse() produced the same fixed order on every
              // machine - a strong deterministic tell no real browser emits.
              // Deterministically permute with a seed-keyed Fisher-Yates pass
              // so the SET stays identical to the native one and only the
              // order varies per install.
              const out = list.slice();
              for (let i = out.length - 1; i > 0; i--) {
                const j = hashString(seed + ':wglext:' + i + ':' + out[i]) % (i + 1);
                const tmp = out[i]; out[i] = out[j]; out[j] = tmp;
              }
              return out;
            };
          }
        }

        if (window.WebGLRenderingContext) patchWebGL(WebGLRenderingContext.prototype);
        if (window.WebGL2RenderingContext) patchWebGL(WebGL2RenderingContext.prototype);

        // P2: getShaderPrecisionFormat leaks the GPU's float precision triple
        // (rangeMin / rangeMax / precision) - a stable, cross-browser-visible
        // hardware tell that the extension previously left fully real. Return
        // the same shape on the native prototype, but deterministically shift
        // `precision` by at most one, keyed on (seed, shaderType, precisionType)
        // so repeated calls on the same context agree.
        for (const Ctor of [window.WebGLRenderingContext, window.WebGL2RenderingContext]) {
          if (!Ctor || !Ctor.prototype || !Ctor.prototype.getShaderPrecisionFormat) continue;
          const origPrecisionFormat = Ctor.prototype.getShaderPrecisionFormat;
          Ctor.prototype.getShaderPrecisionFormat = function (shaderType, precisionType) {
            const real = origPrecisionFormat.call(this, shaderType, precisionType);
            if (!real || typeof real.precision !== 'number') return real;
            const shifted = real.precision > 0 &&
              (hashString(seed + ':wglprec:' + shaderType + ':' + precisionType) % 2) === 1
              ? real.precision - 1
              : real.precision;
            const out = Object.create(Object.getPrototypeOf(real));
            const shadow = (key, value) => {
              try {
                Object.defineProperty(out, key, {
                  get: () => value, enumerable: false, configurable: true
                });
              } catch (e) { /* ignore */ }
            };
            shadow('rangeMin', real.rangeMin);
            shadow('rangeMax', real.rangeMax);
            shadow('precision', shifted);
            return out;
          };
        }

        log('[shapeshift][page][webgl] Hooks installed');
      } catch (e) {
        log('[shapeshift][page][webgl] Failed:', e);
      }
    }

    // ========================================================================
    // WEBGPU HOOKS (P2 7.3)
    //
    // navigator.gpu was completely unprotected, so a page could read the real
    // GPU out of GPUAdapter.info while the WebGL hook reported a persona - two
    // answers for one machine, which is itself a fingerprint. WebGPU exposes no
    // per-context vendor enum, only the async adapter, so the patch is on
    // requestAdapter plus the GPUAdapter.prototype.info accessor and the persona
    // is derived from the same ':gpu' key as the WebGL one.
    // ========================================================================
    if (config.enableWebGPUProtection) {
      try {
        const gpu = navigator.gpu;
        const GPUAdapterCtor = window.GPUAdapter;
        if (gpu && typeof gpu.requestAdapter === 'function' &&
            GPUAdapterCtor && GPUAdapterCtor.prototype) {
          // Same list ordering as the WebGL personas, so the vendor a page reads
          // back through WebGPU agrees with the one WebGL reports.
          // P2 7.2: same OS tags, same order and same filter as GPU_PERSONAS_ALL
          // above, so index i of the filtered list always names the same GPU in
          // both the WebGL and the WebGPU answer.
          const WEBGPU_PERSONAS_ALL = [
            { os: 'windows', vendor: 'nvidia', architecture: 'ampere', device: '0x2484', description: 'NVIDIA GeForce GTX 1660' },
            { os: 'windows', vendor: 'intel', architecture: 'gen-9', device: '0x5917', description: 'Intel(R) UHD Graphics 620' },
            { os: 'windows', vendor: 'amd', architecture: 'gcn-4', device: '0x67df', description: 'AMD Radeon RX 580' },
            { os: 'mac', vendor: 'apple', architecture: 'apple-m1', device: '0x0000', description: 'Apple M1' },
            { os: 'linux', vendor: 'intel', architecture: 'gen-9', device: '0x5917', description: 'Intel(R) UHD Graphics 620 (CML GT2)' },
            { os: 'linux', vendor: 'amd', architecture: 'gcn-4', device: '0x67df', description: 'AMD Radeon RX 580 (POLARIS10)' }
          ];
          const WEBGPU_PERSONAS = WEBGPU_PERSONAS_ALL.filter((p) => p.os === personaOs);
          const webgpuPersona = WEBGPU_PERSONAS[
            hashString(seed + ':gpu') % WEBGPU_PERSONAS.length];

          // The adapter instance is keyed in a WeakMap and the spoof happens in
          // the prototype getter, so no own property ever appears on the adapter
          // (Object.getOwnPropertyNames(adapter) must stay as native as it was).
          const adapterPersona = new WeakMap();
          const origInfoDesc = Object.getOwnPropertyDescriptor(GPUAdapterCtor.prototype, 'info');
          if (origInfoDesc && typeof origInfoDesc.get === 'function') {
            Object.defineProperty(GPUAdapterCtor.prototype, 'info', {
              get: function () {
                const real = origInfoDesc.get.call(this);
                const persona = adapterPersona.get(this);
                if (!persona) return real;
                return {
                  vendor: persona.vendor,
                  architecture: persona.architecture,
                  device: persona.device,
                  description: persona.description
                };
              },
              enumerable: false,
              configurable: true
            });
          }

          const origRequestAdapter = gpu.requestAdapter;
          const tagAdapter = function (adapter) {
            if (adapter && typeof adapter === 'object') {
              try { adapterPersona.set(adapter, webgpuPersona); } catch (e) { /* ignore */ }
            }
            return adapter;
          };
          gpu.requestAdapter = function () {
            const result = origRequestAdapter.apply(this, arguments);
            // requestAdapter returns a promise; a non-promise result is only
            // possible in a stub environment, so pass it through either way.
            if (result && typeof result.then === 'function') {
              return result.then(tagAdapter);
            }
            return tagAdapter(result);
          };
        }

        log('[shapeshift][page][webgpu] Hooks installed');
      } catch (e) {
        log('[shapeshift][page][webgpu] Failed:', e);
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
            bumpStat('audioCalls');
            const data = origGetChannelData.call(this, channel);
            // Copy first: the native call returns the buffer's live Float32Array,
            // so writing into it corrupted the real audio samples and made the
            // noise accumulate on every read.
            // P0: key the noise on (channel, index) too, so the two channels of
            // one buffer do not share a stream and both worlds agree.
            const ch = channel || 0;
            const copy = new Float32Array(data.length);
            for (let i = 0; i < data.length; i++) {
              const h = hashString(audioSeed + ':a:' + ch + ':' + i);
              copy[i] = data[i] + ((h / 4294967296) - 0.5) * audioNoiseStrength;
            }
            return copy;
          };

          // P2: getChannelData is not how real audio fingerprints are taken.
          // AnalyserNode frequency data is, and it was unprotected. The API
          // writes INTO the caller's array, so mutating in place here is the
          // contract, not a leaked side effect.
          const analyserProto = window.AnalyserNode && window.AnalyserNode.prototype;
          if (analyserProto && analyserProto.getFloatFrequencyData) {
            const origFloatFreq = analyserProto.getFloatFrequencyData;
            const origByteFreq = analyserProto.getByteFrequencyData;
            const floatNoise = (i) =>
              ((hashString(audioSeed + ':af:' + i) / 4294967296) - 0.5) * audioNoiseStrength;
            analyserProto.getFloatFrequencyData = function (array) {
              origFloatFreq.call(this, array);
              if (array && typeof array.length === 'number') {
                for (let i = 0; i < array.length; i++) array[i] += floatNoise(i);
              }
            };
            if (typeof origByteFreq === 'function') {
              analyserProto.getByteFrequencyData = function (array) {
                origByteFreq.call(this, array);
                if (array && typeof array.length === 'number') {
                  for (let i = 0; i < array.length; i++) {
                    const step = (hashString(audioSeed + ':ab:' + i) % 3) - 1;
                    const next = array[i] + step;
                    array[i] = next < 0 ? 0 : (next > 255 ? 255 : next);
                  }
                }
              };
            }
          }

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
            // P2 4.4: the ISOLATED font hook counted fontReads, but measureText
            // is only ever observed here, so the counter never moved. Report it.
            bumpStat('fontReads');
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
                  value: noised[key], enumerable: false, configurable: true, writable: false
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
            bumpStat('fontReads');
            const result = origCheck.call(this, font, text);
            // P1 2.7: only upgrade absent -> present, deterministically.
            if (result === false) {
              const flip = (hashString(fontSeed + ':fontcheck:' + String(font) + String(text || '')) % 10) === 0;
              if (flip) return true;
            }
            return result;
          };
        }

        // P1 4.1: the ISOLATED font hook also shuffled `document.fonts`
        // iteration, but an ISOLATED patch is invisible to the page, so the
        // real order stayed readable. Patch the PROTOTYPE here (not the
        // instance) so no own symbol appears on document.fonts - the native
        // iterator lives on FontFaceSet.prototype, and a page that calls
        // Object.getOwnPropertySymbols(document.fonts) must still see [].
        // The live set is read on every iteration and permuted with the same
        // (seed, index, family) key as the ISOLATED copy, so the two worlds
        // agree and repeat iterations of an unchanged set are identical.
        if (document.fonts) {
          const FontFaceSetProto = Object.getPrototypeOf(document.fonts);
          const origFontsIterator = FontFaceSetProto && FontFaceSetProto[Symbol.iterator];
          if (origFontsIterator) {
            Object.defineProperty(FontFaceSetProto, Symbol.iterator, {
              // P2 5.3: named `values` exactly like the native accessor this
              // replaces, so the toString guard can answer the real
              // `function values() { [native code] }` shape instead of the
              // anonymous closure source.
              value: function values () {
                const live = Array.from(origFontsIterator.call(this));
                for (let i = live.length - 1; i > 0; i--) {
                  const j = hashString(fontSeed + ':fontorder:' + i + ':' + live[i].family) % (i + 1);
                  const tmp = live[i]; live[i] = live[j]; live[j] = tmp;
                }
                const iterator = live[Symbol.iterator]();
                // Present the native iterator's prototype so
                // Object.prototype.toString.call(it) still looks native
                // instead of reporting an Array Iterator.
                try {
                  Object.setPrototypeOf(iterator, Object.getPrototypeOf(origFontsIterator.call(this)));
                } catch (e) { /* keep the array iterator */ }
                return iterator;
              },
              writable: true,
              enumerable: false,
              configurable: true
            });
          }
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
        // P2 7.2: derive the policy with the same helper hooks_webrtc.js uses, so
        // the two worlds cannot disagree about which SDP rewrite is in force.
        const webrtcMode = effectiveWebrtcMode(config.webrtc);
        const blockIPLeak = webrtcMode !== 'off';
        const forceRelay = webrtcMode === 'relay-only';
        const webrtcSeed = seed >>> 0;

        if (window.RTCPeerConnection) {
          const OrigRTCPeerConnection = window.RTCPeerConnection;

          function scrubSdp(sdp) {
            let out = sdp;
            if (blockIPLeak) {
              const kept = [];
              // P0: WebRTC SDP lines are CRLF-terminated, so split('\n') left a
              // trailing '\r' on every line and / typ host( |$)/ never matched -
              // host/srflx candidates leaked even though the hook claimed to
              // remove them. Split on CRLF and normalise the line first.
              const lines = out.split(/\r?\n/);
              for (let i = 0; i < lines.length; i++) {
                const line = lines[i];
                if (/^a=candidate:/.test(line) &&
                    (/ typ host( |$)/.test(line) || / typ srflx( |$)/.test(line))) continue;
                kept.push(line);
              }
              out = kept.join('\n');
            }
            // P0: the DTLS fingerprint and the ICE ufrag/pwd are part of the
            // cryptographic handshake. Rewriting them locally broke every real
            // peer connection while providing no privacy benefit (they are
            // per-session anyway, not per-device). The fingerprint also has to
            // stay consistent with the certificate the SDP is describing, so
            // leave the whole `m=`/`a=fingerprint`/`a=ice-*` block untouched.
            return out;
          }

          window.RTCPeerConnection = function (configuration, constraints) {
            // P2 7.2: `relay-only` has to reach the constructor in this world too,
            // otherwise the ISOLATED hook forces relay ICE while the MAIN world
            // still gathers host candidates - two worlds disagreeing about the
            // same connection is itself a fingerprint. Copy the caller's config
            // instead of mutating it.
            let effectiveConfiguration = configuration;
            if (forceRelay) {
              effectiveConfiguration = Object.assign({}, configuration || {}, {
                iceTransportPolicy: 'relay'
              });
            }
            // P2 4.4: the ISOLATED RTCPeerConnection hook incremented webrtcCalls,
            // but a page that constructs a connection reaches this MAIN-world
            // wrapper, so the counter never moved for a real connection.
            bumpStat('webrtcCalls');
            const pc = new OrigRTCPeerConnection(effectiveConfiguration, constraints);
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
                  // P1 3.3 (MAIN parity): a bare Promise.resolve() is a different
                  // thenable identity than the native method's promise and can
                  // never reject - a one-line shape oracle. Calling the native
                  // method with no candidate is a legal no-op that resolves, so
                  // the caller still gets a real native promise. Fall back only
                  // if even that throws.
                  try {
                    return origAddIce.call(this);
                  } catch (e) {
                    return Promise.resolve();
                  }
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
    // MEDIA DEVICE HOOKS (MAIN world) - P0: enumerateDevices used to live only
    // in the ISOLATED world, so the page kept seeing the real deviceId /
    // groupId / label triple that is a stable cross-site identifier.
    // ========================================================================
    if (config.enableMediaDeviceProtection && navigator.mediaDevices &&
        navigator.mediaDevices.enumerateDevices) {
      try {
        const randomizeIds = !config.mediaDevices || config.mediaDevices.randomizeDeviceIds !== false;
        const spoofLabels = !config.mediaDevices || config.mediaDevices.spoofDeviceLabels !== false;
        const origEnumerateDevices = navigator.mediaDevices.enumerateDevices;

        // Deterministic 32-bit FNV-1a. The device list is copied into new
        // plain records so the native MediaDeviceInfo objects the UA hands
        // back are never mutated in place.
        const hashDeviceId = (value) => {
          let h = 0x811c9dc5;
          const s = String(value);
          for (let i = 0; i < s.length; i++) {
            h ^= s.charCodeAt(i);
            h = Math.imul(h, 0x01000193) >>> 0;
          }
          return h.toString(16).padStart(8, '0');
        };

        const genericLabels = {
          audioinput: ['Microphone', 'Default Microphone', 'Internal Microphone'],
          audiooutput: ['Speaker', 'Default Speaker', 'Internal Speaker'],
          videoinput: ['Camera', 'Default Camera', 'Built-in Camera']
        };

        navigator.mediaDevices.enumerateDevices = function () {
          return origEnumerateDevices.call(this).then(function (devices) {
            return devices.map(function (device) {
              const kind = device.kind;
              let deviceId = device.deviceId;
              let groupId = device.groupId;
              let label = device.label;

              if (randomizeIds && deviceId) {
                deviceId = 'ss-' + hashDeviceId(seed + ':dev:' + kind + ':' + deviceId);
                if (groupId) {
                  groupId = 'ss-group-' + hashDeviceId(seed + ':grp:' + groupId);
                }
              }
              if (spoofLabels && label) {
                const labels = genericLabels[kind] || ['Device'];
                label = labels[hashString(seed + ':label:' + (device.deviceId || kind)) % labels.length];
              }

              // P1: a plain object literal loses MediaDeviceInfo, so
              // `devices[0] instanceof MediaDeviceInfo` was false for every
              // entry and `.toJSON()` disappeared - a one-line oracle. Build
              // the copy on the real prototype instead, and install the fields
              // as NON-ENUMERABLE own accessors: native MediaDeviceInfo exposes
              // them as prototype getters with no own enumerable properties,
              // and a plain assignment would hit the setter-less prototype
              // accessor and silently keep the real value.
              const out = Object.create(Object.getPrototypeOf(device));
              const shadow = (key, value) => {
                try {
                  Object.defineProperty(out, key, {
                    get: () => value, enumerable: false, configurable: true
                  });
                } catch (e) { /* ignore */ }
              };
              shadow('deviceId', deviceId);
              shadow('groupId', groupId);
              shadow('kind', kind);
              shadow('label', label);
              return out;
            });
          });
        };

        log('[shapeshift][page][mediaDevices] Hooks installed');
      } catch (e) {
        log('[shapeshift][page][mediaDevices] Failed:', e);
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
            // P2 4.4: only the ISOLATED copy counted sensorReads, so a page that
            // read the battery through this world's hook never moved the counter.
            bumpStat('sensorReads');
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
            get: () => { bumpStat('sensorReads'); return noisedMemory; },
            enumerable: false, configurable: true
          });
        }

        const connection = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
        if (connection) {
          const connectionTypes = ['4g', '4g', '4g', 'wifi', 'wifi'];
          const spoofedType = connectionTypes[
            hashString(seed + ':conn') % connectionTypes.length];
          const spoofedDownlink = spoofedType === 'wifi' ? 10 : 5;
          Object.defineProperty(connection, 'effectiveType', {
            get: () => { bumpStat('sensorReads'); return spoofedType; },
            enumerable: false, configurable: true
          });
          Object.defineProperty(connection, 'downlink', {
            get: () => { bumpStat('sensorReads'); return spoofedDownlink; },
            enumerable: false, configurable: true
          });
        }

        // P2: this returned [] unconditionally, so a page that actually wants
        // gamepad input silently lost it and the config toggle the ISOLATED
        // world honours (sensors.hideGamepads) was ignored here. Only hide the
        // list when the user asked for it, and answer in the native shape.
        if (navigator.getGamepads && (!config.sensors || config.sensors.hideGamepads !== false)) {
          navigator.getGamepads = function () { bumpStat('sensorReads'); return []; };
        }

        // Plugin enumeration: shadow the real PluginArray/MimeTypeArray with an
        // empty native-like view so item()/namedItem()/iteration still exist.
        const realPlugins = navigator.plugins;
        const realMimeTypes = navigator.mimeTypes;
        // P0: without ownKeys/getOwnPropertyDescriptor the proxy still exposed
        // the real plugin indices to Object.getOwnPropertyNames / Object.keys,
        // which is exactly the enumeration this block is supposed to defeat.
        const emptyView = (real) => new Proxy(real, {
          get (t, prop) {
            if (prop === 'length') return 0;
            if (prop === 'item' || prop === 'namedItem') return () => null;
            if (prop === Symbol.iterator) return function* () {};
            const v = Reflect.get(t, prop, t);
            return typeof v === 'function' ? v.bind(t) : v;
          },
          has () { return false; },
          ownKeys () { return []; },
          getOwnPropertyDescriptor (t, prop) {
            if (prop === 'length') {
              return { value: 0, writable: false, enumerable: false, configurable: true };
            }
            return undefined;
          }
        });
        // P1 identity stability: the Proxy must be built ONCE. Wrapping inside
        // the getter returned a fresh object on every read, so
        // `navigator.plugins === navigator.plugins` was false - a one-line
        // oracle, and it disagreed with the ISOLATED world, which caches its
        // proxies correctly (hooks_sensors.js).
        const emptyPlugins = emptyView(realPlugins);
        const emptyMimeTypes = emptyView(realMimeTypes);
        Object.defineProperty(navProto, 'plugins', {
          get: () => { bumpStat('sensorReads'); return emptyPlugins; },
          enumerable: false, configurable: true
        });
        Object.defineProperty(navProto, 'mimeTypes', {
          get: () => { bumpStat('sensorReads'); return emptyMimeTypes; },
          enumerable: false, configurable: true
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

        Object.defineProperty(navProto, 'maxTouchPoints', {
          get: () => { bumpStat('touchReads'); return spoofedTouch; },
          enumerable: false, configurable: true
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
            // P2 4.4 (listener oracle): addEventListener used to be forwarded to
            // the REAL MediaQueryList, so a handler fired with `event.target` and
            // `this` equal to the real list - reading `e.target.matches` there
            // returned the un-spoofed value and defeated the whole shim. Each
            // callback is wrapped so the event it observes carries this proxy as
            // target/currentTarget and the spoofed `matches`; removal is mapped
            // back to the original reference so removeEventListener still works.
            // This mirrors hooks_touch.js so both worlds answer identically.
            const listenerMap = new WeakMap();
            let proxy = null;

            const wrapListener = (listener) => {
              if (typeof listener !== 'function') return listener;
              let wrapped = listenerMap.get(listener);
              if (wrapped) return wrapped;
              wrapped = function (event) {
                let seen = event;
                try {
                  seen = new Proxy(event, {
                    get (t, prop) {
                      if (prop === 'target' || prop === 'currentTarget') return proxy;
                      if (prop === 'matches') return spoofedMatches();
                      const v = t[prop];
                      return typeof v === 'function' ? v.bind(t) : v;
                    }
                  });
                } catch (err) { seen = event; }
                return listener.call(proxy, seen);
              };
              listenerMap.set(listener, wrapped);
              return wrapped;
            };

            const handler = {
              get (target, prop) {
                if (prop === 'matches') return spoofedMatches();
                if (prop === 'addEventListener' || prop === 'addListener') {
                  return function (listener, rest) {
                    return target[prop](wrapListener(listener), rest);
                  };
                }
                if (prop === 'removeEventListener' || prop === 'removeListener') {
                  return function (listener, rest) {
                    return target[prop](listenerMap.get(listener) || listener, rest);
                  };
                }
                const v = target[prop];
                return typeof v === 'function' ? v.bind(target) : v;
              }
            };

            proxy = new Proxy(result, handler);
            // Force the own `matches` value so a listener that fires immediately
            // observes the spoofed state even before the get trap runs.
            try {
              Object.defineProperty(proxy, 'matches', { value: spoofedMatches(), configurable: true });
            } catch (e) { /* non-extensible MediaQueryList; the get trap still wins */ }
            return proxy;
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
        const platformsAll = [
          { os: 'windows', platform: 'Win32', ua: 'Windows NT 10.0; Win64; x64', brands: ['Chromium', 'Google Chrome', 'Not-A.Brand'] },
          { os: 'mac', platform: 'MacIntel', ua: 'Macintosh; Intel Mac OS X 10_15_7', brands: ['Chromium', 'Google Chrome', 'Not-A.Brand'] },
          { os: 'linux', platform: 'Linux x86_64', ua: 'X11; Linux x86_64', brands: ['Chromium', 'Google Chrome', 'Not-A.Brand'] }
        ];
        // P2 7.2: the OS family is owned by the shared ':persona' pick, so the
        // UA platform, the client hints and the GPU renderer can never describe
        // three different machines. hooks_useragent.js derives the same family
        // from the same key.
        const platforms = platformsAll.filter((p) => p.os === personaOs);
        const persona = platforms[hashString(seed + ':ua') % platforms.length];

        // P0 (real Chrome versions, Cloudflare UA check). This used to be
        //     build = 6000 + (hash % 500);  patch = (hash >>> 8) % 200;
        // which produced strings like `Chrome/126.0.6234.187` - build numbers
        // that have never shipped. Cloudflare keeps a database of real Chrome
        // releases and binds `cf_clearance` to the exact User-Agent that earned
        // it, so a fabricated build both fails the plausibility check and
        // invalidates the clearance cookie on the next navigation: the "verify
        // you are human" loop after a rotation.
        //
        // MAIN cannot load core/chrome-versions.js (manifest.json injects this
        // file alone into the MAIN world), so the table is inlined here. It MUST
        // stay identical to core/chrome-versions.js - that file carries the
        // matching comment. Both worlds fold the SAME (seed + ':uabuild') key
        // with the SAME FNV-1a, so they always land on the same real release.
        const CHROME_STABLE_VERSIONS = [
          '126.0.6478.127', '127.0.6533.100', '128.0.6613.120', '129.0.6668.90',
          '130.0.6723.119', '131.0.6778.86', '132.0.6834.84', '133.0.6943.99',
          '134.0.6998.89', '135.0.7049.85', '136.0.7103.93', '137.0.7151.68',
          '138.0.7204.97', '139.0.7258.66', '140.0.7339.80', '141.0.7390.55'
        ];
        const buildHash = hashString(seed + ':uabuild');
        const realMajorMatch = /Chrome\/(\d+)/.exec(navigator.userAgent);
        const realMajor = realMajorMatch ? Number(realMajorMatch[1]) : null;
        // Never advertise a version older than the browser actually is: a
        // Chrome/141 client claiming Chrome/126 is a downgrade no real update
        // path produces, and it is the shape a spoofing extension has.
        let versionCandidates = CHROME_STABLE_VERSIONS;
        if (realMajor !== null) {
          const fresh = CHROME_STABLE_VERSIONS.filter((v) => Number(v.split('.')[0]) >= realMajor);
          if (fresh.length > 0) versionCandidates = fresh;
        }
        const chromeVersion = versionCandidates[buildHash % versionCandidates.length];
        const versionParts = chromeVersion.split('.');
        const major = versionParts[0];
        const minor = versionParts[1];
        const build = versionParts[2];
        const patch = versionParts[3];
        const uaGet = () =>
          'Mozilla/5.0 (' + persona.ua + ') AppleWebKit/537.36 (KHTML, like Gecko) Chrome/' +
          chromeVersion + ' Safari/537.36';

        Object.defineProperty(navProto, 'userAgent', {
          get: uaGet, enumerable: false, configurable: true
        });
        Object.defineProperty(navProto, 'appVersion', {
          get: () => uaGet().replace('Mozilla/', ''), enumerable: false, configurable: true
        });
        Object.defineProperty(navProto, 'platform', {
          get: () => persona.platform, enumerable: false, configurable: true
        });

        if (navigator.userAgentData) {
          const realUAD = navigator.userAgentData;
          const brands = persona.brands.map((brand, i) => ({
            brand, version: i === persona.brands.length - 1 ? '99' : major
          }));
          // P0: platformVersion was hard-coded to '10.0.0' for every OS (a
          // Windows-only string on macOS/Linux builds), the version list held
          // only majors, and `mobile` passed the real value through even when
          // the persona claims a desktop platform. All four are high-entropy
          // oracles, so derive them from the persona.
          const platformVersion = persona.platform === 'Win32' ? '10.0.0'
            : (persona.platform === 'MacIntel' ? '10.15.7' : '6.6.0');
          // P0: every brand now carries the SAME real 4-part release, and the
          // grease brand keeps the conventional '99.0.0.0' shape real Chrome
          // uses, so fullVersionList can never look like a mixed machine.
          const fullVersionList = brands.map((b) => ({
            brand: b.brand,
            version: b.version === '99' ? '99.0.0.0' : chromeVersion
          }));

          // P1 identity stability: the Proxy used to be constructed inside the
          // getter, so every read returned a NEW object and
          // `navigator.userAgentData === navigator.userAgentData` was false -
          // a one-line oracle. Build it once, exactly like navigator.plugins.
          const uadProxy = new Proxy(realUAD, {
            get (target, prop) {
              if (prop === 'brands') return brands;
              if (prop === 'mobile') return false;
              if (prop === 'platform') return persona.platform === 'MacIntel' ? 'macOS'
                : (persona.platform === 'Win32' ? 'Windows' : 'Linux');
              if (prop === 'getHighEntropyValues') {
                return (hints) => target.getHighEntropyValues(hints).then((values) => {
                  const out = Object.assign({}, values);
                  out.platformVersion = platformVersion;
                  out.fullVersionList = fullVersionList;
                  out.platform = persona.platform === 'MacIntel' ? 'macOS'
                    : (persona.platform === 'Win32' ? 'Windows' : 'Linux');
                  out.mobile = false;
                  return out;
                });
              }
              const v = Reflect.get(target, prop, target);
              return typeof v === 'function' ? v.bind(target) : v;
            }
          });
          Object.defineProperty(navProto, 'userAgentData', {
            get: () => uadProxy, enumerable: false, configurable: true
          });
        }

        log('[shapeshift][page][ua] Hooks installed, platform:', persona.platform);
      } catch (e) {
        log('[shapeshift][page][ua] Failed:', e);
      }
    }

    // ========================================================================
    // KEYBOARD + VIEWPORT HOOKS (P2 7.3)
    //
    // navigator.keyboard.getLayoutMap() resolved to the HOST keyboard layout, a
    // locale tell nothing else covered: a German layout behind an en-US user
    // agent is a one-line contradiction. The layout is chosen from the same seed
    // as every other persona, and the resolved object stays a real
    // KeyboardLayoutMap (a Proxy over the native result) so `instanceof` and the
    // whole Map surface keep working.
    //
    // visualViewport was left fully native, so a page could read the untouched
    // accessors (owner/patch-state oracle). It is re-asserted on
    // VisualViewport.prototype with the REAL values - rewriting the viewport
    // breaks every scroll-driven layout, exactly like screen.orientation.
    // ========================================================================
    if (config.enableKeyboardProtection) {
      try {
        const KEYBOARD_LAYOUTS = ['QWERTY', 'QWERTZ', 'AZERTY', 'Dvorak'];
        const layout = KEYBOARD_LAYOUTS[hashString(seed + ':kbd') % KEYBOARD_LAYOUTS.length];
        const kb = navigator.keyboard;
        if (kb && typeof kb.getLayoutMap === 'function') {
          const origGetLayoutMap = kb.getLayoutMap;
          kb.getLayoutMap = function () {
            return origGetLayoutMap.call(this).then(function (realMap) {
              // Rebuild the map from the chosen layout while keeping the native
              // prototype: a plain Object would lose `instanceof` and the Map
              // methods, which is itself a fingerprint.
              const rows = layout === 'QWERTZ'
                ? ['qwertzuiop', 'asdfghjkl', 'yxcvbnm']
                : (layout === 'AZERTY'
                  ? ['azertyuiop', 'qsdfghjklm', 'wxcvbn']
                  : (layout === 'Dvorak'
                    ? ['pyfgcrl', 'aoeuidhtns', 'qjkxbmwvz']
                    : ['qwertyuiop', 'asdfghjkl', 'zxcvbnm']));
              const codes = ['KeyQ', 'KeyW', 'KeyE', 'KeyR', 'KeyT', 'KeyY', 'KeyU', 'KeyI', 'KeyO', 'KeyP',
                'KeyA', 'KeyS', 'KeyD', 'KeyF', 'KeyG', 'KeyH', 'KeyJ', 'KeyK', 'KeyL',
                'KeyZ', 'KeyX', 'KeyC', 'KeyV', 'KeyB', 'KeyN', 'KeyM'];
              const flat = rows.join('');
              let realSet = null;
              try { realSet = new Set(realMap.values()); } catch (e) { /* ignore */ }
              const shadow = Object.create(Object.getPrototypeOf(realMap));
              const pairs = new Map();
              for (let i = 0; i < codes.length && i < flat.length; i++) {
                // The native map's own value wins when it already reports this
                // code, so real keyboards are only ever relabelled on top.
                pairs.set(codes[i], flat[i]);
              }
              if (realSet) {
                realMap.forEach(function (value, code) {
                  if (!pairs.has(code)) pairs.set(code, value);
                });
              }
              const proxy = new Proxy(shadow, {
                get (target, prop) {
                  if (prop === 'get') return (code) => pairs.get(code);
                  if (prop === 'has') return (code) => pairs.has(code);
                  if (prop === 'size') return pairs.size;
                  if (prop === 'keys') return () => pairs.keys();
                  if (prop === 'values') return () => pairs.values();
                  if (prop === 'entries') return () => pairs.entries();
                  if (prop === Symbol.iterator) return () => pairs.entries();
                  const v = Reflect.get(target, prop, target);
                  return typeof v === 'function' ? v.bind(target) : v;
                }
              });
              // Preserve the native prototype chain for instanceof checks.
              try { Object.setPrototypeOf(proxy, Object.getPrototypeOf(realMap)); } catch (e) { /* ignore */ }
              return proxy;
            });
          };
        }

        const viewport = window.visualViewport;
        const VisualViewportCtor = window.VisualViewport;
        if (viewport && VisualViewportCtor && VisualViewportCtor.prototype) {
          for (const prop of ['width', 'height', 'offsetLeft', 'offsetTop', 'pageLeft', 'pageTop', 'scale']) {
            const desc = Object.getOwnPropertyDescriptor(VisualViewportCtor.prototype, prop);
            if (!desc || typeof desc.get !== 'function') continue;
            Object.defineProperty(VisualViewportCtor.prototype, prop, {
              get: function () { return desc.get.call(this); },
              enumerable: false,
              configurable: true
            });
          }
        }

        log('[shapeshift][page][kbd] Hooks installed, layout:', layout);
      } catch (e) {
        log('[shapeshift][page][kbd] Failed:', e);
      }
    }

    // ========================================================================
    // WORKER + CSS-LEVEL FINGERPRINTING (P2 7.3)
    //
    // Two surfaces were still fully native:
    //  1. worker realms (Worker, SharedWorker and the AudioWorklet global
    //     scope) each start from the untouched host values, so a page could
    //     compare its spoofed persona against the original a worker reports;
    //  2. CSS-level probes - @media (prefers-*) and CSS.supports() are answered
    //     by the style engine, not by the JS matchMedia shim, so a stylesheet
    //     or a single CSS.supports() call bypassed every JS hook.
    // Both answer from the same seed as every other surface: one profile per
    // load, derived with hashString, never a streaming PRNG.
    // ========================================================================
    if (config.enableDetectionResistance) {
      try {
        // --- worker realms -------------------------------------------------
        const WORKER_GLOBALS = ['Worker', 'SharedWorker'];
        // P1 (world split): this used its own ':worker:cpu' / ':worker:mem'
        // streams, so a page that spawned a worker and compared the two realms
        // saw a different core count and memory class - the exact
        // contradiction the shim exists to remove. Repeat the values the page
        // hook already derived; reading navigator.hardwareConcurrency here
        // would re-fuzz an already-spoofed getter and diverge the other way.
        const navCfgForWorker = config.navigator || {};
        const workerPersona = {
          hardwareConcurrency: navCfgForWorker.fuzzHardwareConcurrency !== false && ssNavCores !== null
            ? ssNavCores
            : (navigator.hardwareConcurrency || 4),
          deviceMemory: navCfgForWorker.fuzzDeviceMemory !== false && ssNavMemory !== null
            ? ssNavMemory
            : (navigator.deviceMemory || 8),
          platform: navigator.platform
        };
        // Built once per load and prepended to every worker script, so a worker
        // realm re-reads the same persona the page world reports. importScripts
        // is the only way in - the extension ships no network API and the
        // original script is loaded by the worker itself, not fetched here.
        const WORKER_SHIM = [
          '(function(){',
          '  var P=' + JSON.stringify(workerPersona) + ';',
          '  try{Object.defineProperty(navigator,"hardwareConcurrency",{get:function(){return P.hardwareConcurrency;},configurable:true});}catch(e){}',
          '  try{Object.defineProperty(navigator,"deviceMemory",{get:function(){return P.deviceMemory;},configurable:true});}catch(e){}',
          '  try{Object.defineProperty(navigator,"platform",{get:function(){return P.platform;},configurable:true});}catch(e){}',
          '})();'
        ].join(String.fromCharCode(10));
        const blobUrlFor = (url) => {
          const bootstrap = 'importScripts(' + JSON.stringify(String(url)) + ');' +
            String.fromCharCode(10) + WORKER_SHIM;
          return URL.createObjectURL(new Blob([bootstrap], { type: 'text/javascript' }));
        };
        for (let i = 0; i < WORKER_GLOBALS.length; i++) {
          const name = WORKER_GLOBALS[i];
          const Orig = window[name];
          if (typeof Orig !== 'function') continue;
          const Wrapped = function (url, options) {
            // Module workers (`{ type: 'module' }`) cannot call importScripts -
            // the bootstrap would throw and the worker would never start, so a
            // site using module workers lost the feature entirely. Pass those
            // through untouched instead of breaking them.
            const isModule = !!(options && options.type === 'module');
            let target = url;
            if (!isModule) {
              try { target = blobUrlFor(url); } catch (e) { target = url; }
            }
            return new Orig(target, options);
          };
          try {
            Object.setPrototypeOf(Wrapped, Orig);
            Wrapped.prototype = Orig.prototype;
          } catch (e) { /* keep the plain wrapper */ }
          try {
            Object.defineProperty(window, name, {
              value: Wrapped, enumerable: false, configurable: true, writable: true
            });
          } catch (e) { /* leave the native constructor in place */ }
        }
        // P1 (worklet clock): this block used to redefine
        // AudioWorkletGlobalScope.prototype.currentTime as `this.__ssTime || 0`.
        // currentTime is the audio clock a processor schedules against, not a
        // fingerprint - pinning it to 0 froze every time-driven processor, and
        // the `__ssTime` own property was itself an oracle. An
        // AudioWorkletGlobalScope has no navigator, so there is no page persona
        // to repeat there either: the realm keeps its native clock.
        const AudioWorkletCtor = window.AudioWorkletNode;
        if (AudioWorkletCtor && navigator.audioWorklet) {
          log('[shapeshift][page][worker] AudioWorklet realm left on its native clock');
        }

        // --- CSS-level probes ---------------------------------------------
        const CSS_MEDIA_PROFILES = [
          ['prefers-color-scheme: dark', hashString(seed + ':css:scheme') % 2 === 0],
          ['prefers-reduced-motion: reduce', hashString(seed + ':css:motion') % 4 === 0],
          ['prefers-contrast: more', hashString(seed + ':css:contrast') % 8 === 0],
          ['prefers-reduced-transparency: reduce', hashString(seed + ':css:transparency') % 8 === 0]
        ];
        const cssAnswer = (query) => {
          const lower = String(query).toLowerCase();
          for (let i = 0; i < CSS_MEDIA_PROFILES.length; i++) {
            if (lower.indexOf(CSS_MEDIA_PROFILES[i][0]) !== -1) return CSS_MEDIA_PROFILES[i][1];
          }
          return null;
        };
        if (window.CSS && typeof CSS.supports === 'function') {
          const origSupports = CSS.supports;
          CSS.supports = function (a, b) {
            const probe = b === undefined ? a : (String(a) + ':' + String(b));
            const answer = cssAnswer(probe);
            if (answer !== null) return answer;
            return origSupports.apply(this, arguments);
          };
        }
        const priorMatchMedia = window.matchMedia;
        window.matchMedia = function (query) {
          const result = priorMatchMedia.call(this, query);
          const answer = cssAnswer(query);
          if (answer === null) return result;
          // P2 4.4 (listener oracle): addEventListener was forwarded to the
          // REAL MediaQueryList, so a handler fired with `event.target` and
          // `this` equal to the real list - reading `e.target.matches` there
          // returned the un-spoofed value and defeated the shim. Each callback
          // is wrapped so the event it observes carries this proxy as
          // target/currentTarget and the spoofed `matches`; removal is mapped
          // back to the original reference so removeEventListener still works.
          const listenerMap = new WeakMap();
          let proxy = null;
          const wrapListener = (listener) => {
            if (typeof listener !== 'function') return listener;
            let wrapped = listenerMap.get(listener);
            if (wrapped) return wrapped;
            wrapped = function (event) {
              let seen = event;
              try {
                seen = new Proxy(event, {
                  get (t, prop) {
                    if (prop === 'target' || prop === 'currentTarget') return proxy;
                    if (prop === 'matches') return answer;
                    const v = t[prop];
                    return typeof v === 'function' ? v.bind(t) : v;
                  }
                });
              } catch (err) { seen = event; }
              return listener.call(proxy, seen);
            };
            listenerMap.set(listener, wrapped);
            return wrapped;
          };
          proxy = new Proxy(result, {
            get (target, prop) {
              if (prop === 'matches') return answer;
              if (prop === 'addEventListener' || prop === 'addListener') {
                return function (listener, rest) {
                  return target[prop](wrapListener(listener), rest);
                };
              }
              if (prop === 'removeEventListener' || prop === 'removeListener') {
                return function (listener, rest) {
                  return target[prop](listenerMap.get(listener) || listener, rest);
                };
              }
              const v = target[prop];
              return typeof v === 'function' ? v.bind(target) : v;
            }
          });
          // Same argument as the touch block above: without an own `matches`, a
          // listener receives the real list as event.target and can read the
          // un-spoofed value back out of it.
          try {
            Object.defineProperty(proxy, 'matches', { value: answer, configurable: true });
          } catch (e) { /* non-extensible MediaQueryList; the get trap still wins */ }
          return proxy;
        };

        log('[shapeshift][page][css] Worker + CSS hooks installed');
      } catch (e) {
        log('[shapeshift][page][css] Failed:', e);
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
            // P2 4.4: the ISOLATED canPlayType hook incremented mediaCodecReads,
            // but the page only ever calls this MAIN-world copy, so the counter
            // stayed at zero for a real read. Report it over the SS_STAT bridge.
            bumpStat('mediaCodecReads');
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
            bumpStat('mediaCodecReads');
            const result = origIsTypeSupported.call(this, type);
            // P0: flipping a supported codec to unsupported made the player pick
            // a codec the machine cannot actually decode, so playback failed.
            // Only ever claim an UNSUPPORTED format is supported, and only for
            // a narrow deterministic slice, so the page still finds a playable
            // codec.
            const nonCritical = ['av01', 'vp9', 'opus'];
            if (result === false &&
                nonCritical.some((c) => String(type).includes(c)) &&
                roll('mstype', type) < 0.05) {
              return true;
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
                // P0: never mutate the object the UA returned - it may be a
                // cached/shared instance, so writing into it leaked the change
                // to later callers. Copy first, then flip.
                return Object.assign({}, info, { powerEfficient: !info.powerEfficient });
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

        // P2: MediaRecorder.isTypeSupported was never owned by MAIN, so the
        // page could read the real recorder codec list. Upgrade-only, exactly
        // like MediaSource.isTypeSupported: never claim a working codec is
        // missing, or recording breaks.
        if (window.MediaRecorder && window.MediaRecorder.isTypeSupported) {
          const origRecorderSupported = window.MediaRecorder.isTypeSupported;
          window.MediaRecorder.isTypeSupported = function (type) {
            bumpStat('mediaCodecReads');
            const result = origRecorderSupported.call(this, type);
            if (result === false &&
                /(opus|vp8|vp9|av01|mp4a)/i.test(String(type)) &&
                roll('rectype', type) < 0.05) {
              return true;
            }
            return result;
          };
        }

        // P2 4.4: the EME probe was hooked only in the ISOLATED world, where the
        // page cannot see it - the real navigator.requestMediaKeySystemAccess
        // stayed readable and drmReads never moved for a page-initiated call.
        // Behaviour is deliberately unchanged (rewriting DRM breaks playback);
        // this only makes the read observable and counted.
        if (navigator.requestMediaKeySystemAccess) {
          const origRequestMediaKeySystemAccess = navigator.requestMediaKeySystemAccess;
          const emeTarget = navProto || navigator;
          Object.defineProperty(emeTarget, 'requestMediaKeySystemAccess', {
            value: function (keySystem, supportedConfigurations) {
              bumpStat('drmReads');
              return origRequestMediaKeySystemAccess.call(this, keySystem, supportedConfigurations);
            },
            writable: true,
            enumerable: false,
            configurable: true
          });
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
            latitude: { get: () => shifted.latitude, enumerable: false, configurable: true },
            longitude: { get: () => shifted.longitude, enumerable: false, configurable: true },
            accuracy: { get: () => real.accuracy, enumerable: false, configurable: true },
            altitude: { get: () => real.altitude, enumerable: false, configurable: true },
            altitudeAccuracy: { get: () => real.altitudeAccuracy, enumerable: false, configurable: true },
            heading: { get: () => real.heading, enumerable: false, configurable: true },
            speed: { get: () => real.speed, enumerable: false, configurable: true }
          });
          const copy = Object.create(Object.getPrototypeOf(position));
          Object.defineProperties(copy, {
            coords: { get: () => coords, enumerable: false, configurable: true },
            timestamp: { get: () => position.timestamp, enumerable: false, configurable: true }
          });
          return copy;
        }

        navigator.geolocation.getCurrentPosition = function (success, error, options) {
          // P2 (4.4): geolocationReads was declared in stats_tracker.js and
          // summed by service-worker.js, but no hook ever incremented it, so
          // the counter was permanently 0. Report the read from the MAIN world
          // over the same SS_STAT channel the other MAIN hooks use.
          bumpStat('geolocationReads');
          if (typeof success !== 'function') {
            return origGetCurrentPosition.call(this, success, error, options);
          }
          return origGetCurrentPosition.call(this, function (position) {
            return success(fuzzPosition(position));
          }, error, options);
        };

        if (typeof origWatchPosition === 'function') {
          navigator.geolocation.watchPosition = function (success, error, options) {
            bumpStat('geolocationReads');
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
        Object.defineProperty(navProto, 'webdriver', {
          get: () => false, enumerable: false, configurable: true
        });

        // P1 4.1: performance.getEntriesByType was ISOLATED-only, so the page
        // could read the untouched native list (owner/patch-state oracle) and
        // the surface was unprotected in MAIN. Re-assert it here with the same
        // timing resistance the ISOLATED installer applies.
        if (window.performance && performance.getEntriesByType) {
          const origGetEntriesByType = performance.getEntriesByType;
          performance.getEntriesByType = function (type) {
            if (globalThis.ssTimingUtils) {
              globalThis.ssTimingUtils.randomDelaySync();
            }
            return origGetEntriesByType.call(this, type);
          };
        }

        if (navigator.permissions && navigator.permissions.query) {
          const origQuery = navigator.permissions.query;
          navigator.permissions.query = function (params) {
            return origQuery.call(this, params).then((status) => {
              if (params && params.name === 'notifications') {
                // P1: reading `Notification.permission` in an unguarded branch
                // threw ReferenceError wherever `Notification` is not defined
                // (workers, some embedded contexts), which rejected the whole
                // permissions.query() promise with no handler attached. Fall
                // back to the native status when the API is absent.
                const notifPermission = (typeof Notification !== 'undefined' && Notification)
                  ? Notification.permission
                  : status.state;
                return new Proxy(status, {
                  get (t, prop) {
                    if (prop === 'state') return notifPermission;
                    const v = Reflect.get(t, prop, t);
                    return typeof v === 'function' ? v.bind(t) : v;
                  }
                });
              }
              return status;
            });
          };
        }
        // P0: storage.estimate and queryUsageAndQuota were ISOLATED-only, so
        // the page could still read the restricted incognito quota. Normalize
        // them here, keyed on (seed, input) so two reads agree.
        if (navigator.storage && navigator.storage.estimate) {
          const origEstimate = navigator.storage.estimate;
          navigator.storage.estimate = function () {
            return origEstimate.call(this).then(function (estimate) {
              const out = Object.assign({}, estimate);
              if (out.quota && out.quota < 1024 * 1024 * 1024) {
                out.quota = 10 * 1024 * 1024 * 1024 +
                  (hashString(seed + ':quota:granted:' + out.quota) % (1024 * 1024 * 1024));
              }
              if (out.usage !== undefined) {
                out.usage += hashString(seed + ':quota:usage:' + out.usage) % (100 * 1024 * 1024);
              }
              return out;
            });
          };
        }

        if (navigator.webkitTemporaryStorage &&
            navigator.webkitTemporaryStorage.queryUsageAndQuota) {
          const origQuota = navigator.webkitTemporaryStorage.queryUsageAndQuota;
          navigator.webkitTemporaryStorage.queryUsageAndQuota = function (success, error) {
            if (typeof success !== 'function') return origQuota.apply(this, arguments);
            return origQuota.call(this, function (used, granted) {
              const normalizedGranted = Math.max(granted, 1024 * 1024 * 1024);
              const normalizedUsed = used + (hashString(seed + ':quota:used:' + used) % (1024 * 1024));
              return success(normalizedUsed, normalizedGranted);
            }, error);
          };
        }

        // document.hidden / visibilityState were ISOLATED-only, which meant the
        // page could read the untouched native descriptors (owner/patch-state
        // oracle). Re-assert them here so MAIN is the single owner, but keep the
        // REAL values: rewriting them breaks every visibility-driven app. The
        // shadows are non-enumerable and configurable, exactly like the native
        // accessors they replace.
        const hiddenDesc = Object.getOwnPropertyDescriptor(Document.prototype, 'hidden');
        if (hiddenDesc && hiddenDesc.get) {
          Object.defineProperty(Document.prototype, 'hidden', {
            get: function () { return hiddenDesc.get.call(this); },
            enumerable: false,
            configurable: true
          });
        }
        const visibilityDesc = Object.getOwnPropertyDescriptor(Document.prototype, 'visibilityState');
        if (visibilityDesc && visibilityDesc.get) {
          Object.defineProperty(Document.prototype, 'visibilityState', {
            get: function () { return visibilityDesc.get.call(this); },
            enumerable: false,
            configurable: true
          });
        }

        log('[shapeshift][page][detection] Hooks installed');
      } catch (e) {
        log('[shapeshift][page][detection] Failed:', e);
      }
    }

    // ========================================================================
    // P2: PATCH DETECTION - Function.prototype.toString.
    //
    // Every hook above replaced a native method with a JS closure. The default
    // toString() prints that closure's source, so one call to
    // `navigator.mediaDevices.enumerateDevices.toString()` reveals both the
    // shim and its logic. Real native methods print
    // `function X() { [native code] }`. Answer that string for the functions
    // actually replaced here, and only those, so unrelated page functions and
    // the page's own wrappers are untouched.
    // ========================================================================
    try {
      const nativeFns = new WeakSet();
      // P2 5.3 (toString prefix): an accessor's getter/setter is a function too,
      // and a page can read it with
      // `Object.getOwnPropertyDescriptor(Navigator.prototype, 'userAgent').get`
      // then call `.toString()` on it. Those functions were not registered, so
      // they printed the hook closure's source instead of `[native code]`, and
      // the plain-method branch below would have dropped the `get `/`set `
      // keyword that V8 prints for accessors (`get userAgent() { [native code] }`).
      // Track the prefix per function so accessor shims stay indistinguishable.
      const nativeLabels = new WeakMap();
      const registerNative = (obj, key) => {
        try {
          if (obj && typeof obj[key] === 'function') nativeFns.add(obj[key]);
        } catch (e) { /* ignore */ }
      };
      // Register every patched accessor on a prototype, preserving the `get `/`set `
      // prefix and the real property name so toString() matches native output.
      const registerAccessors = (obj, keys) => {
        if (!obj) return;
        for (const key of keys) {
          try {
            const desc = Object.getOwnPropertyDescriptor(obj, key);
            if (!desc) continue;
            if (typeof desc.get === 'function') {
              nativeFns.add(desc.get);
              nativeLabels.set(desc.get, 'get ' + key);
            }
            if (typeof desc.set === 'function') {
              nativeFns.add(desc.set);
              nativeLabels.set(desc.set, 'set ' + key);
            }
          } catch (e) { /* ignore */ }
        }
      };

      registerNative(window.CanvasRenderingContext2D && CanvasRenderingContext2D.prototype, 'getImageData');
      registerNative(window.CanvasRenderingContext2D && CanvasRenderingContext2D.prototype, 'measureText');
      registerNative(window.HTMLCanvasElement && HTMLCanvasElement.prototype, 'toDataURL');
      registerNative(window.HTMLCanvasElement && HTMLCanvasElement.prototype, 'toBlob');
      registerNative(window.AudioBuffer && AudioBuffer.prototype, 'getChannelData');
      registerNative(window.HTMLMediaElement && HTMLMediaElement.prototype, 'canPlayType');
      registerNative(window.MediaSource, 'isTypeSupported');
      registerNative(window.MediaRecorder, 'isTypeSupported');
      registerNative(window.AnalyserNode && window.AnalyserNode.prototype, 'getFloatFrequencyData');
      registerNative(window.AnalyserNode && window.AnalyserNode.prototype, 'getByteFrequencyData');
      registerNative(window.OffscreenCanvasRenderingContext2D &&
        window.OffscreenCanvasRenderingContext2D.prototype, 'getImageData');
      registerNative(navigator.mediaDevices, 'enumerateDevices');
      registerNative(navigator.storage, 'estimate');
      registerNative(navigator.permissions, 'query');
      registerNative(window, 'matchMedia');
      registerNative(window.RTCPeerConnection && window.RTCPeerConnection.prototype, 'setLocalDescription');
      registerNative(window.WebGLRenderingContext && WebGLRenderingContext.prototype, 'getParameter');
      registerNative(window.WebGL2RenderingContext && WebGL2RenderingContext.prototype, 'getParameter');
      registerNative(window.WebGLRenderingContext && WebGLRenderingContext.prototype, 'getShaderPrecisionFormat');
      registerNative(window.WebGL2RenderingContext && WebGL2RenderingContext.prototype, 'getShaderPrecisionFormat');
      registerNative(window.WebGLRenderingContext && WebGLRenderingContext.prototype, 'getSupportedExtensions');
      registerNative(window.WebGL2RenderingContext && WebGL2RenderingContext.prototype, 'getSupportedExtensions');

      // Accessor shims installed on Navigator.prototype by the blocks above.
      // Every name here is a data property on a real Chrome navigator whose
      // value this extension replaces, so a page probing any of them must see
      // the native-looking accessor source.
      registerAccessors(navProto, [
        'hardwareConcurrency', 'deviceMemory', 'plugins', 'mimeTypes',
        'maxTouchPoints', 'userAgent', 'appVersion', 'platform',
        'userAgentData', 'webdriver'
      ]);
      registerAccessors(Object.getPrototypeOf(window.screen) || window.screen, [
        'width', 'height', 'availWidth', 'availHeight', 'colorDepth', 'pixelDepth',
        // P2 5.3 (toString prefix): availLeft/availTop are patched by the screen
        // block above through the same defineGetter helper, so they are accessor
        // shims too. Leaving them out made
        // `Object.getOwnPropertyDescriptor(Screen.prototype, 'availLeft').get`
        // print the hook closure instead of `get availLeft() { [native code] }`,
        // which is a one-line oracle for exactly the two fields the extension
        // pins to 0.
        'availLeft', 'availTop'
      ]);
      // devicePixelRatio is an own accessor of the WINDOW object natively (real
      // Chrome keeps it on the global, not on Screen.prototype), so it is
      // registered on the same object the screen block patched.
      registerAccessors(window, ['devicePixelRatio']);
      // The screen.orientation block re-defines `type` and `angle` on
      // ScreenOrientation.prototype, so those replacements are accessor shims
      // too and must answer the native `get type() { [native code] }` shape.
      registerAccessors(window.ScreenOrientation && window.ScreenOrientation.prototype,
        ['type', 'angle']);
      // P2 5.3 (toString prefix, second pass): the blocks above also replace
      // accessors OUTSIDE Navigator/Screen - the WebGPU adapter info getter,
      // every VisualViewport metric, the performance.memory and connection
      // getters, and document.hidden/visibilityState. Each of those printed the
      // hook closure when a page read `.get.toString()` off the descriptor, so
      // they are registered on the same object the block patched.
      registerAccessors(window.GPUAdapter && window.GPUAdapter.prototype, ['info']);
      registerAccessors(window.VisualViewport && window.VisualViewport.prototype, [
        'width', 'height', 'offsetLeft', 'offsetTop', 'pageLeft', 'pageTop', 'scale'
      ]);
      registerAccessors(performance, ['memory']);
      registerAccessors(
        navigator.connection || navigator.mozConnection || navigator.webkitConnection,
        ['effectiveType', 'downlink']);
      registerAccessors(window.Document && Document.prototype,
        ['hidden', 'visibilityState']);
      // The same second pass for plain methods: these are closures too, so a
      // `.toString()` on them revealed the shim even though the values were
      // plausible.
      registerNative(navProto, 'requestMediaKeySystemAccess');
      registerNative(navigator, 'getBattery');
      registerNative(navigator, 'getGamepads');
      // P2 5.3 (toString prefix, third pass): three more page-visible methods
      // were patched above but never registered. `pc.addIceCandidate` and both
      // geolocation entry points are redefined as own functions, so
      // `.toString()` on any of them printed the hook closure - the same oracle
      // the earlier passes closed for their siblings.
      registerNative(window.RTCPeerConnection && window.RTCPeerConnection.prototype, 'addIceCandidate');
      registerNative(navigator.geolocation, 'getCurrentPosition');
      registerNative(navigator.geolocation, 'watchPosition');
      registerNative(navigator.mediaCapabilities, 'decodingInfo');
      // P2 5.3 (toString prefix, fourth pass): two more patched methods were
      // still printing their hook source. `navigator.gpu.requestAdapter` is the
      // WebGPU entry point the block above replaces, and `document.fonts.check`
      // is replaced on the FontFaceSet instance itself. Both are reachable from
      // a stable object at guard time, so both are registered here.
      registerNative(navigator.gpu, 'requestAdapter');
      registerNative(document.fonts, 'check');
      registerNative(navigator.keyboard, 'getLayoutMap');
      registerNative(navigator.webkitTemporaryStorage, 'queryUsageAndQuota');
      registerNative(window.RTCRtpSender, 'getCapabilities');
      registerNative(window.RTCRtpReceiver, 'getCapabilities');
      registerNative(performance, 'getEntriesByType');
      registerNative(Intl, 'DateTimeFormat');
      registerNative(typeof CSS !== 'undefined' ? CSS : null, 'supports');
      // P2 5.3 (toString prefix, fifth pass): three more page-visible hooks
      // still printed their closure source. The RTCPeerConnection CONSTRUCTOR
      // (not just its prototype methods), the FontFaceSet iterator that the
      // font block redefines under Symbol.iterator, and the timezone
      // `resolvedOptions` accessor that is now patched on the prototype.
      // registerNative already supports symbol keys because `obj[key]` works
      // for them too.
      registerNative(window, 'RTCPeerConnection');
      registerNative(document.fonts && Object.getPrototypeOf(document.fonts), Symbol.iterator);
      registerNative(Intl.DateTimeFormat && Intl.DateTimeFormat.prototype, 'resolvedOptions');

      const origFnToString = Function.prototype.toString;
      const nativeToString = function () {
        if (typeof this === 'function' && nativeFns.has(this)) {
          const label = nativeLabels.get(this);
          if (label) {
            const parts = label.split(' ');
            // V8 prints a setter as `set NAME(v) { [native code] }`; the
            // parameter name is not observable through toString for a native
            // accessor, so the canonical `(v)` form is used.
            if (parts[0] === 'set') return 'set ' + parts[1] + '(v) { [native code] }';
            return 'get ' + parts[1] + '() { [native code] }';
          }
          const name = this.name ? this.name : '';
          return 'function ' + name + '() { [native code] }';
        }
        return origFnToString.call(this);
      };
      nativeFns.add(nativeToString);
      try {
        // Must be non-enumerable: a plain assignment would create an own
        // enumerable property on Function.prototype itself.
        Object.defineProperty(Function.prototype, 'toString', {
          value: nativeToString, enumerable: false, configurable: true, writable: true
        });
      } catch (e) { /* ignore */ }

      log('[shapeshift][page][stealth] toString guard installed');
    } catch (e) {
      log('[shapeshift][page][stealth] Failed:', e);
    }

    log('[shapeshift][page] All hooks installed successfully');
  }); // NOTE: deliberately NOT `{ once: true }`. The ISOLATED bootstrap sends
      // SS_PAGE_WORLD_HELLO first, and this listener consumes it before
      // returning; a once-listener would be removed at that point, so the later
      // SS_INIT_PAGE_HOOKS post would have no receiver and every MAIN-world hook
      // would stay uninstalled. Re-init is prevented by the ssInitialized latch
      // above instead. verify.mjs enforces this (no `once: true` on this listener).

  // Re-announce readiness (with the nonce) once all hooks are installed. The
  // first announcement already ran synchronously at document_start; this second
  // one covers the case where the ISOLATED bootstrap registered its listener
  // only after that turn.
  announceReady();
})();
