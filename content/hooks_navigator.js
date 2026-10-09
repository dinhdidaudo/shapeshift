// Navigator property masking with deterministic fuzz.
(function () {
  const installers = (globalThis.ssHookInstallers = globalThis.ssHookInstallers || []);

  installers.push(function installNavigatorHooks (env) {
    if (!env || !env.config?.enableNavigatorFuzz) return;
    // P1: these draws used the streaming PRNG, so hardwareConcurrency,
    // deviceMemory and the language order changed on every load while the rest
    // of the persona stayed put. Key them on the seed instead.
    const navSeed = (env.seed >>> 0) || 0;
    const navRoll = (field) => {
      const h = globalThis.ssHashString;
      if (!h) return 0.5;
      return h(navSeed + ':nav:' + field) / 4294967296;
    };
    const { config } = env;
    const navCfg = config.navigator || {};

    function safeWrap (fn) {
      try {
        fn();
      } catch (e) { /* ignore */ }
    }

    function defineGetter (obj, prop, getter) {
      try {
        // Wrap getter with timing resistance
        const resistantGetter = function() {
          // Track statistics
          if (globalThis.ssStatsTracker) {
            globalThis.ssStatsTracker.increment('navigatorReads');
          }

          if (globalThis.ssTimingUtils) {
            globalThis.ssTimingUtils.randomDelaySync();
            globalThis.ssTimingUtils.executionJitter();
          }
          return getter.call(this);
        };

        // configurable: true so a later stage (re-init, another surface) can
        // redefine the property. A non-configurable descriptor here permanently
        // blocked every other hook from touching the same navigator field.
        // P1: the native navigator accessors are non-enumerable; an enumerable
        // shadow surfaces in Object.keys(navigator) and is a one-line oracle.
        Object.defineProperty(obj, prop, {
          get: resistantGetter,
          configurable: true,
          enumerable: false
        });
      } catch (e) {
        // Some props may be non-configurable
      }
    }

    safeWrap(() => {
      const nav = window.navigator;

      if (navCfg.fuzzHardwareConcurrency && typeof nav.hardwareConcurrency === "number") {
        const base = nav.hardwareConcurrency;
        const choices = [Math.max(1, base - 1), base, base + 1];
        const variant = choices[
          Math.floor(navRoll('cores') * choices.length) % choices.length];
        defineGetter(navigator, "hardwareConcurrency", () => variant);
      }

      if (navCfg.fuzzDeviceMemory && typeof nav.deviceMemory === "number") {
        const baseMem = nav.deviceMemory;
        const options = [Math.max(1, baseMem - 1), baseMem, baseMem + 1];
        const pick = options[
          Math.floor(navRoll('memory') * options.length) % options.length];
        defineGetter(navigator, "deviceMemory", () => pick);
      }

      if (navCfg.shuffleLanguages && Array.isArray(nav.languages)) {
        const langs = nav.languages.slice();
        if (langs.length > 1) {
          const offset = Math.floor(navRoll('langorder') * langs.length) % langs.length;
          const rotated = langs.slice(offset).concat(langs.slice(0, offset));
          defineGetter(navigator, "languages", () => rotated);
        } else {
          defineGetter(navigator, "languages", () => langs.slice());
        }
      }
    });
  });
})();
