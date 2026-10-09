// User agent and platform protection.
// Adds subtle variations to user agent and platform strings.
(function () {
  const installers = (globalThis.ssHookInstallers = globalThis.ssHookInstallers || []);

  installers.push(function installUserAgentHooks (env) {
    if (!env || !env.config?.enableUserAgentProtection) return;
    const { config } = env;
    const debug = config.debug ? true : false;
    const log = debug ? console.log : () => {};

    function safeWrap (fn) {
      try {
        fn();
      } catch (e) {
        if (debug) console.error('[shapeshift][useragent] Hook failed:', e);
      }
    }

    // P1 2.9: the UA string, appVersion and the UA-CH fields used to draw their
    // own independent PRNG values, so the same browser advertised four
    // different Chrome versions - a trivial cross-check for any site that reads
    // both navigator.userAgent and navigator.userAgentData. Derive one persona
    // delta from (seed, platform) and reuse it everywhere.
    const uaSeed = (env.seed >>> 0) || 0;
    const uaHash = globalThis.ssHashString;
    function personaRoll (label) {
      if (!uaHash) return 0.5;
      return uaHash(uaSeed + ':ua:' + label) / 4294967296;
    }
    const uaPatchVariation = Math.floor(personaRoll('patch') * 5) - 2; // -2..+2
    const uaBuildVariation = Math.floor(personaRoll('build') * 3) - 1; // -1..+1

    // Common platform strings
    // P1: MacPPC and armv7l are PowerPC/32-bit ARM strings that no current
    // Chrome build reports; advertising one is a fingerprint that does not
    // exist in the real population.
    const platforms = {
      windows: ['Win32', 'Win64'],
      mac: ['MacIntel'],
      linux: ['Linux x86_64', 'Linux i686'],
      other: ['Win32', 'MacIntel'] // Fallback
    };

    // Detect current OS category
    const origPlatform = navigator.platform;
    let platformCategory = 'other';
    if (origPlatform.includes('Win')) platformCategory = 'windows';
    else if (origPlatform.includes('Mac')) platformCategory = 'mac';
    else if (origPlatform.includes('Linux')) platformCategory = 'linux';

    // Select a platform variant from the same category
    const platformOptions = platforms[platformCategory] || platforms.other;
    // P1: this used to draw from the streaming PRNG, so two loads of the same
    // origin advertised a different platform each time. Key it on the seed
    // like every other surface so the persona is stable per origin.
    const spoofedPlatform = platformOptions[
      Math.floor(personaRoll('platform') * platformOptions.length) % platformOptions.length];

    log(`[shapeshift][useragent] Original platform: ${origPlatform}, Spoofed: ${spoofedPlatform}`);

    // Hook navigator.platform
    safeWrap(() => {
      try {
        Object.defineProperty(navigator, 'platform', {
          get: function() {
            // Track statistics
            if (globalThis.ssStatsTracker) {
              globalThis.ssStatsTracker.increment('navigatorReads');
            }

            if (globalThis.ssTimingUtils) {
              globalThis.ssTimingUtils.randomDelaySync();
            }
            return spoofedPlatform;
          },
          enumerable: false,
          configurable: true
        });
        log('[shapeshift][useragent] navigator.platform hooked');
      } catch (e) {
        if (debug) console.error('[shapeshift][useragent] Failed to hook platform:', e);
      }
    });

    // Hook navigator.userAgent - Add minor version variation
    safeWrap(() => {
      const origUserAgent = navigator.userAgent;

      // Parse Chrome version if present
      const chromeMatch = origUserAgent.match(/Chrome\/(\d+)\.(\d+)\.(\d+)\.(\d+)/);
      let modifiedUserAgent = origUserAgent;

      if (chromeMatch) {
        // Modify the patch version (last number) slightly
        const [full, major, minor, build, patch] = chromeMatch;
        const patchNum = parseInt(patch);
        const variation = uaPatchVariation; // -2 to +2, shared with UA-CH
        const newPatch = Math.max(0, patchNum + variation);

        modifiedUserAgent = origUserAgent.replace(
          `Chrome/${major}.${minor}.${build}.${patch}`,
          `Chrome/${major}.${minor}.${build}.${newPatch}`
        );

        log(`[shapeshift][useragent] Modified Chrome version: ${patch} → ${newPatch}`);
      }

      try {
        Object.defineProperty(navigator, 'userAgent', {
          get: function() {
            // Track statistics
            if (globalThis.ssStatsTracker) {
              globalThis.ssStatsTracker.increment('navigatorReads');
            }

            if (globalThis.ssTimingUtils) {
              globalThis.ssTimingUtils.randomDelaySync();
            }
            return modifiedUserAgent;
          },
          enumerable: false,
          configurable: true
        });
        log('[shapeshift][useragent] navigator.userAgent hooked');
      } catch (e) {
        if (debug) console.error('[shapeshift][useragent] Failed to hook userAgent:', e);
      }
    });

    // Hook navigator.appVersion
    safeWrap(() => {
      const origAppVersion = navigator.appVersion;
      const origUserAgent = navigator.userAgent;

      // appVersion is often similar to userAgent
      let modifiedAppVersion = origAppVersion;

      const chromeMatch = origUserAgent.match(/Chrome\/(\d+)\.(\d+)\.(\d+)\.(\d+)/);
      if (chromeMatch) {
        const [full, major, minor, build, patch] = chromeMatch;
        const patchNum = parseInt(patch);
        const variation = uaPatchVariation;
        const newPatch = Math.max(0, patchNum + variation);

        // Apply same modification to appVersion if it contains Chrome version
        if (origAppVersion.includes(`Chrome/${major}.${minor}.${build}.${patch}`)) {
          modifiedAppVersion = origAppVersion.replace(
            `Chrome/${major}.${minor}.${build}.${patch}`,
            `Chrome/${major}.${minor}.${build}.${newPatch}`
          );
        }
      }

      try {
        Object.defineProperty(navigator, 'appVersion', {
          get: function() {
            if (globalThis.ssTimingUtils) {
              globalThis.ssTimingUtils.randomDelaySync();
            }
            return modifiedAppVersion;
          },
          enumerable: false,
          configurable: true
        });
        log('[shapeshift][useragent] navigator.appVersion hooked');
      } catch (e) {
        if (debug) console.error('[shapeshift][useragent] Failed to hook appVersion:', e);
      }
    });

    // Hook navigator.oscpu (Firefox-specific)
    safeWrap(() => {
      if (!navigator.oscpu) return;

      const origOscpu = navigator.oscpu;

      try {
        Object.defineProperty(navigator, 'oscpu', {
          get: function() {
            if (globalThis.ssTimingUtils) {
              globalThis.ssTimingUtils.randomDelaySync();
            }
            // Keep same OS but slight variation
            return origOscpu;
          },
          enumerable: false,
          configurable: true
        });
        log('[shapeshift][useragent] navigator.oscpu hooked');
      } catch (e) {
        // May not be configurable
      }
    });

    // Hook navigator.vendor
    safeWrap(() => {
      const origVendor = navigator.vendor;

      try {
        Object.defineProperty(navigator, 'vendor', {
          get: function() {
            if (globalThis.ssTimingUtils) {
              globalThis.ssTimingUtils.randomDelaySync();
            }
            // Keep same vendor to avoid breaking sites
            return origVendor;
          },
          enumerable: false,
          configurable: true
        });
        log('[shapeshift][useragent] navigator.vendor hooked');
      } catch (e) {
        // May not be configurable
      }
    });

    // Hook navigator.userAgentData (Chromium User-Agent Client Hints API)
    safeWrap(() => {
      if (!navigator.userAgentData) return;

      const origUserAgentData = navigator.userAgentData;

      // Create a proxy to intercept getHighEntropyValues
      const handler = {
        get(target, prop) {
          if (prop === 'getHighEntropyValues') {
            const origMethod = target.getHighEntropyValues;
            return async function(hints) {
              if (globalThis.ssTimingUtils) {
                globalThis.ssTimingUtils.randomDelaySync();
              }

              const values = await origMethod.call(target, hints);

              // Add subtle variations to high entropy values
              if (values.platformVersion) {
                // Modify patch version slightly
                const parts = values.platformVersion.split('.');
                if (parts.length > 0) {
                  const lastPart = parseInt(parts[parts.length - 1]);
                  const variation = uaBuildVariation;
                  parts[parts.length - 1] = Math.max(0, lastPart + variation);
                  values.platformVersion = parts.join('.');
                  log(`[shapeshift][useragent] Modified platformVersion: ${values.platformVersion}`);
                }
              }

              if (values.fullVersionList && Array.isArray(values.fullVersionList)) {
                // Modify Chrome version in the list
                values.fullVersionList = values.fullVersionList.map(item => {
                  if (item.brand && item.brand.includes('Chrome') && item.version) {
                    const parts = item.version.split('.');
                    if (parts.length >= 4) {
                      const patch = parseInt(parts[3]);
                      const variation = uaPatchVariation;
                      parts[3] = Math.max(0, patch + variation);
                      return { ...item, version: parts.join('.') };
                    }
                  }
                  return item;
                });
              }

              return values;
            };
          }

          if (prop === 'brands' && Array.isArray(target.brands)) {
            // Slightly shuffle brand order
            const brands = [...target.brands];
            if (brands.length > 1 && personaRoll('brands') < 0.3) {
              // 30% chance to swap first two
              [brands[0], brands[1]] = [brands[1], brands[0]];
            }
            return brands;
          }

          return target[prop];
        }
      };

      try {
        const proxiedUserAgentData = new Proxy(origUserAgentData, handler);
        Object.defineProperty(navigator, 'userAgentData', {
          get: function() {
            if (globalThis.ssTimingUtils) {
              globalThis.ssTimingUtils.randomDelaySync();
            }
            return proxiedUserAgentData;
          },
          enumerable: false,
          configurable: true
        });
        log('[shapeshift][useragent] navigator.userAgentData hooked');
      } catch (e) {
        if (debug) console.error('[shapeshift][useragent] Failed to hook userAgentData:', e);
      }
    });
  });
})();
