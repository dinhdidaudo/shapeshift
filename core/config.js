// Basic configuration knobs for fingerprint perturbation.
//
// Architecture §4: defaults, schema version and the legacy flat-key map live
// in core/config-schema.js, which manifest.json loads first. This file builds
// the live config object from that schema and keeps the storage load/merge
// logic, so there is exactly one definition of what a default value is.
(function () {
  const schema = globalThis.ssConfigSchema || {};
  const defaults = schema.defaults || {};
  // P1: this used to be a shallow copy, so every nested group
  // (`config.navigator`, `config.webrtc`, ...) was the SAME object as
  // `schema.defaults.navigator`. A hook that mutated its group in place
  // therefore edited the process-wide defaults, and the next
  // ssLoadConfig() call merged the mutated values back in as if the user
  // had chosen them. Deep-clone the groups so defaults stay pristine.
  const cloneGroup = (v) => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return v;
    const out = {};
    for (const gk in v) out[gk] = v[gk];
    return out;
  };
  const config = {};
  for (const k in defaults) config[k] = cloneGroup(defaults[k]);

  const LEGACY_FLAT_TO_NESTED = schema.flatToNested || {};

  // Config schema version (Architecture §4). Storing the version lets a future
  // release migrate an old ssConfig instead of silently reading keys that no
  // longer mean what they used to.
  const CONFIG_VERSION = schema.version || 1;
  config.ssConfigVersion = CONFIG_VERSION;

  // One-shot migrations keyed by the version they upgrade *from*. Each entry
  // rewrites a stored config object in place and the chain runs until the
  // stored version reaches CONFIG_VERSION.
  const CONFIG_MIGRATIONS = schema.migrations || {};

  globalThis.ssMigrateConfig = function (stored) {
    if (!stored || typeof stored !== 'object') return stored;
    let version = Number.isInteger(stored.ssConfigVersion) ? stored.ssConfigVersion : 0;
    while (version < CONFIG_VERSION) {
      const step = CONFIG_MIGRATIONS[version];
      if (typeof step !== 'function') { stored.ssConfigVersion = CONFIG_VERSION; break; }
      stored = step(stored);
      const next = Number.isInteger(stored.ssConfigVersion) ? stored.ssConfigVersion : version + 1;
      if (next <= version) { stored.ssConfigVersion = CONFIG_VERSION; break; }
      version = next;
    }
    return stored;
  };

  globalThis.ssNormalizeConfig = function (stored) {
    if (!stored || typeof stored !== 'object') return {};
    const out = {};
    for (const k in stored) out[k] = stored[k];
    globalThis.ssMigrateConfig(out);
    for (const flatKey in LEGACY_FLAT_TO_NESTED) {
      if (!Object.prototype.hasOwnProperty.call(stored, flatKey)) continue;
      const pair = LEGACY_FLAT_TO_NESTED[flatKey];
      const src = (out[pair[0]] && typeof out[pair[0]] === 'object' && !Array.isArray(out[pair[0]]))
        ? out[pair[0]] : (config[pair[0]] || {});
      const merged = {};
      for (const gk in src) merged[gk] = src[gk];
      merged[pair[1]] = stored[flatKey];
      out[pair[0]] = merged;
    }
    return out;
  };

  globalThis.ssConfig = config;

  globalThis.ssLoadConfig = async function () {
    const defaultConfig = {};
    for (const k in config) defaultConfig[k] = config[k];
    try {
      const hasStorage = typeof chrome !== "undefined" && !!chrome.storage && !!chrome.storage.local;
      if (!hasStorage) return defaultConfig;
      const result = await new Promise((resolve, reject) => {
        chrome.storage.local.get(['ssConfig'], (r) => {
          if (chrome.runtime && chrome.runtime.lastError) reject(chrome.runtime.lastError);
          else resolve(r);
        });
      });
      const stored = globalThis.ssNormalizeConfig(result.ssConfig || {});
      const merged = {};
      for (const k in defaultConfig) merged[k] = defaultConfig[k];
      for (const key in stored) {
        const v = stored[key];
        if (v && typeof v === 'object' && !Array.isArray(v)) {
          const base = (defaultConfig[key] && typeof defaultConfig[key] === 'object') ? defaultConfig[key] : {};
          const g = {};
          for (const gk in base) g[gk] = base[gk];
          for (const gk in v) g[gk] = v[gk];
          merged[key] = g;
        } else {
          merged[key] = v;
        }
      }
      globalThis.ssConfig = merged;
      if (merged.debug) console.log('[shapeshift][config] Loaded config:', merged);
      return merged;
    } catch (e) {
      if (config.debug) console.error('[shapeshift][config] Failed to load stored config:', e);
      return defaultConfig;
    }
  };

  // P2: changing a setting in Options used to leave every already-open tab on
  // the stale config until a manual reload, because only the salt had a
  // storage.onChanged listener. Rebuild the live config whenever ssConfig
  // changes so the next read on an open page sees the new values.
  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes.ssConfig) return;
      // P2 7.1 (seed epoch): the epoch is the single observer of "the
      // derivation inputs moved". It was defined in core/hash.js but never
      // bumped anywhere, so a hook that recorded the epoch it derived under
      // would have waited forever. A config edit changes which surfaces are on
      // and with what magnitude, so it must advance the epoch before the new
      // config is published.
      if (typeof globalThis.ssBumpSeedEpoch === 'function') globalThis.ssBumpSeedEpoch();
      globalThis.ssLoadConfig().catch(() => {});
      // Feature 5.2: mirror the new config into chrome.storage.sync so another
      // signed-in browser picks the same settings up. Only the config travels;
      // ss_salt never leaves chrome.storage.local, so syncing a profile cannot
      // clone this machine's identity. Best-effort: sync may be unavailable or
      // disabled, and that must never break the local load path.
      try {
        if (chrome.storage.sync && changes.ssConfig.newValue) {
          chrome.storage.sync.set({ ssConfig: changes.ssConfig.newValue }, function () {
            if (chrome.runtime && chrome.runtime.lastError) { /* sync unavailable */ }
          });
        }
      } catch (e) { /* sync unavailable */ }
    });
  }

  // Feature 5.2: a fresh machine that signs into the same profile has no local
  // ssConfig yet but may have one in sync. Adopt it once, and only when local
  // is absent, so an offline edit on this machine is never overwritten.
  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.sync) {
    try {
      chrome.storage.sync.get(['ssConfig'], function (synced) {
        if (!synced || !synced.ssConfig) return;
        chrome.storage.local.get(['ssConfig'], function (local) {
          if (local && local.ssConfig) return;
          // P1: the adopted object used to be written verbatim. A config that
          // came from an older build (or a hand-edited sync store) then kept its
          // old schema version and flat legacy keys, so the very next
          // ssLoadConfig() call had to repair it - and any hook that read the
          // raw store in between saw un-normalized values. Run it through the
          // same normalize+migrate path the local read uses, and stamp the
          // current schema version before it is persisted.
          const adopted = globalThis.ssNormalizeConfig(synced.ssConfig);
          adopted.ssConfigVersion = CONFIG_VERSION;
          chrome.storage.local.set({ ssConfig: adopted }, function () {
            if (chrome.runtime && chrome.runtime.lastError) { /* ignore */ }
          });
        });
      });
    } catch (e) { /* sync unavailable */ }
  }
})();
