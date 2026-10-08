// Hashing helpers to derive deterministic seeds with PBKDF2-style strengthening.
(function () {
  // FNV-1a hash - fast and good distribution
  function hashString (str) {
    let h1 = 0x811C9DC5;
    for (let i = 0; i < str.length; i++) {
      h1 ^= str.charCodeAt(i);
      h1 = Math.imul(h1, 0x01000193);
      h1 >>>= 0;
    }
    return h1 >>> 0;
  }

  // PBKDF2-style iterative key derivation for stronger seed
  function deriveStrongSeed(baseSalt, origin, iterations = 1000) {
    // Initial mix
    let seed = hashString(String(baseSalt) + String(origin || ""));

    // Iterative strengthening (PBKDF2-like)
    for (let i = 0; i < iterations; i++) {
      // Mix current seed with salt and origin again
      seed = hashString(String(seed) + String(baseSalt) + String(i));
    }

    return seed >>> 0;
  }

  // Per-surface seed derivation (P1 2.26). A single PRNG shared by every
  // surface meant the value a surface reported depended on how many draws the
  // *other* surfaces had already made, so toggling one module silently shifted
  // every other surface. Deriving an independent seed per
  // (salt, origin, surfaceId) removes that coupling while keeping each surface
  // deterministic on its own.
  function deriveSurfaceSeed (baseSalt, origin, surfaceId, iterations = 64) {
    const mixed = hashString(String(surfaceId) + "|" + String(baseSalt) + "|" + String(origin || ""));
    return deriveStrongSeed(String(mixed), String(surfaceId), iterations);
  }

  // Legacy derivation for backwards compatibility
  function deriveSeed (baseSalt, origin) {
    const saltHash = hashString(String(baseSalt));
    const originHash = hashString(String(origin || ""));
    return (saltHash ^ originHash) >>> 0;
  }

  // Use strong derivation by default, but allow legacy mode
  function deriveSeedWithConfig(baseSalt, origin) {
    const config = globalThis.ssConfig || {};
    if (config.useStrongKDF !== false) {
      // Default to strong KDF (1000 iterations)
      const iterations = config.kdfIterations || 1000;
      return deriveStrongSeed(baseSalt, origin, iterations);
    }
    // Fallback to simple derivation if disabled
    return deriveSeed(baseSalt, origin);
  }

  globalThis.ssHashString = hashString;
  globalThis.ssDeriveSeed = deriveSeedWithConfig; // Use strong version by default
  globalThis.ssDeriveSeedSimple = deriveSeed; // Expose legacy for testing
  globalThis.ssDeriveStrongSeed = deriveStrongSeed; // Expose strong version directly
  globalThis.ssDeriveSurfaceSeed = deriveSurfaceSeed; // Per-surface seed (P1 2.26)
})();
