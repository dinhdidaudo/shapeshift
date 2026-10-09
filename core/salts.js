// Persistent salt management using chrome.storage.local.
//
// P0 (per-origin salt): this used to keep ONE install-wide salt under the
// single key "ss_salt", so one rotation changed the identity of EVERY site at
// once - including sites holding a live login session. A brand-new device on an
// unchanged session is exactly the session-hijacking pattern anti-fraud systems
// challenge, so the salt is now keyed per origin ("ss_salt:<origin>"). A
// rotation then only invalidates the site it was asked to rotate, and every
// other site keeps the identity its session was created with.
//
// An empty scope keeps the legacy single key, so a caller that does not know
// its origin (or a user who disabled per-origin fingerprints) still works.
(function () {
  const STORAGE_KEY = "ss_salt";
  // One cache and one in-flight promise per storage key: concurrent getSalt()
  // calls for the same origin converge on a single salt, and calls for two
  // different origins never block or overwrite each other.
  const cachedSalts = new Map();
  const inflightSalts = new Map();

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

  function saltKey (scope) {
    return scope ? STORAGE_KEY + ':' + scope : STORAGE_KEY;
  }

  function readSalt (key) {
    return new Promise((resolve, reject) => {
      try {
        if (!hasStorage()) {
          resolve(null);
          return;
        }
        chrome.storage.local.get([key], result => {
          const err = chrome.runtime?.lastError;
          if (err) {
            logDebug("read error", err);
            reject(err);
            return;
          }
          logDebug("read", result?.[key]);
          resolve(result?.[key] || null);
        });
      } catch (e) {
        logDebug("read exception", e);
        reject(e);
      }
    });
  }

  function writeSalt (key, salt) {
    return new Promise((resolve, reject) => {
      try {
        if (typeof chrome === "undefined" || !chrome.storage || !chrome.storage.local) {
          resolve();
          return;
        }
        chrome.storage.local.set({ [key]: salt }, () => {
          const err = chrome.runtime?.lastError;
          if (err) {
            logDebug("write error", err);
            reject(err);
            return;
          }
          logDebug("write success", key);
          resolve();
        });
      } catch (e) {
        logDebug("write exception", e);
        reject(e);
      }
    });
  }

  async function createSalt (key) {
    const newSalt = randomHex128();
    try {
      // P1 (determinism contract): the old order cached the fresh salt *before*
      // awaiting the write. If the write failed, the in-memory value was used
      // for this page load but never reached storage, so the next load derived a
      // different seed for the same (origin, config) - exactly the instability
      // this extension promises not to have. Persist first, then cache.
      await writeSalt(key, newSalt);
    } catch (e) {
      logDebug("write failed; using in-memory salt only", e);
      // Storage unavailable: keep the value for this page load only. Every tab
      // in this state derives independently, which is strictly better than
      // deriving from no salt at all.
      cachedSalts.set(key, newSalt);
      return newSalt;
    }

    // Two tabs can race here: both read null, both generate a salt, and the
    // later write wins. Re-read after writing and adopt the stored value so
    // every tab converges on one salt per key (determinism contract).
    let adopted = newSalt;
    try {
      const confirmed = await readSalt(key);
      if (confirmed && confirmed !== newSalt) {
        adopted = confirmed;
        logDebug("another tab won the salt race; adopting stored salt");
      }
    } catch (e) {
      // Keep the value we just wrote.
    }
    cachedSalts.set(key, adopted);
    logDebug("using salt", key);
    return adopted;
  }

  function getSalt (scope) {
    const key = saltKey(scope);
    if (cachedSalts.has(key)) return Promise.resolve(cachedSalts.get(key));
    if (inflightSalts.has(key)) return inflightSalts.get(key);

    const pending = (async () => {
      try {
        const existing = await readSalt(key);
        if (existing) {
          cachedSalts.set(key, existing);
          return existing;
        }
      } catch (e) {
        logDebug("read failed, generating new salt", e);
        // Ignore read errors, will generate a fresh salt
      }
      return createSalt(key);
    })().finally(() => { inflightSalts.delete(key); });

    inflightSalts.set(key, pending);
    return pending;
  }

  // Cross-tab convergence (P0 1.5): the re-read in getSalt() closes the window
  // where two tabs race to create the first salt, but a tab that already cached
  // a value would keep it forever if another tab (or a rotation) replaced the
  // stored one. Adopting storage changes keeps one salt per origin, so the
  // "same (salt, origin, config) -> same values" contract holds across tabs.
  //
  // P0 (per-origin): this used to watch the single STORAGE_KEY only, so a
  // rotation that removed "ss_salt:<origin>" left every open tab advertising
  // the old salt until it was reloaded. Every key in the namespace is adopted
  // (and a removed one is dropped) now.
  try {
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.onChanged) {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== "local") return;
        let touched = false;
        for (const key of Object.keys(changes)) {
          if (key !== STORAGE_KEY && key.indexOf(STORAGE_KEY + ':') !== 0) continue;
          const next = changes[key].newValue;
          if (next) {
            logDebug("stored salt changed; adopting", key);
            cachedSalts.set(key, next);
          } else {
            // The key was removed (a rotation): forget it so the next read
            // regenerates instead of serving the rotated-away value.
            logDebug("stored salt removed", key);
            cachedSalts.delete(key);
          }
          touched = true;
        }
        // P2 7.1 (seed epoch): the salt is the root of every derived seed, so
        // replacing it invalidates every value already handed to a hook. Bump
        // the epoch at the one place a salt becomes live or goes away.
        if (touched && typeof globalThis.ssBumpSeedEpoch === 'function') globalThis.ssBumpSeedEpoch();
      });
    }
  } catch (e) {
    logDebug("onChanged listener unavailable", e);
  }

  globalThis.ssGetSalt = getSalt;
})();
