// Screen and display property protection.
// Protects screen dimensions, pixel ratio, color depth to prevent stable fingerprints.
(function () {
  const installers = (globalThis.ssHookInstallers = globalThis.ssHookInstallers || []);

  installers.push(function installScreenHooks (env) {
    if (!env || !env.config?.enableScreenProtection) return;
    // P1 (double-patch): canvas, fonts, webgl, navigator and media all guard
    // their install against a second wrap; this installer did not, so a second
    // content-script run re-wrapped every screen getter and the page could
    // count the wrappers. Guard on the object whose prototype gets patched.
    if (globalThis.ssStealth && globalThis.ssStealth.isPatched(window.screen)) return;
    if (globalThis.ssStealth) globalThis.ssStealth.markPatched(window.screen);
    // P1: every draw below used the streaming PRNG, so the advertised screen
    // changed on each load of the same origin and disagreed with the MAIN
    // world. Key each pick on (seed, field) so it is stable per origin.
    const screenSeed = (env.seed >>> 0) || 0;
    const screenRoll = (field) => {
      const h = globalThis.ssHashString;
      if (!h) return 0.5;
      return h(screenSeed + ':screen:' + field) / 4294967296;
    };
    const { config } = env;
    const debug = config.debug ? true : false;
    const log = debug ? console.log : () => {};

    function safeWrap (fn) {
      try {
        fn();
      } catch (e) {
        if (debug) console.error('[shapeshift][screen] Hook failed:', e);
      }
    }

    // Real-world screen resolution distributions
    const commonResolutions = [
      { width: 1920, height: 1080, weight: 0.35 },  // Most common
      { width: 1366, height: 768, weight: 0.15 },
      { width: 2560, height: 1440, weight: 0.12 },
      { width: 1536, height: 864, weight: 0.10 },
      { width: 1440, height: 900, weight: 0.08 },
      { width: 1600, height: 900, weight: 0.07 },
      { width: 3840, height: 2160, weight: 0.05 },  // 4K
      { width: 2880, height: 1800, weight: 0.04 },  // Retina
      { width: 1280, height: 720, weight: 0.04 }
    ];

    // Sample from distribution
    function sampleResolution() {
      const r = screenRoll('resolution');
      let cumulative = 0;
      for (const res of commonResolutions) {
        cumulative += res.weight;
        if (r < cumulative) {
          return { width: res.width, height: res.height };
        }
      }
      return { width: 1920, height: 1080 }; // Fallback
    }

    safeWrap(() => {
      const baseWidth = window.screen.width;
      const baseHeight = window.screen.height;
      const basePixelRatio = window.devicePixelRatio || 1;

      // Sample or slightly modify real resolution
      const useRealDistribution = config.screen?.useRealDistribution !== false;
      let spoofedResolution;

      if (useRealDistribution) {
        spoofedResolution = sampleResolution();
      } else {
        // Slight modification of actual resolution
        const widthOffset = Math.floor((screenRoll('widthOffset') - 0.5) * 100);
        const heightOffset = Math.floor((screenRoll('heightOffset') - 0.5) * 100);
        spoofedResolution = {
          width: Math.max(800, baseWidth + widthOffset),
          height: Math.max(600, baseHeight + heightOffset)
        };
      }

      // P1 2.10: devicePixelRatio used to be snapped to 1 or 2 purely from the
      // spoofed width, while window.innerWidth stayed real. screen.width / dpr
      // then implied a CSS viewport unrelated to the actual window, which is a
      // cheap inconsistency check. Scale the real ratio by how much the spoofed
      // screen differs from the real one so the implied CSS screen size stays
      // close to the real one.
      const realScreenWidth = baseWidth || spoofedResolution.width;
      const widthScale = realScreenWidth > 0 ? spoofedResolution.width / realScreenWidth : 1;
      const spoofedPixelRatio = Math.min(4, Math.max(1, Math.round(basePixelRatio * widthScale * 100) / 100));

      // Common color depths: 24 (most common), 30, 32
      const colorDepths = [24, 24, 24, 30, 32]; // Weighted toward 24
      const spoofedColorDepth = colorDepths[
        Math.floor(screenRoll('colorDepth') * colorDepths.length) % colorDepths.length];

      log(`[shapeshift][screen] Original: ${baseWidth}x${baseHeight}, Spoofed: ${spoofedResolution.width}x${spoofedResolution.height}`);
      log(`[shapeshift][screen] Pixel ratio: ${basePixelRatio} → ${spoofedPixelRatio}, Color depth: ${spoofedColorDepth}`);

      // Helper to define non-configurable getter
      function defineGetter(obj, prop, getter) {
        try {
          const descriptor = Object.getOwnPropertyDescriptor(obj, prop);
          if (descriptor && !descriptor.configurable) {
            log(`[shapeshift][screen] Cannot redefine non-configurable property: ${prop}`);
            return;
          }

          Object.defineProperty(obj, prop, {
            get: function() {
              // Track statistics
              if (globalThis.ssStatsTracker) {
                globalThis.ssStatsTracker.increment('screenReads');
              }

              if (globalThis.ssTimingUtils) {
                globalThis.ssTimingUtils.randomDelaySync();
                globalThis.ssTimingUtils.executionJitter();
              }
              return getter.call(this);
            },
            // Native screen getters are non-enumerable; leaving this true made
            // Object.keys(screen) return width/height/... instead of [] - a
            // one-line detector.
            enumerable: false,
            configurable: true
          });
        } catch (e) {
          log(`[shapeshift][screen] Failed to define ${prop}:`, e.message);
        }
      }

      // P1 (own-property leak): the getters below used to be defined ON the
      // screen instance, so Object.getOwnPropertyNames(screen) returned
      // width/height/availWidth/availHeight/colorDepth/pixelDepth while a real
      // Chrome screen carries all of them as accessors on Screen.prototype and
      // its own property list is empty - a one-line detector. Patch the
      // prototype, exactly like the MAIN world re-asserts screen.orientation
      // on the Orientation constructor prototype.
      const screenTarget = Object.getPrototypeOf(window.screen) || window.screen;

      // Screen width and height
      defineGetter(screenTarget, 'width', () => spoofedResolution.width);
      defineGetter(screenTarget, 'height', () => spoofedResolution.height);

      // P1 2.10: availHeight used to be height - 40 on every platform, which is
      // wrong on macOS (no taskbar: availHeight === height) and wrong whenever
      // the real Windows taskbar is not 40px tall. Measure the real gap between
      // the screen and its work area (availHeight is still the native value at
      // this point) and scale that gap to the spoofed resolution.
      const realAvailHeight = Number(window.screen.availHeight);
      const realGap = Number.isFinite(realAvailHeight) && realAvailHeight > 0 && realAvailHeight <= baseHeight
        ? baseHeight - realAvailHeight
        : 0;
      const availOffset = realGap > 0
        ? Math.max(1, Math.round(realGap * (spoofedResolution.height / (baseHeight || spoofedResolution.height))))
        : 0;
      defineGetter(screenTarget, 'availWidth', () => spoofedResolution.width);
      defineGetter(screenTarget, 'availHeight', () => spoofedResolution.height - availOffset);

      // Color depth and pixel depth
      defineGetter(screenTarget, 'colorDepth', () => spoofedColorDepth);
      defineGetter(screenTarget, 'pixelDepth', () => spoofedColorDepth);

      // Device pixel ratio
      defineGetter(window, 'devicePixelRatio', () => spoofedPixelRatio);

      // Screen orientation (if exists)
      if (window.screen.orientation) {
        const origOrientation = window.screen.orientation.type;
        // Same own-property argument as the Screen getters above: type
        // belongs on ScreenOrientation.prototype.
        const orientationTarget = Object.getPrototypeOf(window.screen.orientation) || window.screen.orientation;
        defineGetter(orientationTarget, 'type', () => {
          // Keep original orientation but add consistency
          return origOrientation;
        });
      }

      // window.innerWidth/innerHeight are the live viewport of the actual
      // window. They were previously pinned to Math.min(real, spoofedScreen),
      // which froze responsive layouts (a resize never changed them) and made
      // the page smaller than its own viewport whenever the spoofed screen was
      // smaller than the real window. The viewport is not a fingerprinting
      // surface that needs masking, so it is deliberately left untouched.

      log('[shapeshift][screen] Screen properties hooked successfully');
    });
  });
})();
