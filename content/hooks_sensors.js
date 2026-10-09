// Sensor and performance API protection.
// Protects battery, performance memory, and other sensor APIs.
(function () {
  const installers = (globalThis.ssHookInstallers = globalThis.ssHookInstallers || []);

  installers.push(function installSensorHooks (env) {
    if (!env || !env.config?.enableSensorProtection) return;
    const prng = env.prngFor ? env.prngFor('sensors') : env.prng;
    const { noise, config } = env;
    const debug = config.debug ? true : false;
    const log = debug ? console.log : () => {};

    function safeWrap (fn) {
      try {
        fn();
      } catch (e) {
        if (debug) console.error('[shapeshift][sensors] Hook failed:', e);
      }
    }

    // Battery API protection
    safeWrap(() => {
      if (!navigator.getBattery) return;

      const origGetBattery = navigator.getBattery;
      if (globalThis.ssStealth && !globalThis.ssStealth.isPatched(origGetBattery)) {
        globalThis.ssStealth.markPatched(origGetBattery);

        navigator.getBattery = async function () {
          // Track statistics
          if (globalThis.ssStatsTracker) {
            globalThis.ssStatsTracker.increment('sensorReads');
          }

          if (globalThis.ssTimingUtils) {
            globalThis.ssTimingUtils.randomDelaySync();
          }

          const battery = await origGetBattery.call(this);

          // Return a Proxy over the real BatteryManager so the brand, prototype,
          // event-target identity and the other listeners stay intact. A plain
          // object literal failed `instanceof BatteryManager` and dropped every
          // property this file did not enumerate by hand.
          const spoofedLevel = Math.max(0.5, Math.min(1.0, 0.75 + noise(0.1)));
          // P1 2.6: chargingTime/dischargingTime used to be hard-coded to
          // 0 / Infinity regardless of the real state, which contradicted the
          // chargingchange and levelchange events this proxy still forwards
          // from the real BatteryManager. Derive both from the real charging
          // flag so the whole picture stays coherent.
          const realCharging = battery.charging === true;
          const realDischargingTime = battery.dischargingTime;
          const spoofedChargingTime = realCharging ? 0 : Infinity;
          const spoofedDischargingTime = realCharging
            ? Infinity
            : (typeof realDischargingTime === 'number' && isFinite(realDischargingTime) && realDischargingTime > 0
              ? realDischargingTime
              : Infinity);
          const spoofedBattery = new Proxy(battery, {
            get (target, prop, receiver) {
              if (prop === 'level') return spoofedLevel;
              if (prop === 'chargingTime') return spoofedChargingTime;
              if (prop === 'dischargingTime') return spoofedDischargingTime;
              const value = Reflect.get(target, prop, receiver);
              // Bind methods to the real object so `this` is never the Proxy,
              // which would raise Illegal invocation on native accessors.
              return typeof value === 'function' ? value.bind(target) : value;
            }
          });

          log('[shapeshift][sensors] Battery API spoofed, level:', spoofedLevel.toFixed(2));
          return spoofedBattery;
        };

        log('[shapeshift][sensors] Battery API hooked');
      }
    });

    // Performance memory protection
    safeWrap(() => {
      if (!performance.memory) return;

      const origMemory = performance.memory;
      const baseUsed = origMemory.usedJSHeapSize || 10000000;
      const baseLimit = origMemory.jsHeapSizeLimit || 2172649472;

      // Add noise to memory values
      const noisedMemory = {
        get jsHeapSizeLimit() {
          if (globalThis.ssTimingUtils) {
            globalThis.ssTimingUtils.randomDelaySync();
          }
          return Math.floor(baseLimit + noise(baseLimit * 0.05));
        },
        get totalJSHeapSize() {
          if (globalThis.ssTimingUtils) {
            globalThis.ssTimingUtils.randomDelaySync();
          }
          return Math.floor(baseUsed * 1.5 + noise(baseUsed * 0.1));
        },
        get usedJSHeapSize() {
          if (globalThis.ssTimingUtils) {
            globalThis.ssTimingUtils.randomDelaySync();
          }
          return Math.floor(baseUsed + noise(baseUsed * 0.1));
        }
      };

      try {
        Object.defineProperty(performance, 'memory', {
          get: () => noisedMemory,
          enumerable: true,
          configurable: true
        });
        log('[shapeshift][sensors] performance.memory hooked');
      } catch (e) {
        // May fail in some browsers
      }
    });

    // P1 2.4: performance.now() jittering was removed entirely. It ran in the
    // ISOLATED world, where the page never observes it - so it protected
    // nothing. Porting it to the MAIN world would be worse than useless: a
    // +/-0.05 ms zero-mean offset is far below the resolution a timing attack
    // needs to defeat (and a detector can average it away over a few hundred
    // samples), while it actively corrupts performance.now() deltas for
    // legitimate pages - animation frames, benchmark harnesses, RUM beacons.
    // Date.now() is deliberately not hooked either: it is coarsened by the
    // browser and patching it breaks every clock on the page.

    // Connection API protection (network information)
    safeWrap(() => {
      if (!navigator.connection && !navigator.mozConnection && !navigator.webkitConnection) return;

      const connection = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
      if (!connection) return;

      const connectionTypes = ['4g', '4g', '4g', 'wifi', 'wifi']; // Weighted
      const spoofedType = connectionTypes[Math.floor(prng() * connectionTypes.length)];
      const spoofedDownlink = spoofedType === 'wifi' ? 10 : 5; // Mbps

      try {
        Object.defineProperty(connection, 'effectiveType', {
          get: () => {
            if (globalThis.ssTimingUtils) {
              globalThis.ssTimingUtils.randomDelaySync();
            }
            return spoofedType;
          },
          enumerable: true,
          configurable: true
        });

        Object.defineProperty(connection, 'downlink', {
          get: () => {
            if (globalThis.ssTimingUtils) {
              globalThis.ssTimingUtils.randomDelaySync();
            }
            return spoofedDownlink + noise(1);
          },
          enumerable: true,
          configurable: true
        });

        log(`[shapeshift][sensors] Connection API hooked, type: ${spoofedType}`);
      } catch (e) {
        // May fail in some browsers
      }
    });

    // Keyboard layout detection via KeyboardEvent
    safeWrap(() => {
      const origKeyboardEvent = window.KeyboardEvent;
      if (!origKeyboardEvent) return;

      // This is complex and may break functionality, so just add timing jitter
      const origGetModifierState = KeyboardEvent.prototype.getModifierState;
      if (origGetModifierState && globalThis.ssStealth && !globalThis.ssStealth.isPatched(origGetModifierState)) {
        globalThis.ssStealth.markPatched(origGetModifierState);

        KeyboardEvent.prototype.getModifierState = function () {
          if (globalThis.ssTimingUtils) {
            globalThis.ssTimingUtils.randomDelaySync();
          }
          return origGetModifierState.apply(this, arguments);
        };

        log('[shapeshift][sensors] KeyboardEvent.getModifierState hooked');
      }
    });

    // Gamepad API protection
    safeWrap(() => {
      if (!navigator.getGamepads) return;

      const origGetGamepads = navigator.getGamepads;
      if (globalThis.ssStealth && !globalThis.ssStealth.isPatched(origGetGamepads)) {
        globalThis.ssStealth.markPatched(origGetGamepads);

        navigator.getGamepads = function () {
          if (globalThis.ssTimingUtils) {
            globalThis.ssTimingUtils.randomDelaySync();
          }

          const gamepads = origGetGamepads.call(this);

          // P1 2.5: returning a hard-coded [null, null, null, null] is both a
          // spoofing tell and a compatibility bug - `for (const gp of
          // navigator.getGamepads())` then dereferences null. An empty array
          // keeps the iteration contract and still hides real devices.
          if (config.sensors?.hideGamepads !== false) {
            return [];
          }

          return gamepads;
        };

        log('[shapeshift][sensors] Gamepad API hooked');
      }
    });

    // Plugin enumeration (legacy, but still used).
    // Returning a bare { length: 0 } is trivially detected: real PluginArray and
    // MimeTypeArray expose item(), namedItem() and iteration. Empty the real
    // objects instead, which keeps the prototype and brand intact.
    safeWrap(() => {
      try {
        const realPlugins = navigator.plugins;
        const realMimeTypes = navigator.mimeTypes;

        // P1 2.11: defineEmptyArrayLike() was dead code - it defined a getter
        // on `navigator` that the Object.defineProperty call a few lines below
        // immediately overwrote. Removed so the intent of this block is not
        // ambiguous.

        // Chrome's PluginArray is not constructible, so shadow the two
        // properties with the genuine objects but suppress their contents by
        // returning the empty native-like view via a Proxy.
        const emptyPlugins = new Proxy(realPlugins, {
          get (t, prop) {
            if (prop === 'length') return 0;
            if (prop === 'item' || prop === 'namedItem') return () => null;
            if (prop === Symbol.iterator) return function* () {};
            const v = Reflect.get(t, prop, t);
            return typeof v === 'function' ? v.bind(t) : v;
          },
          has () { return false; }
        });

        const emptyMimeTypes = new Proxy(realMimeTypes, {
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
          get: () => emptyPlugins,
          enumerable: true,
          configurable: true
        });
        Object.defineProperty(navigator, 'mimeTypes', {
          get: () => emptyMimeTypes,
          enumerable: true,
          configurable: true
        });

        log('[shapeshift][sensors] Plugins/mimeTypes hidden');
      } catch (e) {
        // May fail if already defined
      }
    });
  });
})();
