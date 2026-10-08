// Persistent salt management using chrome.storage.local.
(function () {
  const STORAGE_KEY = "ss_salt";
  let cachedSalt = null;

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
    const arr = new Uint32Array(4);
    crypto.getRandomValues(arr);
    return Array.from(arr, n => n.toString(16).padStart(8, "0")).join("");
  }

  function readSalt () {
    return new Promise((resolve, reject) => {
      try {
        if (!chrome?.storage?.local) {
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
        if (!chrome?.storage?.local) {
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

  async function getSalt () {
    if (cachedSalt) return cachedSalt;

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

    const newSalt = randomHex128();
    cachedSalt = newSalt;
    try {
      await writeSalt(newSalt);
      // Two tabs can race here: both read null, both generate a salt, and the
      // later write wins. Re-read after writing and adopt the stored value so
      // every tab converges on one salt for the install (determinism contract).
      const confirmed = await readSalt();
      if (confirmed && confirmed !== newSalt) {
        logDebug("another tab won the salt race; adopting stored salt");
        cachedSalt = confirmed;
      }
    } catch (e) {
      logDebug("write failed; using in-memory salt only", e);
      // Storage failed; keep in-memory salt for this page load
    }
    logDebug("using salt", cachedSalt);
    return cachedSalt;
  }

  // Cross-tab convergence (P0 1.5): the re-read in getSalt() closes the window
  // where two tabs race to create the first salt, but a tab that already cached
  // a value would keep it forever if another tab (or a rotation) replaced the
  // stored one. Adopting storage changes keeps one salt per install, so the
  // "same (salt, origin, config) -> same values" contract holds across tabs.
  try {
    if (chrome?.storage?.onChanged) {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== "local" || !changes[STORAGE_KEY]) return;
        const next = changes[STORAGE_KEY].newValue;
        if (next && next !== cachedSalt) {
          logDebug("stored salt changed; adopting", next);
          cachedSalt = next;
        }
      });
    }
  } catch (e) {
    logDebug("onChanged listener unavailable", e);
  }

  globalThis.ssGetSalt = getSalt;
})();
