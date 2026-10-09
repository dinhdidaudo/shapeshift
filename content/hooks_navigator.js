// Navigator property masking with deterministic fuzz.
(function () {
  const installers = (globalThis.ssHookInstallers = globalThis.ssHookInstallers || []);

  installers.push(function installNavigatorHooks (env) {
    if (!env || !env.config?.enableNavigatorFuzz) return;
    // P2 (5.2): every other surface guards against a second install; this one
    // did not, so a re-run re-defined the same accessors and left two stacked
    // timing wrappers on navigator. Skip when this object is already patched.
    if (globalThis.ssStealth && globalThis.ssStealth.isPatched(navigator)) return;
    if (globalThis.ssStealth) globalThis.ssStealth.markPatched(navigator);
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
        // P1 5.3 (own-property leak): a shadow defined on the navigator
        // INSTANCE shows up in Object.getOwnPropertyNames(navigator), while
        // real Chrome keeps hardwareConcurrency/deviceMemory/languages as
        // accessors on Navigator.prototype and the instance owns nothing.
        // Define on the prototype so the own-property list stays empty.
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
      // Every navigator field belongs on Navigator.prototype, not on the
      // instance (see defineGetter's own-property note below).
      const navTarget = Object.getPrototypeOf(nav) || nav;

      // P1 (default mismatch): every branch used a truthy test, so an absent
      // config key meant "off" here while the MAIN world treats absent as "on"
      // (`!== false`). A fresh install with no stored config therefore got the
      // fuzz in one world and the real value in the other - a one-line oracle.
      // Both worlds now share the same opt-out semantics.
      // P1 (world split): MAIN used `max(2, real + (hash % 5) - 2)` while this
      // side used a +/-1 choice table, so the same page read two different core
      // counts depending on which world answered. Use the MAIN formula verbatim.
      if (navCfg.fuzzHardwareConcurrency !== false && typeof nav.hardwareConcurrency === "number") {
        const base = nav.hardwareConcurrency;
        const h = globalThis.ssHashString;
        const variant = h
          ? Math.max(2, base + (h(navSeed + ':nav:cores') % 5) - 2)
          : base;
        defineGetter(navTarget, "hardwareConcurrency", () => variant);
      }

      if (navCfg.fuzzDeviceMemory !== false && typeof nav.deviceMemory === "number") {
        const baseMem = nav.deviceMemory;
        const h = globalThis.ssHashString;
        const pick = h
          ? Math.max(4, baseMem + (h(navSeed + ':nav:memory') % 5) - 2)
          : baseMem;
        defineGetter(navTarget, "deviceMemory", () => pick);
      }

      if (navCfg.shuffleLanguages !== false && Array.isArray(nav.languages)) {
        const langs = nav.languages.slice();
        if (langs.length > 1) {
          const offset = Math.floor(navRoll('langorder') * langs.length) % langs.length;
          const rotated = langs.slice(offset).concat(langs.slice(0, offset));
          defineGetter(navTarget, "languages", () => rotated);
        } else {
          defineGetter(navTarget, "languages", () => langs.slice());
        }
      }
    });
  });
})();
