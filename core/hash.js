// Hashing helpers to derive deterministic seeds with PBKDF2-style strengthening.
(function () {
  const FNV_OFFSET = 0x811C9DC5;
  const FNV_PRIME = 0x01000193;

  // FNV-1a hash - fast and good distribution
  function hashString (str) {
    return fnvUpdate(FNV_OFFSET, str);
  }

  // P1 (hot loops): Canvas and Audio built a fresh string per sample and hashed
  // it from scratch - a 1920x1080 getImageData() meant ~2 million concatenations
  // plus ~30 million character folds on the main thread. FNV-1a is a pure
  // sequential fold, so the state after a constant prefix can be computed once
  // and carried forward. `fnvUpdate` is exported so hooks can reuse a prefix
  // state and hash only the varying digits, producing byte-identical results
  // without allocating.
  function fnvUpdate (state, str) {
    let h = state >>> 0;
    const s = String(str);
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, FNV_PRIME);
      h >>>= 0;
    }
    return h >>> 0;
  }

  // P1 (KDF collisions): the old derivation concatenated its inputs with no
  // separator, so ("ab", "c") and ("a", "bc") hashed to the same value, and a
  // numeric counter could be absorbed by the salt (i=1 with salt "2" produced
  // the same string as i=12 with an empty tail). Every field is now
  // length-prefixed and delimiter-terminated, so two different tuples can never
  // flatten onto the same byte stream.
  function mixString (...parts) {
    let out = '';
    for (const part of parts) {
      const s = String(part);
      out += s.length + ':' + s + '|';
    }
    return hashString(out);
  }

  // A config typo used to reach the derivation loop verbatim: a negative,
  // fractional, NaN or absurd `kdfIterations` either hung the page or silently
  // collapsed the KDF to a single round. Clamp once, here, so both worlds agree.
  const MAX_ITERATIONS = 200000;
  function clampIterations (value, fallback) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    const i = Math.trunc(n);
    if (i < 1) return fallback;
    if (i > MAX_ITERATIONS) return MAX_ITERATIONS;
    return i;
  }

  // PBKDF2-style iterative key derivation for stronger seed
  function deriveStrongSeed(baseSalt, origin, iterations = 1000) {
    const iters = clampIterations(iterations, 1000);
    // Initial mix
    let seed = mixString('ss.kdf.v2', baseSalt, origin || "");

    // Iterative strengthening (PBKDF2-like)
    for (let i = 0; i < iters; i++) {
      // Mix current seed with salt and origin again
      seed = mixString(seed, baseSalt, i);
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
    const mixed = mixString('ss.surface', surfaceId, baseSalt, origin || "");
    return deriveStrongSeed(mixed, surfaceId, clampIterations(iterations, 64));
  }

  // Legacy derivation for backwards compatibility. The retired version XORed
  // the two FNV hashes, which made it order-insensitive
  // (deriveSeed(A, B) === deriveSeed(B, A)) and folded the whole tuple into 32
  // bits. Keep the name for callers that opt out of the strong KDF, but derive
  // it order-sensitively.
  function deriveSeed (baseSalt, origin) {
    return mixString('ss.legacy', baseSalt, origin || "");
  }

  // Use strong derivation by default, but allow legacy mode
  function deriveSeedWithConfig(baseSalt, origin) {
    const config = globalThis.ssConfig || {};
    if (config.useStrongKDF !== false) {
      // Default to strong KDF (1000 iterations); clamped in deriveStrongSeed.
      return deriveStrongSeed(baseSalt, origin, clampIterations(config.kdfIterations, 1000));
    }
    // Fallback to simple derivation if disabled
    return deriveSeed(baseSalt, origin);
  }

  // P2 7.1 (seed epoch): a config or salt change used to leave every already
  // installed hook on a seed derived from the OLD inputs. Each hook derived its
  // own value at install time, so there was no single place that could observe
  // "the derivation inputs moved". A monotonic epoch is that place: a hook
  // records the epoch it derived under and re-derives when the current epoch is
  // higher, without every hook needing its own change listener.
  let seedEpoch = 1;
  function getSeedEpoch () { return seedEpoch; }
  function bumpSeedEpoch () { seedEpoch += 1; return seedEpoch; }

  globalThis.ssSeedEpoch = getSeedEpoch;
  globalThis.ssBumpSeedEpoch = bumpSeedEpoch;
  globalThis.ssHashString = hashString;
  globalThis.ssMixString = mixString;
  globalThis.ssClampIterations = clampIterations;
  globalThis.ssFnvInit = function () { return FNV_OFFSET >>> 0; };
  globalThis.ssFnvUpdate = fnvUpdate;
  globalThis.ssDeriveSeed = deriveSeedWithConfig; // Use strong version by default
  globalThis.ssDeriveSeedSimple = deriveSeed; // Expose legacy for testing
  globalThis.ssDeriveStrongSeed = deriveStrongSeed; // Expose strong version directly
  globalThis.ssDeriveSurfaceSeed = deriveSurfaceSeed; // Per-surface seed (P1 2.26)
})();
