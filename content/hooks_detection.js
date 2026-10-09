// Detection resistance for ad blockers, extensions, and incognito mode.
// Protects against various detection techniques used to identify extensions and privacy tools.
(function () {
  const installers = (globalThis.ssHookInstallers = globalThis.ssHookInstallers || []);

  installers.push(function installDetectionResistanceHooks (env) {
    if (!env || !env.config?.enableDetectionResistance) return;
    const prng = env.prngFor ? env.prngFor('detection') : env.prng;
    const { config } = env;
    const debug = config.debug ? true : false;
    const log = debug ? console.log : () => {};

    function safeWrap (fn) {
      try {
        fn();
      } catch (e) {
        if (debug) console.error('[shapeshift][detection] Hook failed:', e);
      }
    }

    // Prevent FileSystem API quota checks (incognito detection)
    safeWrap(() => {
      if (!navigator.webkitTemporaryStorage && !navigator.webkitPersistentStorage) return;

      // Hook quota queries that can detect incognito mode
      if (navigator.webkitTemporaryStorage && navigator.webkitTemporaryStorage.queryUsageAndQuota) {
        const origQuery = navigator.webkitTemporaryStorage.queryUsageAndQuota;

        if (globalThis.ssStealth && !globalThis.ssStealth.isPatched(origQuery)) {
          globalThis.ssStealth.markPatched(origQuery);

          navigator.webkitTemporaryStorage.queryUsageAndQuota = function(successCallback, errorCallback) {
            if (globalThis.ssTimingUtils) {
              globalThis.ssTimingUtils.randomDelaySync();
            }

            log('[shapeshift][detection] queryUsageAndQuota called');

            // Wrap success callback to normalize quota values
            const wrappedSuccess = function(usedBytes, grantedBytes) {
              // Normalize quota to appear as normal browsing
              // Incognito typically has lower quota
              const normalizedGranted = Math.max(grantedBytes, 1024 * 1024 * 1024); // At least 1GB
              const normalizedUsed = Math.floor(usedBytes + (prng() * 1024 * 1024)); // Add some random usage

              log(`[shapeshift][detection] Normalized quota: ${grantedBytes} → ${normalizedGranted}`);

              if (successCallback) {
                successCallback(normalizedUsed, normalizedGranted);
              }
            };

            return origQuery.call(this, wrappedSuccess, errorCallback);
          };

          log('[shapeshift][detection] webkitTemporaryStorage.queryUsageAndQuota hooked');
        }
      }
    });

    // Prevent IndexedDB quota detection (incognito detection)
    safeWrap(() => {
      if (!navigator.storage || !navigator.storage.estimate) return;

      const origEstimate = navigator.storage.estimate;
      if (globalThis.ssStealth && !globalThis.ssStealth.isPatched(origEstimate)) {
        globalThis.ssStealth.markPatched(origEstimate);

        navigator.storage.estimate = async function() {
          if (globalThis.ssTimingUtils) {
            globalThis.ssTimingUtils.randomDelaySync();
          }

          const estimate = await origEstimate.call(this);

          // Normalize quota to appear as normal mode
          // Incognito mode often has restricted quota
          if (estimate.quota && estimate.quota < 1024 * 1024 * 1024) {
            estimate.quota = Math.floor(10 * 1024 * 1024 * 1024 + (prng() * 1024 * 1024 * 1024)); // 10-11 GB
            log(`[shapeshift][detection] Normalized storage quota to ${(estimate.quota / 1024 / 1024 / 1024).toFixed(2)} GB`);
          }

          // Add some random usage
          if (estimate.usage !== undefined) {
            estimate.usage = Math.floor(estimate.usage + (prng() * 100 * 1024 * 1024)); // Add 0-100 MB
          }

          return estimate;
        };

        log('[shapeshift][detection] navigator.storage.estimate hooked');
      }
    });

    // Hook permissions API (extension/privacy tool detection)
    safeWrap(() => {
      if (!navigator.permissions || !navigator.permissions.query) return;

      const origQuery = navigator.permissions.query;
      if (globalThis.ssStealth && !globalThis.ssStealth.isPatched(origQuery)) {
        globalThis.ssStealth.markPatched(origQuery);

        navigator.permissions.query = async function(permissionDesc) {
          if (globalThis.ssTimingUtils) {
            globalThis.ssTimingUtils.randomDelaySync();
          }

          log(`[shapeshift][detection] permissions.query called for ${JSON.stringify(permissionDesc)}`);

          // Call original
          const result = await origQuery.call(this, permissionDesc);

          // Add timing jitter
          if (globalThis.ssTimingUtils) {
            globalThis.ssTimingUtils.executionJitter();
          }

          return result;
        };

        log('[shapeshift][detection] navigator.permissions.query hooked');
      }
    });

    // P1 2.12: the chrome.runtime object visible here belongs to the ISOLATED
    // content-script world. A page script cannot observe it, so wrapping
    // sendMessage protected nothing while adding an artificial delay to every
    // internal message - including the stats_tracker UPDATE_STATS flush that
    // wakes the service worker. Removed entirely rather than slowed down.

    // Prevent navigator.webdriver detection (automation detection)
    safeWrap(() => {
      try {
        // Always set webdriver to false/undefined
        Object.defineProperty(navigator, 'webdriver', {
          get: function() {
            if (globalThis.ssTimingUtils) {
              globalThis.ssTimingUtils.randomDelaySync();
            }
            return false;
          },
          enumerable: true,
          configurable: true
        });
        log('[shapeshift][detection] navigator.webdriver hooked');
      } catch (e) {
        // May already be defined
      }
    });

    // chrome.app / chrome.loadTimes / chrome.csi are page-world globals. An
    // ISOLATED content script sees a *different* `window.chrome` object, so
    // deleting them here changed nothing the page could observe while giving a
    // false sense of protection. The MAIN-world injector owns that surface.

    // Error.prototype.stack is deliberately NOT overridden any more. Patching a
    // global prototype that every error path in every page uses cost real
    // performance and risked breaking frameworks' stack parsing for a marginal
    // gain. Extension URLs are never exposed to the page world in the first
    // place, so there was nothing to redact from a page-visible stack.

    // Prevent resource timing detection (ad blocker detection via blocked requests)
    safeWrap(() => {
      if (!window.performance || !window.performance.getEntriesByType) return;

      const origGetEntriesByType = window.performance.getEntriesByType;
      if (globalThis.ssStealth && !globalThis.ssStealth.isPatched(origGetEntriesByType)) {
        globalThis.ssStealth.markPatched(origGetEntriesByType);

        window.performance.getEntriesByType = function(type) {
          if (globalThis.ssTimingUtils) {
            globalThis.ssTimingUtils.randomDelaySync();
          }

          const entries = origGetEntriesByType.call(this, type);

          // Sites check for missing resources to detect ad blockers
          // We don't modify this (would be complex), just add timing resistance
          return entries;
        };

        log('[shapeshift][detection] performance.getEntriesByType hooked');
      }
    });

    // Hook document.hidden and visibilityState (tab focus detection for behavior tracking)
    safeWrap(() => {
      const origHidden = Object.getOwnPropertyDescriptor(Document.prototype, 'hidden');
      const origVisibilityState = Object.getOwnPropertyDescriptor(Document.prototype, 'visibilityState');

      if (origHidden && origHidden.get) {
        const origHiddenGetter = origHidden.get;

        Object.defineProperty(Document.prototype, 'hidden', {
          get: function() {
            if (globalThis.ssTimingUtils) {
              globalThis.ssTimingUtils.executionJitter();
            }
            return origHiddenGetter.call(this);
          },
          enumerable: true,
          configurable: true
        });
      }

      if (origVisibilityState && origVisibilityState.get) {
        const origVisibilityStateGetter = origVisibilityState.get;

        Object.defineProperty(Document.prototype, 'visibilityState', {
          get: function() {
            if (globalThis.ssTimingUtils) {
              globalThis.ssTimingUtils.executionJitter();
            }
            return origVisibilityStateGetter.call(this);
          },
          enumerable: true,
          configurable: true
        });
      }

      log('[shapeshift][detection] document.hidden and visibilityState hooked with timing resistance');
    });
  });
})();
