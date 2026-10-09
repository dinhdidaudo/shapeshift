// Font fingerprinting protection.
// Protects against font enumeration and canvas font measurement techniques.
(function () {
  const installers = (globalThis.ssHookInstallers = globalThis.ssHookInstallers || []);

  installers.push(function installFontHooks (env) {
    if (!env || !env.config?.enableFontProtection) return;
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

          // P0: this used a streaming PRNG, so two measureText() calls for the
          // same string returned different widths - a one-line detector, and it
          // disagreed with the MAIN world (which keys on seed). Key on
          // (seed, field, text) so repeat reads agree across both worlds.
          const hashString = globalThis.ssHashString;
          const fontSeed = (env.seed >>> 0) || 0;
          const fieldNoise = (field, input, scale) => {
            if (!hashString) return noise(scale);
            const h = hashString(fontSeed + ':font:' + field + ':' + String(input));
            return ((h / 4294967296) - 0.5) * scale;
          };

          // P1 2.8: TextMetrics exposes different fields per engine, so some
          // of these may be undefined; `undefined + noise(...)` produced NaN
          // and a NaN width breaks layout. Only perturb real, finite numbers.
          const nn = (value, scale, field) => (
            typeof value === 'number' && isFinite(value)
              ? value + fieldNoise(field, text, scale)
              : value
          );

          const noisedValues = {
            width: nn(metrics.width, metrics.width * noiseFactor, 'w'),
            actualBoundingBoxLeft: nn(metrics.actualBoundingBoxLeft, noiseFactor, 'abl'),
            actualBoundingBoxRight: nn(metrics.actualBoundingBoxRight, noiseFactor, 'abr'),
            actualBoundingBoxAscent: nn(metrics.actualBoundingBoxAscent, noiseFactor, 'aba'),
            actualBoundingBoxDescent: nn(metrics.actualBoundingBoxDescent, noiseFactor, 'abd'),
            fontBoundingBoxAscent: nn(metrics.fontBoundingBoxAscent, noiseFactor, 'fba'),
            fontBoundingBoxDescent: nn(metrics.fontBoundingBoxDescent, noiseFactor, 'fbd'),
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
                enumerable: false,
                configurable: true,
                writable: false
              });
            } catch (e) {
              noisedMetrics[key] = noisedValues[key];
            }
          }

          // P0: text may be null/undefined; substring() on it threw TypeError.
          log('[shapeshift][fonts] measureText noised:', String(text).slice(0, 20));
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
          // P0: must include the seed, or this world and the MAIN world give
          // different answers for the same font, which is itself a signal.
          if (result === false && globalThis.ssHashString) {
            const fontSeed = (env.seed >>> 0) || 0;
            const flip = (globalThis.ssHashString(fontSeed + ':fontcheck:' + String(font) + String(text || '')) % 10) === 0;
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

      // P1: this used the streaming PRNG, so the font list order changed on
      // every document that installed the hook. A stable order per origin is
      // what a real FontFaceSet looks like; key the permutation on the seed.
      const fontSeed = (env.seed >>> 0) || 0;
      const shuffledFonts = fontArray.slice();
      for (let i = shuffledFonts.length - 1; i > 0; i--) {
        const j = globalThis.ssHashString
          ? globalThis.ssHashString(fontSeed + ':fontorder:' + i) % (i + 1)
          : i;
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
