// Stealth utilities to hide extension fingerprinting.
// Prevents detection via Symbol-based tracking and minimal global pollution.
(function () {
  // Use Symbols instead of string properties to avoid detection. The
  // description is only a debugging label, but it must not resurrect the
  // retired fp* namespace (AGENTS.md rule 2).
  const patchedMarker = Symbol('ss.patched');

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

    // P2: ssStatsTracker was missing from this list, so it stayed an
    // enumerable own property of globalThis and was trivially discoverable.
    // P2: the list was a partial enumeration, so every `ss*` global added after
    // it was written stayed an enumerable own property of globalThis - one
    // `Object.keys(globalThis)` away from revealing the extension. The whole
    // namespace is now covered, including the KDF/PRNG helpers that leaked
    // (ssDeriveStrongSeed, ssDeriveSeedSimple, ssDeriveSurfaceSeed,
    // ssCreateMulberry32) and the config/salt loaders.
    // P2: the list is now the *complete* set of ss* globals the runtime
    // assigns, verified by scripts/verify.mjs. The schema aliases
    // (ssConfigSchema, ssDefaultConfig, ssFlatDefaults, ssFlatToNested) and
    // ssNormalizeConfig were added after this list was written and stayed
    // enumerable, which is exactly the drift the gate now prevents.
    const makeNonEnumerable = [
      'ssConfig', 'ssLoadConfig', 'ssMigrateConfig', 'ssNormalizeConfig',
      'ssGetSalt', 'ssConfigSchema', 'ssDefaultConfig', 'ssFlatDefaults',
      'ssFlatToNested', 'ssDeriveSeed', 'ssDeriveSeedSimple',
      'ssDeriveStrongSeed', 'ssDeriveSurfaceSeed', 'ssHashString', 'ssMixString',
      'ssClampIterations', 'ssFnvInit', 'ssFnvUpdate', 'ssCreatePRNG',
      'ssCreateMulberry32', 'ssPRNG', 'ssNoise', 'ssEnv', 'ssReady',
      'ssHookInstallers', 'ssTestFingerprint', 'ssTestFingerprintReport', 'ssTimingUtils', 'ssStatsTracker',
      // P2 7.1: the seed-epoch accessors are part of the same namespace and
      // would otherwise be the only ss* globals visible to Object.keys().
      'ssSeedEpoch', 'ssBumpSeedEpoch',
      // Anti-fraud §1: core/chrome-versions.js exposes the real-Chrome version
      // table and its picker to the ISOLATED world (page_world_injector.js
      // inlines its own copy for the MAIN world). Both names would otherwise
      // be enumerable and give the extension away in one Object.keys() call.
      'ssChromeStableVersions', 'ssPickChromeVersion'
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
    // P2: configurable: false made cleanupGlobals() (or any later stage that
    // needs to replace the helper) fail silently forever. It stays
    // non-enumerable, which is the part that actually hides it from the page.
    Object.defineProperty(globalThis, 'ssStealth', {
      value: value,
      writable: true,
      enumerable: false,
      configurable: true
    });
  } catch (e) {
    // Ignore if fails
  }
})();
