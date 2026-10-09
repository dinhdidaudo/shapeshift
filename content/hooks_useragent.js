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
    // P1 5.3 (own-property leak): every navigator field below is defined on
    // Navigator.prototype rather than the navigator instance, so
    // Object.getOwnPropertyNames(navigator) stays empty exactly as in real
    // Chrome (and as the MAIN world now does). Defining on the instance was a
    // one-line detector and a cross-world disagreement.
    const navTarget = Object.getPrototypeOf(navigator) || navigator;
    function personaRoll (label) {
      if (!uaHash) return 0.5;
      return uaHash(uaSeed + ':ua:' + label) / 4294967296;
    }
    // The `uaPatchVariation` / `uaBuildVariation` deltas that used to live here
    // were dead once the UA and UA-CH blocks were rebuilt from the shared
    // ':uabuild' pair: they only ever perturbed the REAL build/patch digits,
    // which is exactly the two-world divergence this round removed. Left as
    // unused constants they would be a trap for the next reader.

    // Common platform strings
    // P1: MacPPC and armv7l are PowerPC/32-bit ARM strings that no current
    // Chrome build reports; advertising one is a fingerprint that does not
    // exist in the real population.
    // P2 7.2 (coherent persona): exactly ONE variant per OS family, matching
    // the single string page_world_injector.js advertises. Offering 'Win64' or
    // 'Linux i686' here while MAIN says 'Win32' / 'Linux x86_64' gave the page
    // two different platforms for one machine depending on which world answered.
    const platforms = {
      windows: ['Win32'],
      mac: ['MacIntel'],
      linux: ['Linux x86_64'],
      other: ['Win32'] // Fallback
    };

    // P2 7.2: the OS family is owned by the shared ':persona' pick, the same
    // key page_world_injector.js and hooks_webgl.js use, so platform, UA-CH and
    // the WebGL renderer can never describe three different machines.
    const PERSONA_OS = ['windows', 'mac', 'linux'];
    let platformCategory = 'windows';
    // P2 7.4: an explicit profile pins the family in this world too, so
    // platform, UA-CH and the WebGL renderer stay one machine.
    const pinnedPersona = PERSONA_OS.indexOf(config.persona) !== -1 ? config.persona : null;
    // P1: `origPlatform` used to be declared inside the `else` branch below yet
    // was read by the log line that follows the if/else, so whenever a hash was
    // available (the normal path) this installer threw a ReferenceError before
    // it installed anything - navigator.platform, userAgent, appVersion and
    // userAgentData were all silently left real. Declare it once, up front.
    const origPlatform = navigator.platform;
    if (pinnedPersona) {
      platformCategory = pinnedPersona;
    } else if (uaHash) {
      platformCategory = PERSONA_OS[uaHash(uaSeed + ':persona') % PERSONA_OS.length];
    } else {
      if (origPlatform.includes('Mac')) platformCategory = 'mac';
      else if (origPlatform.includes('Linux')) platformCategory = 'linux';
    }

    // Select the platform variant for that family.
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
        Object.defineProperty(navTarget, 'platform', {
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

    // P1 4.2 (two-world divergence): MAIN rebuilt a full 4-part Chrome version
    // from the seed (major.0.(6000+n).(m)) while this ISOLATED copy merely bumped
    // the real patch number by -2..+2. A page reading navigator in both worlds
    // therefore saw two different build numbers for one machine - a cross-world
    // oracle. Derive the identical build/patch from the identical ':uabuild' key
    // and the same persona platform string as page_world_injector.js.
    //
    // P0 (Cloudflare UA check): the old 6000+(hash%500) / (hash>>>8)%200 pair
    // produced versions like `126.0.6234.187` that have never shipped. Bot
    // management keeps a database of real Chrome releases and binds
    // `cf_clearance` to the exact User-Agent that earned it, so a fabricated
    // build number both fails the plausibility check and invalidates the
    // clearance cookie on the next navigation - the "verify you are human"
    // loop after a rotation. Pick from core/chrome-versions.js instead.
    const uaBuildHash = uaHash ? uaHash(uaSeed + ':uabuild') : 0;
    const pickVersion = globalThis.ssPickChromeVersion;
    const uaVersion = pickVersion
      ? pickVersion(uaBuildHash)
      : { major: '126', minor: '0', build: '6478', patch: '127' };
    const uaBuild = uaVersion.build;
    const uaBuildPatch = uaVersion.patch;

    // Hook navigator.userAgent - rebuild the Chrome version like MAIN does
    safeWrap(() => {
      const origUserAgent = navigator.userAgent;

      // Parse Chrome version if present. P1 4.2: this used to rebuild ONLY when
      // the real UA carried a `Chrome/<4-part>` token and otherwise returned the
      // REAL string, while page_world_injector.js rebuilds unconditionally with a
      // '126' fallback. On a UA-reduced build (Enterprise policy, a Chromium
      // derivative, or a UA with the token stripped) the two worlds therefore
      // answered one read with two different strings - the exact cross-world
      // oracle this pair of hooks exists to remove. Always rebuild, with the same
      // fallback major MAIN uses.
      const chromeMatch = origUserAgent.match(/Chrome\/(\d+)\.(\d+)\.(\d+)\.(\d+)/);
      const realMajor = chromeMatch ? Number(chromeMatch[1]) : null;
      // P0: prefer the picked release's own major, so major/minor/build/patch
      // are one coherent 4-part version. `realMajor` is only the fallback for
      // a UA-reduced build, where navigator.userAgent carries no Chrome token.
      const major = realMajor !== null && realMajor > Number(uaVersion.major)
        ? String(realMajor) : uaVersion.major;
      const platformUa = platformCategory === 'mac'
        ? 'Macintosh; Intel Mac OS X 10_15_7'
        : (platformCategory === 'linux'
          ? 'X11; Linux x86_64'
          : 'Windows NT 10.0; Win64; x64');
      const modifiedUserAgent = 'Mozilla/5.0 (' + platformUa +
        ') AppleWebKit/537.36 (KHTML, like Gecko) Chrome/' +
        major + '.' + uaVersion.minor + '.' + uaBuild + '.' + uaBuildPatch + ' Safari/537.36';

      log('[shapeshift][useragent] Rebuilt Chrome version: ' + major + '.' + uaVersion.minor + '.' + uaBuild + '.' + uaBuildPatch);

      try {
        Object.defineProperty(navTarget, 'userAgent', {
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

      // P1 4.2 (two-world divergence): this used to bump only the patch digit by
      // -2..+2 while the userAgent hook above rewrote the build AND patch to the
      // shared ':uabuild' values. A page reading navigator.userAgent and
      // navigator.appVersion therefore saw two different Chrome builds for one
      // machine - a one-line cross-check. Rebuild appVersion from the SAME
      // uaBuild/uaBuildPatch pair so the two strings can never disagree.
      //
      // The `indexOf(realToken)` guard that used to sit here was dead in
      // practice: Chrome's real appVersion never contains a `Chrome/<v>` token
      // (it is the UA minus the `Mozilla/` prefix), so the branch never ran and
      // appVersion stayed REAL in this world while MAIN advertised the rebuilt
      // string - a two-world oracle on one read. Derive the same string MAIN's
      // `uaGet().replace('Mozilla/', '')` produces, from the same platform and
      // the same ':uabuild' pair.
      // Same unconditional rebuild as the userAgent hook above, for the same
      // reason: a conditional rebuild left appVersion REAL whenever the real UA
      // had no `Chrome/<4-part>` token, while MAIN still advertised the rebuilt
      // string - one read, two answers.
      const chromeMatch = origUserAgent.match(/Chrome\/(\d+)\.(\d+)\.(\d+)\.(\d+)/);
      const realMajor = chromeMatch ? Number(chromeMatch[1]) : null;
      const major = realMajor !== null && realMajor > Number(uaVersion.major)
        ? String(realMajor) : uaVersion.major;
      const platformUa = platformCategory === 'mac'
        ? 'Macintosh; Intel Mac OS X 10_15_7'
        : (platformCategory === 'linux'
          ? 'X11; Linux x86_64'
          : 'Windows NT 10.0; Win64; x64');
      const modifiedAppVersion = '5.0 (' + platformUa +
        ') AppleWebKit/537.36 (KHTML, like Gecko) Chrome/' +
        major + '.' + uaVersion.minor + '.' + uaBuild + '.' + uaBuildPatch + ' Safari/537.36';

      try {
        Object.defineProperty(navTarget, 'appVersion', {
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
        Object.defineProperty(navTarget, 'oscpu', {
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
        Object.defineProperty(navTarget, 'vendor', {
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
    //
    // P1 4.2 (two-world divergence): this block used to PATCH the real values
    // instead of rebuilding the persona's values - it bumped one digit of the
    // real platformVersion, bumped the real fullVersionList patch digit, and
    // exposed the REAL brand list (occasionally swapping two entries). MAIN
    // (page_world_injector.js) replaces the whole hint set with the persona's
    // coherent values, so a page reading navigator.userAgentData in both worlds
    // saw two different machines - and `platform`/`mobile`/`brands` disagreed
    // with the UA string the same world had just spoofed. Rebuild the identical
    // values from the identical (persona, ':uabuild', major) inputs.
    safeWrap(() => {
      if (!navigator.userAgentData) return;

      const origUserAgentData = navigator.userAgentData;
      const majorMatch = /Chrome\/(\d+)/.exec(navigator.userAgent);
      const major = majorMatch ? majorMatch[1] : '126';

      // Same brand triple and order MAIN advertises (Chromium, Google Chrome,
      // Not-A.Brand), with the grease brand pinned to the real '99' version.
      const PERSONA_BRANDS = ['Chromium', 'Google Chrome', 'Not-A.Brand'];
      const brands = PERSONA_BRANDS.map((brand, i) => ({
        brand, version: i === PERSONA_BRANDS.length - 1 ? '99' : major
      }));
      const fullVersionList = brands.map((b) => ({
        brand: b.brand,
        version: b.version === '99'
          ? '99.0.0.0'
          : b.version + '.' + uaVersion.minor + '.' + uaBuild + '.' + uaBuildPatch
      }));
      // OS-derived, like MAIN: a Windows platformVersion string on a macOS or
      // Linux persona is a cross-field contradiction no real Chrome emits.
      const platformVersion = platformCategory === 'windows' ? '10.0.0'
        : (platformCategory === 'mac' ? '10.15.7' : '6.6.0');
      const uaChPlatform = platformCategory === 'mac' ? 'macOS'
        : (platformCategory === 'windows' ? 'Windows' : 'Linux');

      const handler = {
        get(target, prop) {
          if (prop === 'brands') return brands;
          if (prop === 'mobile') return false;
          if (prop === 'platform') return uaChPlatform;

          if (prop === 'getHighEntropyValues') {
            const origMethod = target.getHighEntropyValues;
            return async function(hints) {
              if (globalThis.ssTimingUtils) {
                globalThis.ssTimingUtils.randomDelaySync();
              }

              const values = await origMethod.call(target, hints);
              const out = Object.assign({}, values);
              // Overwrite the whole hint set with the persona's values rather
              // than perturbing the real ones, so UA-CH can never describe a
              // different machine than navigator.userAgent / navigator.platform.
              out.platformVersion = platformVersion;
              out.fullVersionList = fullVersionList;
              out.platform = uaChPlatform;
              out.mobile = false;
              return out;
            };
          }

          const v = target[prop];
          return typeof v === 'function' ? v.bind(target) : v;
        }
      };

      try {
        // P1 identity stability: build the Proxy ONCE. Constructing it inside
        // the getter made `navigator.userAgentData === navigator.userAgentData`
        // false - a one-line oracle, and a divergence from the MAIN world.
        const proxiedUserAgentData = new Proxy(origUserAgentData, handler);
        Object.defineProperty(navTarget, 'userAgentData', {
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
