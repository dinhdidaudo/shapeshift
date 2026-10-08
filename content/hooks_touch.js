// Touch capability and pointer detection protection.
// Protects against touch screen detection and pointer type fingerprinting.
(function () {
  const installers = (globalThis.ssHookInstallers = globalThis.ssHookInstallers || []);

  installers.push(function installTouchHooks (env) {
    if (!env || !env.config?.enableTouchProtection) return;
    const { prng, config } = env;
    const debug = config.debug ? true : false;
    const log = debug ? console.log : () => {};

    function safeWrap (fn) {
      try {
        fn();
      } catch (e) {
        if (debug) console.error('[shapeshift][touch] Hook failed:', e);
      }
    }

    // Touch capability variations
    // Most common: 0 (desktop), 1 (some devices), 5 (mobile), 10 (tablets)
    const touchCapabilities = [0, 0, 0, 0, 1, 5, 10]; // Weighted toward 0 (desktop)
    const spoofedMaxTouchPoints = touchCapabilities[Math.floor(prng() * touchCapabilities.length)];

    log(`[shapeshift][touch] Spoofed maxTouchPoints: ${spoofedMaxTouchPoints}`);

    // Hook navigator.maxTouchPoints
    safeWrap(() => {
      try {
        Object.defineProperty(navigator, 'maxTouchPoints', {
          get: function() {
            // Track statistics
            if (globalThis.ssStatsTracker) {
              globalThis.ssStatsTracker.increment('touchReads');
            }

            if (globalThis.ssTimingUtils) {
              globalThis.ssTimingUtils.randomDelaySync();
            }
            return spoofedMaxTouchPoints;
          },
          enumerable: true,
          configurable: true
        });
        log('[shapeshift][touch] maxTouchPoints hooked');
      } catch (e) {
        // May fail if property is non-configurable
        if (debug) console.error('[shapeshift][touch] Failed to hook maxTouchPoints:', e);
      }
    });

    // Hook ontouchstart detection (common fingerprinting technique)
    safeWrap(() => {
      const shouldHaveTouch = spoofedMaxTouchPoints > 0;

      // If we're spoofing as a touch device, ensure touch events exist
      // If we're spoofing as non-touch, this is already handled by maxTouchPoints
      if (shouldHaveTouch && !('ontouchstart' in window)) {
        try {
          window.ontouchstart = null;
          document.ontouchstart = null;
          log('[shapeshift][touch] Added ontouchstart support');
        } catch (e) {
          // May fail on some browsers
        }
      }
    });

    // Hook pointer events (CSS media query detection)
    // Note: Can't override CSS media queries, but we can hook the matchMedia API
    safeWrap(() => {
      const origMatchMedia = window.matchMedia;
      if (!origMatchMedia) return;

      if (globalThis.ssStealth && !globalThis.ssStealth.isPatched(origMatchMedia)) {
        globalThis.ssStealth.markPatched(origMatchMedia);

        window.matchMedia = function(query) {
          const result = origMatchMedia.call(this, query);

          // Modify pointer-related media queries
          const lowerQuery = query.toLowerCase();

          if (lowerQuery.includes('pointer') || lowerQuery.includes('hover')) {
            if (globalThis.ssTimingUtils) {
              globalThis.ssTimingUtils.randomDelaySync();
            }

            // Create a proxy for the MediaQueryList
            const shouldHaveTouch = spoofedMaxTouchPoints > 0;

            // (pointer: coarse) = touch device
            // (pointer: fine) = mouse/stylus
            // (hover: none) = touch device
            // (hover: hover) = mouse

            const handler = {
              get(target, prop) {
                if (prop === 'matches') {
                  if (lowerQuery.includes('pointer:') && lowerQuery.includes('coarse')) {
                    // Touch device query
                    return shouldHaveTouch;
                  } else if (lowerQuery.includes('pointer:') && lowerQuery.includes('fine')) {
                    // Mouse/precise pointer query
                    return !shouldHaveTouch;
                  } else if (lowerQuery.includes('hover:') && lowerQuery.includes('none')) {
                    // No hover capability (touch)
                    return shouldHaveTouch;
                  } else if (lowerQuery.includes('hover:') && lowerQuery.includes('hover')) {
                    // Hover capability (mouse)
                    return !shouldHaveTouch;
                  }
                }
                return target[prop];
              }
            };

            return new Proxy(result, handler);
          }

          return result;
        };

        log('[shapeshift][touch] matchMedia hooked for pointer queries');
      }
    });

    // Hook PointerEvent detection
    safeWrap(() => {
      if (!window.PointerEvent) return;

      // Can't easily modify pointer events without breaking functionality
      // Just add timing resistance
      const origPointerEvent = window.PointerEvent;
      if (globalThis.ssStealth && !globalThis.ssStealth.isPatched(origPointerEvent)) {
        globalThis.ssStealth.markPatched(origPointerEvent);

        // Add event listener wrapper to add timing jitter
        const origAddEventListener = EventTarget.prototype.addEventListener;
        if (!globalThis.ssStealth.isPatched(origAddEventListener)) {
          globalThis.ssStealth.markPatched(origAddEventListener);

          EventTarget.prototype.addEventListener = function(type, listener, options) {
            if (type.startsWith('pointer') || type.startsWith('touch')) {
              if (typeof listener === 'function') {
                const wrappedListener = function(event) {
                  if (globalThis.ssTimingUtils) {
                    globalThis.ssTimingUtils.executionJitter();
                  }
                  return listener.call(this, event);
                };
                return origAddEventListener.call(this, type, wrappedListener, options);
              }
            }
            return origAddEventListener.call(this, type, listener, options);
          };

          log('[shapeshift][touch] Pointer/touch event listeners wrapped with timing jitter');
        }
      }
    });
  });
})();
