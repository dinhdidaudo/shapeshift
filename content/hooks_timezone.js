// Timezone and locale protection.
// Protects against timezone and locale fingerprinting by spoofing timezone NAME only.
// IMPORTANT: Does NOT modify getTimezoneOffset() to avoid breaking time-based functionality.
(function () {
  const installers = (globalThis.ssHookInstallers = globalThis.ssHookInstallers || []);

  installers.push(function installTimezoneHooks (env) {
    if (!env || !env.config?.enableTimezoneProtection) return;
    const { config } = env;
    const debug = config.debug ? true : false;
    const log = debug ? console.log : () => {};

    function safeWrap (fn) {
      try {
        fn();
      } catch (e) {
        if (debug) console.error('[shapeshift][timezone] Hook failed:', e);
      }
    }

    // Get the REAL timezone offset (don't modify this!)
    const realOffset = new Date().getTimezoneOffset();

    // Map of UTC offsets to IANA timezone identifiers
    // Grouped by offset so we can pick a different zone with the SAME offset
    // NOTE: getTimezoneOffset() returns POSITIVE for zones BEHIND UTC (e.g., PST = 480)
    //       and NEGATIVE for zones AHEAD of UTC (e.g., China = -480)
    const timezonesByOffset = {
      '720': ['Pacific/Wake', 'Pacific/Wallis'],
      '660': ['Pacific/Midway', 'Pacific/Niue', 'Pacific/Pago_Pago'],
      '600': ['Pacific/Honolulu', 'Pacific/Rarotonga', 'Pacific/Tahiti'],
      '570': ['Pacific/Marquesas'],
      '540': ['America/Anchorage', 'America/Juneau', 'America/Nome', 'America/Sitka', 'America/Yakutat'],
      '480': ['America/Los_Angeles', 'America/Vancouver', 'America/Tijuana', 'America/Dawson', 'America/Whitehorse'],
      '420': ['America/Denver', 'America/Phoenix', 'America/Edmonton', 'America/Hermosillo', 'America/Chihuahua', 'America/Mazatlan'],
      '360': ['America/Chicago', 'America/Mexico_City', 'America/Regina', 'America/Winnipeg', 'America/Guatemala', 'America/Belize'],
      '300': ['America/New_York', 'America/Toronto', 'America/Havana', 'America/Panama', 'America/Lima', 'America/Bogota'],
      '240': ['America/Caracas', 'America/Halifax', 'America/Santiago', 'America/La_Paz', 'America/Manaus'],
      '210': ['America/St_Johns'],
      '180': ['America/Sao_Paulo', 'America/Argentina/Buenos_Aires', 'America/Montevideo', 'America/Godthab'],
      '120': ['Atlantic/South_Georgia'],
      '60': ['Atlantic/Azores', 'Atlantic/Cape_Verde'],
      '0': ['Europe/London', 'Europe/Dublin', 'Europe/Lisbon', 'Africa/Casablanca', 'Atlantic/Reykjavik', 'UTC'],
      '-60': ['Europe/Paris', 'Europe/Berlin', 'Europe/Rome', 'Europe/Madrid', 'Europe/Brussels', 'Europe/Amsterdam', 'Europe/Stockholm', 'Africa/Lagos'],
      '-120': ['Europe/Athens', 'Europe/Helsinki', 'Europe/Kiev', 'Africa/Cairo', 'Asia/Jerusalem', 'Europe/Bucharest', 'Africa/Johannesburg'],
      '-180': ['Europe/Moscow', 'Asia/Baghdad', 'Asia/Riyadh', 'Africa/Nairobi', 'Asia/Kuwait'],
      '-210': ['Asia/Tehran'],
      '-240': ['Asia/Dubai', 'Asia/Baku', 'Asia/Tbilisi', 'Asia/Muscat'],
      '-270': ['Asia/Kabul'],
      '-300': ['Asia/Karachi', 'Asia/Tashkent', 'Asia/Yekaterinburg'],
      '-330': ['Asia/Kolkata', 'Asia/Colombo'],
      '-345': ['Asia/Kathmandu'],
      '-360': ['Asia/Dhaka', 'Asia/Almaty', 'Asia/Omsk'],
      '-390': ['Asia/Yangon'],
      '-420': ['Asia/Bangkok', 'Asia/Jakarta', 'Asia/Ho_Chi_Minh'],
      '-480': ['Asia/Shanghai', 'Asia/Hong_Kong', 'Asia/Singapore', 'Asia/Taipei', 'Asia/Manila', 'Australia/Perth'],
      '-540': ['Asia/Tokyo', 'Asia/Seoul', 'Asia/Pyongyang'],
      '-570': ['Australia/Adelaide', 'Australia/Darwin'],
      '-600': ['Australia/Sydney', 'Australia/Melbourne', 'Australia/Brisbane', 'Pacific/Guam'],
      '-630': ['Australia/Lord_Howe'],
      '-660': ['Pacific/Noumea', 'Pacific/Guadalcanal'],
      '-720': ['Pacific/Auckland', 'Pacific/Fiji'],
      '-780': ['Pacific/Tongatapu', 'Pacific/Apia']
    };

    // P0 1.5: a zone only stays internally consistent when its offset matches
    // the real one on EVERY date the page might probe, not just today. Two
    // zones can share a winter offset yet differ in DST rules
    // (America/Phoenix vs America/Denver); resolvedOptions().timeZone would
    // then contradict getTimezoneOffset() and formatter.format() half the
    // year. Filter candidates on today AND ~6 months out, exactly like the
    // MAIN-world injector does.
    function zoneOffsetMinutes (zone, date) {
      try {
        const dtf = new Intl.DateTimeFormat('en-US', {
          timeZone: zone, hour12: false,
          year: 'numeric', month: '2-digit', day: '2-digit',
          hour: '2-digit', minute: '2-digit', second: '2-digit'
        });
        const parts = dtf.formatToParts(date);
        const m = {};
        for (let i = 0; i < parts.length; i++) {
          if (parts[i].type !== 'literal') m[parts[i].type] = parts[i].value;
        }
        const asUTC = Date.UTC(+m.year, +m.month - 1, +m.day, +m.hour, +m.minute, +m.second);
        return Math.round((asUTC - date.getTime()) / 60000);
      } catch (e) {
        return null;
      }
    }

    const offsetKey = String(realOffset);
    const candidates = timezonesByOffset[offsetKey] || [];
    const realZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const sampleA = new Date();
    const sampleB = new Date(Date.now() + 182 * 24 * 60 * 60 * 1000);
    const realA = zoneOffsetMinutes(realZone, sampleA);
    const realB = zoneOffsetMinutes(realZone, sampleB);
    const availableZones = candidates.filter(function (z) {
      return zoneOffsetMinutes(z, sampleA) === realA &&
             zoneOffsetMinutes(z, sampleB) === realB;
    });

    let spoofedTimezone = null;

    if (availableZones.length > 0) {
      // P1: this used to draw from the streaming PRNG, so the same page got a
      // different zone on every load while getTimezoneOffset() stayed real -
      // a rotating zone is itself a fingerprint. Key the pick on (seed, offset)
      // so it is stable per origin and changes only when the origin does.
      const tzHash = globalThis.ssHashString;
      const tzSeed = (env.seed >>> 0) || 0;
      const pick = tzHash
        ? tzHash(tzSeed + ':tz:' + offsetKey) % availableZones.length
        : 0;
      spoofedTimezone = availableZones[pick];
      log(`[shapeshift][timezone] Real offset: ${realOffset}, Spoofed timezone: ${spoofedTimezone}`);
    } else {
      log(`[shapeshift][timezone] No alternative timezones for offset ${realOffset}, protection disabled`);
      return; // Can't spoof safely, skip this protection
    }

    // DO NOT HOOK getTimezoneOffset() - it must return the real offset!
    // This ensures calendars, time pickers, and time-based functionality work correctly.

    // Hook Intl.DateTimeFormat to return spoofed timezone name
    safeWrap(() => {
      const OrigDateTimeFormat = Intl.DateTimeFormat;
      if (globalThis.ssStealth && !globalThis.ssStealth.isPatched(OrigDateTimeFormat)) {
        globalThis.ssStealth.markPatched(OrigDateTimeFormat);

        Intl.DateTimeFormat = function () {
          const formatter = new OrigDateTimeFormat(...arguments);
          const origResolvedOptions = formatter.resolvedOptions;

          formatter.resolvedOptions = function () {
            // Track statistics
            if (globalThis.ssStatsTracker) {
              globalThis.ssStatsTracker.increment('timezoneReads');
            }

            if (globalThis.ssTimingUtils) {
              globalThis.ssTimingUtils.randomDelaySync();
            }

            const options = origResolvedOptions.call(this);
            // Only spoof the timezone name, offset remains unchanged
            options.timeZone = spoofedTimezone;
            return options;
          };

          return formatter;
        };

        // Preserve the full static surface (supportedLocalesOf, formatRange,
        // formatRangeToParts, ...) and the prototype chain. Copying only
        // supportedLocalesOf dropped every other static method, which is itself
        // a detectable inconsistency against the real Intl.DateTimeFormat.
        Object.setPrototypeOf(Intl.DateTimeFormat, OrigDateTimeFormat);
        Intl.DateTimeFormat.prototype = OrigDateTimeFormat.prototype;

        log('[shapeshift][timezone] Intl.DateTimeFormat hooked');
      }
    });

    // Date.prototype.toLocaleString / toLocaleDateString / toLocaleTimeString
    // are deliberately NOT overridden any more. Injecting a timeZone into every
    // call rewrote date and time formatting for the whole page (calendars, time
    // pickers, log output), and it contradicted the getTimezoneOffset() contract
    // this file already relies on: the real offset stays real, so the formatted
    // wall-clock time must stay real too. The zone NAME exposed through
    // Intl.DateTimeFormat().resolvedOptions() is the surface that is spoofed.
  });
})();
