// Basic configuration knobs for fingerprint perturbation.
//
// Architecture §4: defaults, schema version and the legacy flat-key map live
// in core/config-schema.js, which manifest.json loads first. This file builds
// the live config object from that schema and keeps the storage load/merge
// logic, so there is exactly one definition of what a default value is.
(function () {
  const schema = globalThis.ssConfigSchema || {};
  const defaults = schema.defaults || {};
  const config = {};
  for (const k in defaults) config[k] = defaults[k];

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
})();
