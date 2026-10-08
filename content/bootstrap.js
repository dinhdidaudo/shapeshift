// Bootstrap: load salt, derive seed, initialize PRNG/noise helpers.
(function () {
  const readyPromise = (async () => {
    try {
      const getSalt = globalThis.ssGetSalt;
      const loadConfig = globalThis.ssLoadConfig;
      const deriveSeed = globalThis.ssDeriveSeed;
      const hashString = globalThis.ssHashString;
      const createPRNG = globalThis.ssCreatePRNG;

      if (!getSalt || !deriveSeed || !hashString || !createPRNG || !loadConfig) {
        throw new Error("Fingerprint bootstrap missing prerequisites");
      }

      // Load stored config first (merges with defaults)
      const config = await loadConfig();

      // Check if current site is whitelisted (protection disabled)
      if (chrome?.storage?.local) {
        try {
          const siteResult = await new Promise((resolve) => {
            chrome.storage.local.get(['ss_site_settings'], (result) => {
              resolve(result);
            });
          });

          const siteSettings = siteResult.ss_site_settings || {};
          const currentOrigin = location.origin;
          const siteSetting = siteSettings[currentOrigin];

          if (siteSetting && siteSetting.enabled === false) {
            if (config.debug) {
              console.log('[shapeshift][bootstrap] Protection disabled for this site (whitelisted)');
            }
            return null; // Skip hook installation
          }
        } catch (e) {
          // Continue with protection if whitelist check fails
          if (config.debug) {
            console.error('[shapeshift][bootstrap] Failed to check whitelist:', e);
          }
        }
      }

      const salt = await getSalt();
      const baseSeed = hashString(String(salt));
      const seed = config.perOriginFingerprint ? deriveSeed(salt, location.origin) : baseSeed;
      const prng = createPRNG(seed);

      // Uniform noise distribution
      const uniformNoise = (scale = 1) => (prng() - 0.5) * scale;

      // Gaussian/Normal noise distribution (Box-Muller transform)
      // More natural and harder to detect statistically
      let spareGaussian = null;
      const gaussianNoise = (mean = 0, stddev = 1) => {
        if (spareGaussian !== null) {
          const value = spareGaussian;
          spareGaussian = null;
          return mean + stddev * value;
        }

        const u1 = prng();
        const u2 = prng();
        const radius = Math.sqrt(-2 * Math.log(u1));
        const theta = 2 * Math.PI * u2;

        spareGaussian = radius * Math.sin(theta);
        return mean + stddev * (radius * Math.cos(theta));
      };

      // Choose noise function based on config
      const noise = config.useGaussianNoise
        ? (scale = 1) => gaussianNoise(0, scale)
        : uniformNoise;

      // Initialize timing utilities with PRNG for timing attack resistance
      if (globalThis.ssTimingUtils) {
        globalThis.ssTimingUtils.init(prng);
      }

      const env = { salt, seed, prng, noise, gaussianNoise, uniformNoise, config };

      globalThis.ssPRNG = prng;
      globalThis.ssNoise = noise;
      globalThis.ssEnv = env;

      // Send config to page-world injector (MAIN world)
      // The page-world injector needs config and seed to initialize hooks
      window.postMessage({
        type: 'SS_INIT_PAGE_HOOKS',
        config: config,
        seed: seed
      }, '*');

      if (config.debug) {
        console.log('[shapeshift][bootstrap] Sent config to page-world injector');
      }

      return env;
    } catch (e) {
      // Fail closed: do not break the page if bootstrap fails.
      return null;
    }
  })();

  globalThis.ssReady = readyPromise;
})();
