// Stealth utilities to hide extension fingerprinting.
// Prevents detection via Symbol-based tracking and minimal global pollution.
(function () {
  // Use Symbols instead of string properties to avoid detection
  const patchedMarker = Symbol('fp.patched');

  // WeakMap to track patched objects without adding properties
  const patchedObjects = new WeakMap();

  // Check if an object/function has been patched
  function isPatched(obj) {
    if (!obj) return false;
    return patchedObjects.has(obj) || obj[patchedMarker] === true;
  }

  // Mark an object/function as patched
  function markPatched(obj) {
    if (!obj) return;
    try {
      // Try WeakMap first (cleaner)
      patchedObjects.set(obj, true);
    } catch (e) {
      // Fallback to Symbol if WeakMap fails
      try {
        Object.defineProperty(obj, patchedMarker, {
          value: true,
          writable: false,
          enumerable: false,
          configurable: false
        });
      } catch (e2) {
        // If both fail, silently continue
      }
    }
  }

  // Clean up globals to minimize fingerprinting surface
  function cleanupGlobals() {
    // Remove development/debug globals that could expose the extension
    const globalsToClean = [
      // Keep these for now as they're needed by content scripts:
      // 'ssConfig', 'ssEnv', 'ssPRNG', 'ssNoise', 'ssReady',
      // 'ssHookInstallers', 'ssTestFingerprint'

      // But we can make them non-enumerable
    ];

    const makeNonEnumerable = [
      'ssConfig', 'ssGetSalt', 'ssDeriveSeed', 'ssHashString',
      'ssCreatePRNG', 'ssPRNG', 'ssNoise', 'ssEnv', 'ssReady',
      'ssHookInstallers', 'ssTestFingerprint', 'ssTimingUtils'
    ];

    makeNonEnumerable.forEach(prop => {
      if (prop in globalThis) {
        try {
          const value = globalThis[prop];
          delete globalThis[prop];
          Object.defineProperty(globalThis, prop, {
            value: value,
            writable: true,
            enumerable: false, // Hide from Object.keys(), for..in, etc.
            configurable: true
          });
        } catch (e) {
          // Ignore if property is non-configurable
        }
      }
    });
  }

  // Proxy-based hooking (alternative to prototype modification)
  function createProxy(target, handler) {
    try {
      return new Proxy(target, handler);
    } catch (e) {
      // Fallback to direct modification if Proxy fails
      return target;
    }
  }

  // Expose stealth utilities
  globalThis.ssStealth = {
    isPatched,
    markPatched,
    cleanupGlobals,
    createProxy
  };

  // Make ssStealth itself non-enumerable
  try {
    const value = globalThis.ssStealth;
    delete globalThis.ssStealth;
    Object.defineProperty(globalThis, 'ssStealth', {
      value: value,
      writable: false,
      enumerable: false,
      configurable: false
    });
  } catch (e) {
    // Ignore if fails
  }
})();
