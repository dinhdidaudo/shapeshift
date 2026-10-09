// Bootstrap: load salt, derive seed, initialize PRNG/noise helpers.
(function () {
  // -------------------------------------------------------------------------
  // MAIN-world handshake (P0 1.6 / Security §3).
  //
  // content/page_world_injector.js runs at document_start in the MAIN world and
  // publishes a fresh per-load nonce with SS_PAGE_WORLD_READY. SS_INIT_PAGE_HOOKS
  // is only honoured when it echoes that nonce, which stops a page script from
  // beating the real bootstrap message to the injector's one-shot latch and
  // installing hooks with a seed of its choosing.
  //
  // The listener is registered here, synchronously, because either content
  // script may run first: SS_PAGE_WORLD_HELLO asks the injector to announce
  // again in case its first READY was posted before this listener existed.
  // -------------------------------------------------------------------------
  let ssPageNonce = null;
  // Waiters are resolved by the listener instead of being polled: a 5 ms
  // interval timer ran for the whole (up to 500 ms) window on every page load,
  // and the retry loop below multiplied that by four. That burned CPU for no
  // reason and left a 5 ms timer pattern on the page, which is itself a
  // recognisable extension signal. Resolve on arrival instead.
  let nonceWaiters = [];

  window.addEventListener('message', function (event) {
    if (event.source !== window) return;
    if (event.origin !== location.origin) return;
    if (!event.data || event.data.type !== 'SS_PAGE_WORLD_READY') return;
    if (event.data.protocol !== 1) return;
    if (typeof event.data.nonce !== 'string' || !event.data.nonce) return;
    ssPageNonce = event.data.nonce;
    const waiters = nonceWaiters;
    nonceWaiters = [];
    waiters.forEach(function (resolve) { resolve(ssPageNonce); });
  });

  // Resolves with the nonce, or null when the injector never offered one (for
  // example when its crypto.getRandomValues was unavailable and it therefore
  // does not require a nonce at all).
  function waitForPageNonce (timeoutMs) {
    if (ssPageNonce) return Promise.resolve(ssPageNonce);
    return new Promise(function (resolve) {
      let settled = false;
      const entry = function (value) {
        if (settled) return;
        settled = true;
        const i = nonceWaiters.indexOf(entry);
        if (i !== -1) nonceWaiters.splice(i, 1);
        resolve(value);
      };
      nonceWaiters.push(entry);
      // Ask the injector to re-announce; it answers every HELLO with READY, so
      // whichever side started first, the nonce arrives without polling.
      window.postMessage({ type: 'SS_PAGE_WORLD_HELLO', protocol: 1 }, location.origin);
      setTimeout(function () { entry(ssPageNonce); }, timeoutMs);
    });
  }

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

      // P0 1.4: the nonce handshake must not sit *behind* the asynchronous
      // chrome.storage reads. It used to run after loadConfig()+getSalt(), so
      // the gap between the injector publishing READY at document_start and
      // receiving SS_INIT_PAGE_HOOKS was storage latency + salt latency + the
      // nonce poll. Kick the handshake off first so it overlaps those reads;
      // page inline scripts get real APIs for a strictly shorter window.
      const pageNoncePromise = waitForPageNonce(500);

      // Load stored config first (merges with defaults)
      const config = await loadConfig();

      // Check if current site is whitelisted (protection disabled)
      // P2: optional chaining does NOT protect an undeclared identifier - if
      // `chrome` is undefined (unit tests, non-extension context) `chrome?.x`
      // throws ReferenceError instead of yielding undefined. Guard the name
      // itself, exactly like config.js already does.
      if (typeof chrome !== 'undefined' && chrome?.storage?.local) {
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

        // P1: prng() can legitimately return exactly 0, and Math.log(0) is
        // -Infinity, which made radius Infinity and poisoned the sample (and the
        // spare) with NaN/Infinity. Clamp to the smallest positive double so the
        // transform stays finite; the probability of hitting it is ~2^-32.
        let u1 = prng();
        if (!(u1 > 0)) u1 = Number.MIN_VALUE;
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

      // Independent PRNG per protected surface (P1 2.26): enabling or disabling
      // one module must not shift the values another module reports. Each hook
      // asks for its own stream keyed on (salt, origin, surfaceId); the shared
      // `prng` stays for timing jitter and as a fallback.
      const deriveSurfaceSeed = globalThis.ssDeriveSurfaceSeed;
      const surfaceOrigin = config.perOriginFingerprint ? location.origin : '';
      const prngFor = (surfaceId) => createPRNG(
        deriveSurfaceSeed ? deriveSurfaceSeed(salt, surfaceOrigin, surfaceId) : seed
      );

      const env = { salt, seed, prng, prngFor, noise, gaussianNoise, uniformNoise, config };

      globalThis.ssPRNG = prng;
      globalThis.ssNoise = noise;
      globalThis.ssEnv = env;

      // Send config to page-world injector (MAIN world).
      //
      // A window message is observable by the page, so this channel is not a
      // secret: the injector's one-shot latch, its config whitelist and the
      // per-load nonce echoed below are what stop a page script from
      // re-installing hooks or smuggling extra keys through a forged
      // SS_INIT_PAGE_HOOKS message. `protocol` lets a future release change the
      // payload shape without old injectors acting on a message they do not
      // understand.
      // P0 1.4: the injector refuses SS_INIT_PAGE_HOOKS unless the nonce it
      // published is echoed back. A single 500 ms wait could time out while the
      // injector was still starting, which silently disabled every MAIN-world
      // hook with no retry and no signal. Announce HELLO again and retry before
      // giving up; the injector re-announces READY on every HELLO.
      let pageNonce = await pageNoncePromise;
      for (let attempt = 0; !pageNonce && attempt < 3; attempt++) {
        pageNonce = await waitForPageNonce(500);
      }

      window.postMessage({
        type: 'SS_INIT_PAGE_HOOKS',
        protocol: 1,
        nonce: pageNonce || undefined,
        config: config,
        seed: seed
      }, location.origin);

      if (config.debug) {
        console.log('[shapeshift][bootstrap] page-world nonce:', pageNonce ? 'ok' : 'MISSING');
      }

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
