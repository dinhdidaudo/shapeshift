// Persistent salt management using chrome.storage.local.
(function () {
  const STORAGE_KEY = "ss_salt";
  let cachedSalt = null;
  // P1 (tab race): two tabs could both read null, both generate a salt and both
  // write. The re-read below resolved the winner, but a second caller inside the
  // *same* tab could start generating before the first write landed. One
  // in-flight promise per context makes concurrent getSalt() calls converge on a
  // single salt instead of racing each other.
  let inflight = null;

  function logDebug (...args) {
    try {
      if (globalThis.ssConfig && globalThis.ssConfig.debug) {
        console.log("[shapeshift][salt]", ...args);
      }
    } catch (e) {
      // ignore logging errors
    }
  }

  function randomHex128 () {
    // crypto.getRandomValues exists in every MV3 content-script context.
    // Deliberately no Math.random fallback: the salt is the root of the seed
    // chain, so a weak salt would silently weaken every derived identity.
    //
    // P1: this used to throw straight out of getSalt(), where bootstrap.js
    // turned the rejection into "no protection at all" with no diagnostic. The
    // failure is still fatal for this load, but it now carries a name and a
    // message so it can be logged and reported instead of looking like a
    // silent no-op.
    const arr = new Uint32Array(4);
    try {
      if (typeof crypto === 'undefined' || typeof crypto.getRandomValues !== 'function') {
        throw new Error('crypto.getRandomValues is unavailable');
      }
      crypto.getRandomValues(arr);
    } catch (e) {
      const err = new Error('ShapeShift could not generate a salt: ' + (e && e.message ? e.message : String(e)));
      err.name = 'SsSaltError';
      logDebug('random source failed', err);
      throw err;
    }
    return Array.from(arr, n => n.toString(16).padStart(8, "0")).join("");
  }

  // P2: `chrome?.storage?.local` throws ReferenceError when the binding itself
  // is undeclared (unit tests, non-extension host). Test the name first.
  function hasStorage () {
    if (typeof chrome === 'undefined') return false;
    return !!(chrome.storage && chrome.storage.local);
  }

  function readSalt () {
    return new Promise((resolve, reject) => {
      try {
        if (!hasStorage()) {
          resolve(null);
          return;
        }
        chrome.storage.local.get([STORAGE_KEY], result => {
          const err = chrome.runtime?.lastError;
          if (err) {
            logDebug("read error", err);
            reject(err);
            return;
          }
          logDebug("read", result?.[STORAGE_KEY]);
          resolve(result?.[STORAGE_KEY] || null);
        });
      } catch (e) {
        logDebug("read exception", e);
        reject(e);
      }
    });
  }

  function writeSalt (salt) {
    return new Promise((resolve, reject) => {
      try {
        if (typeof chrome === "undefined" || !chrome.storage || !chrome.storage.local) {
          resolve();
          return;
        }
        chrome.storage.local.set({ [STORAGE_KEY]: salt }, () => {
          const err = chrome.runtime?.lastError;
          if (err) {
            logDebug("write error", err);
            reject(err);
            return;
          }
          logDebug("write success", salt);
          resolve();
        });
      } catch (e) {
        logDebug("write exception", e);
        reject(e);
      }
    });
  }

  async function createSalt () {
    const newSalt = randomHex128();
    try {
      // P1 (determinism contract): the old order cached the fresh salt *before*
      // awaiting the write. If the write failed, the in-memory value was used
      // for this page load but never reached storage, so the next load derived a
      // different seed for the same (origin, config) - exactly the instability
      // this extension promises not to have. Persist first, then cache.
      await writeSalt(newSalt);
    } catch (e) {
      logDebug("write failed; using in-memory salt only", e);
      // Storage unavailable: keep the value for this page load only. Every tab
      // in this state derives independently, which is strictly better than
      // deriving from no salt at all.
      cachedSalt = newSalt;
      return cachedSalt;
    }

    // Two tabs can race here: both read null, both generate a salt, and the
    // later write wins. Re-read after writing and adopt the stored value so
    // every tab converges on one salt for the install (determinism contract).
    try {
      const confirmed = await readSalt();
      cachedSalt = (confirmed && confirmed !== newSalt) ? confirmed : newSalt;
      if (confirmed && confirmed !== newSalt) {
        logDebug("another tab won the salt race; adopting stored salt");
      }
    } catch (e) {
      cachedSalt = newSalt;
    }
    logDebug("using salt", cachedSalt);
    return cachedSalt;
  }

  function getSalt () {
    if (cachedSalt) return Promise.resolve(cachedSalt);
    if (inflight) return inflight;

    inflight = (async () => {
      try {
        const existing = await readSalt();
        if (existing) {
          cachedSalt = existing;
          return cachedSalt;
        }
      } catch (e) {
        logDebug("read failed, generating new salt", e);
        // Ignore read errors, will generate a fresh salt
      }
      return createSalt();
    })().finally(() => { inflight = null; });

    return inflight;
  }

  // Cross-tab convergence (P0 1.5): the re-read in getSalt() closes the window
  // where two tabs race to create the first salt, but a tab that already cached
  // a value would keep it forever if another tab (or a rotation) replaced the
  // stored one. Adopting storage changes keeps one salt per install, so the
  // "same (salt, origin, config) -> same values" contract holds across tabs.
  try {
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.onChanged) {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== "local" || !changes[STORAGE_KEY]) return;
        const next = changes[STORAGE_KEY].newValue;
        if (next && next !== cachedSalt) {
          logDebug("stored salt changed; adopting", next);
          cachedSalt = next;
          // P2 7.1 (seed epoch): the salt is the root of every derived seed, so
          // replacing it invalidates every value already handed to a hook. The
          // epoch was defined but never advanced, so nothing could observe the
          // swap. Bump it here, at the one place a new salt becomes live.
          if (typeof globalThis.ssBumpSeedEpoch === 'function') globalThis.ssBumpSeedEpoch();
        }
      });
    }
  } catch (e) {
    logDebug("onChanged listener unavailable", e);
  }

  globalThis.ssGetSalt = getSalt;
})();
