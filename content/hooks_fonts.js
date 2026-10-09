// Font fingerprinting protection.
// Protects against font enumeration and canvas font measurement techniques.
(function () {
  const installers = (globalThis.ssHookInstallers = globalThis.ssHookInstallers || []);

  installers.push(function installFontHooks (env) {
    if (!env || !env.config?.enableFontProtection) return;
    const prng = env.prngFor ? env.prngFor('fonts') : env.prng;
    const { noise, config } = env;
    const debug = config.debug ? true : false;
    const log = debug ? console.log : () => {};

    function safeWrap (fn) {
      try {
        fn();
      } catch (e) {
        if (debug) console.error('[shapeshift][fonts] Hook failed:', e);
      }
    }

    // Hook canvas text measurement (used for font fingerprinting)
    safeWrap(() => {
      const CanvasProto = CanvasRenderingContext2D.prototype;
      if (!CanvasProto.measureText) return;

      const origMeasureText = CanvasProto.measureText;
      if (globalThis.ssStealth && !globalThis.ssStealth.isPatched(origMeasureText)) {
        globalThis.ssStealth.markPatched(origMeasureText);

        CanvasProto.measureText = function (text) {
          // Track statistics
          if (globalThis.ssStatsTracker) {
            globalThis.ssStatsTracker.increment('fontReads');
          }

          if (globalThis.ssTimingUtils) {
            globalThis.ssTimingUtils.randomDelaySync();
            globalThis.ssTimingUtils.executionJitter();
          }

          const metrics = origMeasureText.call(this, text);

          // Add slight noise to all metrics. Returning a plain object here is
          // detectable: `measureText(t) instanceof TextMetrics` must stay true
          // and the native prototype must be preserved. TextMetrics is not
          // constructible, so build an object that inherits from its prototype
          // and define the fields as own properties instead.
          const noiseFactor = 0.01; // 1% variation

          // P1 2.8: TextMetrics exposes different fields per engine, so some
          // of these may be undefined; `undefined + noise(...)` produced NaN
          // and a NaN width breaks layout. Only perturb real, finite numbers.
          const nn = (value, scale) => (
            typeof value === 'number' && isFinite(value) ? value + noise(scale) : value
          );

          const noisedValues = {
            width: nn(metrics.width, metrics.width * noiseFactor),
            actualBoundingBoxLeft: nn(metrics.actualBoundingBoxLeft, noiseFactor),
            actualBoundingBoxRight: nn(metrics.actualBoundingBoxRight, noiseFactor),
            actualBoundingBoxAscent: nn(metrics.actualBoundingBoxAscent, noiseFactor),
            actualBoundingBoxDescent: nn(metrics.actualBoundingBoxDescent, noiseFactor),
            fontBoundingBoxAscent: nn(metrics.fontBoundingBoxAscent, noiseFactor),
            fontBoundingBoxDescent: nn(metrics.fontBoundingBoxDescent, noiseFactor),
            alphabeticBaseline: metrics.alphabeticBaseline,
            hangingBaseline: metrics.hangingBaseline,
            ideographicBaseline: metrics.ideographicBaseline,
            emHeightAscent: metrics.emHeightAscent,
            emHeightDescent: metrics.emHeightDescent
          };

          let noisedMetrics;
          try {
            noisedMetrics = Object.create(TextMetrics.prototype);
          } catch (e) {
            noisedMetrics = {};
          }
          for (const key in noisedValues) {
            try {
              Object.defineProperty(noisedMetrics, key, {
                value: noisedValues[key],
                enumerable: true,
                configurable: true,
                writable: false
              });
            } catch (e) {
              noisedMetrics[key] = noisedValues[key];
            }
          }

          log('[shapeshift][fonts] measureText noised:', text.substring(0, 20));
          return noisedMetrics;
        };

        log('[shapeshift][fonts] measureText hooked');
      }
    });

    // Hook FontFaceSet.check() to prevent font enumeration
    safeWrap(() => {
      if (!document.fonts || !document.fonts.check) return;

      const origCheck = document.fonts.check;
      if (globalThis.ssStealth && !globalThis.ssStealth.isPatched(origCheck)) {
        globalThis.ssStealth.markPatched(origCheck);

        document.fonts.check = function (font, text) {
          if (globalThis.ssTimingUtils) {
            globalThis.ssTimingUtils.randomDelaySync();
            globalThis.ssTimingUtils.executionJitter();
          }

          // Call original but perturb the result to prevent font enumeration.
          // Must be deterministic for a given font string: a fresh PRNG draw
          // per call made check() return different answers for the same font
          // on every read, which is itself a strong fingerprinting signal.
          const result = origCheck.call(this, font, text);

          // P1 2.7: only ever upgrade "absent" to "present" for a small
          // deterministic slice of inputs, never the reverse. Hiding a font
          // that really exists makes the page fall back and renders visibly
          // wrong; claiming a missing font exists merely keeps layout on the
          // fallback. Keyed on (font, text) so repeat calls agree.
          if (result === false && globalThis.ssHashString) {
            const flip = (globalThis.ssHashString(String(font) + String(text || '')) % 10) === 0;
            if (flip) {
              log('[shapeshift][fonts] check() reported present for:', font);
              return true;
            }
          }

          return result;
        };

        log('[shapeshift][fonts] FontFaceSet.check hooked');
      }
    });

    // Hook document.fonts iteration
    safeWrap(() => {
      if (!document.fonts) return;

      const fontArray = Array.from(document.fonts);

      // Shuffle font order deterministically
      const shuffledFonts = fontArray.slice();
      for (let i = shuffledFonts.length - 1; i > 0; i--) {
        const j = Math.floor(prng() * (i + 1));
        [shuffledFonts[i], shuffledFonts[j]] = [shuffledFonts[j], shuffledFonts[i]];
      }

      // Override iterator
      try {
        Object.defineProperty(document.fonts, Symbol.iterator, {
          value: function* () {
            yield* shuffledFonts;
          },
          writable: false,
          enumerable: false,
          configurable: true
        });
        log('[shapeshift][fonts] Font iterator shuffled');
      } catch (e) {
        // May fail in some browsers
      }
    });
  });
})();
