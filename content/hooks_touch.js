// Touch capability and pointer detection protection.
// Protects against touch screen detection and pointer type fingerprinting.
(function () {
  const installers = (globalThis.ssHookInstallers = globalThis.ssHookInstallers || []);

  installers.push(function installTouchHooks (env) {
    if (!env || !env.config?.enableTouchProtection) return;
    const { config } = env;
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
    // P0: Math.floor(prng() * 7) could return 7, which is out of bounds and
    // yielded `undefined`. Use a hash modulo so the index is always in range
    // and stable for a given seed, matching the MAIN world formula.
    const touchSeed = (env.seed >>> 0) || 0;
    const touchHash = globalThis.ssHashString
      ? globalThis.ssHashString(touchSeed + ':touch')
      : touchSeed;
    const spoofedMaxTouchPoints = touchCapabilities[touchHash % touchCapabilities.length];

    log(`[shapeshift][touch] Spoofed maxTouchPoints: ${spoofedMaxTouchPoints}`);

    // Hook navigator.maxTouchPoints
    safeWrap(() => {
      try {
        // P1 5.3 (own-property leak): the accessor used to be defined on the
        // navigator INSTANCE, so Object.getOwnPropertyNames(navigator) listed
        // maxTouchPoints while real Chrome keeps every navigator field as an
        // accessor on Navigator.prototype and its own property list is empty -
        // a one-line detector. Patch the prototype instead, which is also what
        // the MAIN world does for screen.orientation.
        const navProto = Object.getPrototypeOf(navigator) || navigator;
        Object.defineProperty(navProto, 'maxTouchPoints', {
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
          enumerable: false,
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

      if (shouldHaveTouch) {
        // Touch device: make sure the touch event handler properties exist.
        if (!('ontouchstart' in window)) {
          try {
            window.ontouchstart = null;
            document.ontouchstart = null;
            log('[shapeshift][touch] Added ontouchstart support');
          } catch (e) {
            // May fail on some browsers
          }
        }
      } else if ('ontouchstart' in window) {
        // P2: on a real touch laptop, maxTouchPoints is spoofed to 0 but
        // 'ontouchstart' in window stayed true — a contradiction a detector can
        // read directly. Hide the property to match the spoofed non-touch story.
        try {
          delete window.ontouchstart;
          delete document.ontouchstart;
        } catch (e) {
          try {
            Object.defineProperty(window, 'ontouchstart', {
              get: () => undefined,
              configurable: true
            });
          } catch (e2) { /* best effort */ }
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

          // P0: `query` is caller-controlled; the native matchMedia coerces it
          // to a string, so a null/Symbol argument must not throw here.
          const lowerQuery = String(query).toLowerCase();

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

            // Platform methods must be invoked with the real MediaQueryList as
            // `this`; calling them through a Proxy throws "Illegal invocation".
            // Every function is therefore returned already bound to `result`,
            // and the getters are read from `result` so `matches` and the
            // change listeners stay consistent with each other.
            function spoofedMatches () {
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
              return result.matches;
            }

            // P2 4.4 (listener oracle): addEventListener was forwarded to the
            // REAL MediaQueryList, so a handler fired with `event.target` and
            // `this` equal to the real list - reading `e.target.matches` there
            // returned the un-spoofed value and defeated the whole shim. Each
            // callback is wrapped so the event it observes carries this proxy as
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
              get(target, prop) {
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
                const value = target[prop];
                if (typeof value === 'function') return value.bind(target);
                return value;
              }
            };

            proxy = new Proxy(result, handler);
            // Force the initial value so a listener that fires immediately
            // observes the spoofed state even before the get trap runs.
            try {
              Object.defineProperty(proxy, 'matches', { value: spoofedMatches(), configurable: true });
            } catch (e) { /* non-extensible MediaQueryList; the get trap still wins */ }

            return proxy;
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

        // Add event listener wrapper to add timing jitter.
        // Wrapped listeners are registered in a WeakMap so removeEventListener
        // still resolves the original listener and actually detaches it.
        const origAddEventListener = EventTarget.prototype.addEventListener;
        const origRemoveEventListener = EventTarget.prototype.removeEventListener;
        const listenerMap = new WeakMap();

        if (!globalThis.ssStealth.isPatched(origAddEventListener)) {
          globalThis.ssStealth.markPatched(origAddEventListener);
          globalThis.ssStealth.markPatched(origRemoveEventListener);

          EventTarget.prototype.addEventListener = function(type, listener, options) {
            // P0: `type` is caller-controlled; .startsWith on a non-string threw
            // where the native addEventListener would have coerced it.
            const typeStr = typeof type === 'string' ? type : String(type);
            if ((typeStr.startsWith('pointer') || typeStr.startsWith('touch')) && typeof listener === 'function') {
              let perTarget = listenerMap.get(listener);
              if (!perTarget) {
                perTarget = new WeakMap();
                listenerMap.set(listener, perTarget);
              }
              let wrappedListener = perTarget.get(this);
              if (!wrappedListener) {
                wrappedListener = function(event) {
                  if (globalThis.ssTimingUtils) {
                    globalThis.ssTimingUtils.executionJitter();
                  }
                  return listener.call(this, event);
                };
                perTarget.set(this, wrappedListener);
              }
              return origAddEventListener.call(this, type, wrappedListener, options);
            }
            return origAddEventListener.call(this, type, listener, options);
          };

          EventTarget.prototype.removeEventListener = function(type, listener, options) {
            const typeStr = typeof type === 'string' ? type : String(type);
            if ((typeStr.startsWith('pointer') || typeStr.startsWith('touch')) && typeof listener === 'function') {
              const perTarget = listenerMap.get(listener);
              const wrappedListener = perTarget && perTarget.get(this);
              if (wrappedListener) {
                return origRemoveEventListener.call(this, type, wrappedListener, options);
              }
            }
            return origRemoveEventListener.call(this, type, listener, options);
          };

          log('[shapeshift][touch] Pointer/touch event listeners wrapped with timing jitter');
        }
      }
    });
  });
})();
