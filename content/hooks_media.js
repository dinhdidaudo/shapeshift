// Media codec and DRM capabilities protection.
// Protects against media codec enumeration and DRM capability fingerprinting.
(function () {
  const installers = (globalThis.ssHookInstallers = globalThis.ssHookInstallers || []);

  installers.push(function installMediaHooks (env) {
    if (!env || !env.config?.enableMediaProtection) return;
    const { config } = env;
    const debug = config.debug ? true : false;
    const log = debug ? console.log : () => {};

    // P1 2.2: capability answers must be stable for a given input. The old code
    // drew from a streaming PRNG on every call, so canPlayType('...') could
    // answer "maybe" on one call and "probably" on the next — a trivial detect
    // signal, and a real hazard for a player that picks a codec from the first
    // answer. Derive the decision from (seed, input) instead.
    const seed = (env.seed >>> 0) || 0;
    const hashString = globalThis.ssHashString;
    function stableRoll (label, input) {
      if (!hashString) return 1; // never flip when the hash is unavailable
      return hashString(seed + ':' + label + ':' + String(input)) / 4294967296;
    }

    function safeWrap (fn) {
      try {
        fn();
      } catch (e) {
        if (debug) console.error('[shapeshift][media] Hook failed:', e);
      }
    }

    // Hook HTMLMediaElement.canPlayType
    safeWrap(() => {
      if (!HTMLMediaElement.prototype.canPlayType) return;

      const origCanPlayType = HTMLMediaElement.prototype.canPlayType;
      if (globalThis.ssStealth && !globalThis.ssStealth.isPatched(origCanPlayType)) {
        globalThis.ssStealth.markPatched(origCanPlayType);

        HTMLMediaElement.prototype.canPlayType = function(type) {
          // Track statistics
          if (globalThis.ssStatsTracker) {
            globalThis.ssStatsTracker.increment('mediaCodecReads');
          }

          if (globalThis.ssTimingUtils) {
            globalThis.ssTimingUtils.randomDelaySync();
            globalThis.ssTimingUtils.executionJitter();
          }

          const result = origCanPlayType.call(this, type);

          // Deterministically change "maybe" to "probably" or vice versa for
          // ~10% of (type) inputs. Same input -> same answer, every call.
          if (stableRoll('canplay', type) < 0.1) {
            if (result === 'maybe') {
              log(`[shapeshift][media] canPlayType: Changed "maybe" to "probably" for ${type}`);
              return 'probably';
            } else if (result === 'probably') {
              log(`[shapeshift][media] canPlayType: Changed "probably" to "maybe" for ${type}`);
              return 'maybe';
            }
          }

          return result;
        };

        log('[shapeshift][media] HTMLMediaElement.canPlayType hooked');
      }
    });

    // Hook MediaSource.isTypeSupported
    safeWrap(() => {
      if (!window.MediaSource || !MediaSource.isTypeSupported) return;

      const origIsTypeSupported = MediaSource.isTypeSupported;
      if (globalThis.ssStealth && !globalThis.ssStealth.isPatched(origIsTypeSupported)) {
        globalThis.ssStealth.markPatched(origIsTypeSupported);

        MediaSource.isTypeSupported = function(type) {
          if (globalThis.ssTimingUtils) {
            globalThis.ssTimingUtils.randomDelaySync();
            globalThis.ssTimingUtils.executionJitter();
          }

          const result = origIsTypeSupported.call(this, type);

          // Very rarely flip the result for less common codecs (5% chance)
          // Only for codecs that are not critical for most sites
          // P0: `type` is caller-controlled and may be a Symbol or an object with
          // a throwing toString; calling .includes() on it threw TypeError where
          // the native method would simply return false. Coerce defensively.
          const typeStr = typeof type === 'string' ? type : String(type);
          const nonCriticalCodecs = ['av01', 'vp9', 'opus'];
          const isNonCritical = nonCriticalCodecs.some(codec => typeStr.includes(codec));

          // P1: only ever upgrade "unsupported" to "supported", never the
          // reverse. Reporting a codec the browser really can decode as
          // unsupported makes the player fall back to a worse format (or
          // fail), while the opposite merely keeps the page on a format it
          // can already handle. Keyed on the type string so repeat calls agree.
          if (result === false && isNonCritical && stableRoll('mstype', typeStr) < 0.05) {
            log(`[shapeshift][media] isTypeSupported: reported supported for ${typeStr}`);
            return true;
          }

          return result;
        };

        log('[shapeshift][media] MediaSource.isTypeSupported hooked');
      }
    });

    // Hook MediaCapabilities API
    safeWrap(() => {
      if (!navigator.mediaCapabilities || !navigator.mediaCapabilities.decodingInfo) return;

      const origDecodingInfo = navigator.mediaCapabilities.decodingInfo;
      if (globalThis.ssStealth && !globalThis.ssStealth.isPatched(origDecodingInfo)) {
        globalThis.ssStealth.markPatched(origDecodingInfo);

        navigator.mediaCapabilities.decodingInfo = async function(configuration) {
          if (globalThis.ssTimingUtils) {
            globalThis.ssTimingUtils.randomDelaySync();
          }

          const info = await origDecodingInfo.call(this, configuration);

          // Add subtle variations to the results.
          // Deterministic per configuration so two decodingInfo() calls for the
          // same input agree (10% of inputs flip).
          //
          // P1: `info` is the object the UA handed back and may be a cached or
          // shared instance, so flipping a field on it leaked the change into
          // every later caller (and into the page's own reads of the same
          // configuration). Copy it first, exactly like the MAIN-world hook.
          if (stableRoll('power', JSON.stringify(configuration)) < 0.1 && info.powerEfficient !== undefined) {
            const copy = Object.assign({}, info);
            copy.powerEfficient = !copy.powerEfficient;
            log('[shapeshift][media] decodingInfo: Flipped powerEfficient');
            return copy;
          }

          // Keep supported and smooth as-is to avoid breaking playback
          return info;
        };

        log('[shapeshift][media] navigator.mediaCapabilities.decodingInfo hooked');
      }
    });

    // Hook Encrypted Media Extensions (EME) - DRM capabilities
    safeWrap(() => {
      if (!navigator.requestMediaKeySystemAccess) return;

      const origRequestMediaKeySystemAccess = navigator.requestMediaKeySystemAccess;
      if (globalThis.ssStealth && !globalThis.ssStealth.isPatched(origRequestMediaKeySystemAccess)) {
        globalThis.ssStealth.markPatched(origRequestMediaKeySystemAccess);

        navigator.requestMediaKeySystemAccess = function(keySystem, supportedConfigurations) {
          // Track statistics
          if (globalThis.ssStatsTracker) {
            globalThis.ssStatsTracker.increment('drmReads');
          }

          if (globalThis.ssTimingUtils) {
            globalThis.ssTimingUtils.randomDelaySync();
          }

          log(`[shapeshift][media] requestMediaKeySystemAccess called for ${keySystem}`);

          // Don't modify behavior, just add timing resistance and logging
          // Modifying DRM can break video playback
          return origRequestMediaKeySystemAccess.call(this, keySystem, supportedConfigurations);
        };

        log('[shapeshift][media] navigator.requestMediaKeySystemAccess hooked');
      }
    });

    // Hook AudioContext sample rate (audio fingerprinting)
    safeWrap(() => {
      if (!window.AudioContext && !window.webkitAudioContext) return;

      const OrigAudioContext = window.AudioContext || window.webkitAudioContext;
      const origSampleRate = Object.getOwnPropertyDescriptor(
        OrigAudioContext.prototype,
        'sampleRate'
      );

      if (!origSampleRate) return;

      // P1 (double-patch): this getter had no ssStealth guard, so a second
      // install (or a second content-script run) re-wrapped it and the page
      // could count the wrappers. The getter reads through `origSampleRate`,
      // captured above, so marking the ORIGINAL getter is what stops a re-wrap
      // from stacking on top of this one.
      if (globalThis.ssStealth && origSampleRate.get && globalThis.ssStealth.isPatched(origSampleRate.get)) return;
      if (globalThis.ssStealth && origSampleRate.get) globalThis.ssStealth.markPatched(origSampleRate.get);

      try {
        Object.defineProperty(OrigAudioContext.prototype, 'sampleRate', {
          get: function() {
            if (globalThis.ssTimingUtils) {
              globalThis.ssTimingUtils.randomDelaySync();
            }

            const realRate = origSampleRate.get.call(this);

            // Common sample rates: 44100, 48000
            // Don't change to avoid breaking audio, but add timing resistance
            return realRate;
          },
          enumerable: false,
          configurable: true
        });

        log('[shapeshift][media] AudioContext.sampleRate hooked');
      } catch (e) {
        // May fail if non-configurable
      }
    });

    // Hook MediaRecorder to add timing resistance
    safeWrap(() => {
      if (!window.MediaRecorder || !MediaRecorder.isTypeSupported) return;

      const origIsTypeSupported = MediaRecorder.isTypeSupported;
      if (globalThis.ssStealth && !globalThis.ssStealth.isPatched(origIsTypeSupported)) {
        globalThis.ssStealth.markPatched(origIsTypeSupported);

        MediaRecorder.isTypeSupported = function(type) {
          if (globalThis.ssTimingUtils) {
            globalThis.ssTimingUtils.randomDelaySync();
          }

          // P0: `type` is caller-controlled and may be a Symbol or an object with
          // a throwing toString; calling .includes() on it threw TypeError where
          // the native method would simply return false. Coerce defensively.
          const typeStr = typeof type === 'string' ? type : String(type);
          const result = origIsTypeSupported.call(this, type);

          // Add very rare flips for uncommon formats (5% chance)
          const uncommonFormats = ['video/av1', 'audio/opus'];
          // P1: same rule as MediaSource - only upgrade absence to presence, so
          // a format the recorder really supports is never hidden.
          if (result === false &&
              uncommonFormats.some(fmt => typeStr.includes(fmt)) &&
              stableRoll('rectype', typeStr) < 0.05) {
            log(`[shapeshift][media] MediaRecorder.isTypeSupported: reported supported for ${typeStr}`);
            return true;
          }

          return result;
        };

        log('[shapeshift][media] MediaRecorder.isTypeSupported hooked');
      }
    });

    // Hook RTCRtpSender.getCapabilities (WebRTC codec fingerprinting)
    safeWrap(() => {
      if (!window.RTCRtpSender || !RTCRtpSender.getCapabilities) return;

      const origGetCapabilities = RTCRtpSender.getCapabilities;
      if (globalThis.ssStealth && !globalThis.ssStealth.isPatched(origGetCapabilities)) {
        globalThis.ssStealth.markPatched(origGetCapabilities);

        RTCRtpSender.getCapabilities = function(kind) {
          if (globalThis.ssTimingUtils) {
            globalThis.ssTimingUtils.randomDelaySync();
          }

          const capabilities = origGetCapabilities.call(this, kind);

          // P1 2.3: the swap used to be drawn from a streaming PRNG on every
          // call and applied to the object the native method returned, so two
          // getCapabilities('video') calls disagreed and the shared native
          // result was mutated in place. Swap a private copy, indexed from
          // (seed, kind) so the order is stable across calls.
          if (capabilities && capabilities.codecs && capabilities.codecs.length > 1) {
            const codecs = capabilities.codecs.slice();
            const roll = stableRoll('rtp-sender', kind || '');
            const idx1 = Math.floor(roll * codecs.length);
            const idx2 = (idx1 + 1 + Math.floor(roll * 997) % (codecs.length - 1)) % codecs.length;
            [codecs[idx1], codecs[idx2]] = [codecs[idx2], codecs[idx1]];

            const copy = Object.assign({}, capabilities);
            copy.codecs = codecs;
            log(`[shapeshift][media] RTCRtpSender.getCapabilities: Shuffled codec order for ${kind}`);
            return copy;
          }

          return capabilities;
        };

        log('[shapeshift][media] RTCRtpSender.getCapabilities hooked');
      }
    });

    // Hook RTCRtpReceiver.getCapabilities
    safeWrap(() => {
      if (!window.RTCRtpReceiver || !RTCRtpReceiver.getCapabilities) return;

      const origGetCapabilities = RTCRtpReceiver.getCapabilities;
      if (globalThis.ssStealth && !globalThis.ssStealth.isPatched(origGetCapabilities)) {
        globalThis.ssStealth.markPatched(origGetCapabilities);

        RTCRtpReceiver.getCapabilities = function(kind) {
          if (globalThis.ssTimingUtils) {
            globalThis.ssTimingUtils.randomDelaySync();
          }

          const capabilities = origGetCapabilities.call(this, kind);

          // Same fix as the sender above: copy, then swap deterministically.
          if (capabilities && capabilities.codecs && capabilities.codecs.length > 1) {
            const codecs = capabilities.codecs.slice();
            const roll = stableRoll('rtp-receiver', kind || '');
            const idx1 = Math.floor(roll * codecs.length);
            const idx2 = (idx1 + 1 + Math.floor(roll * 997) % (codecs.length - 1)) % codecs.length;
            [codecs[idx1], codecs[idx2]] = [codecs[idx2], codecs[idx1]];

            const copy = Object.assign({}, capabilities);
            copy.codecs = codecs;
            log(`[shapeshift][media] RTCRtpReceiver.getCapabilities: Shuffled codec order for ${kind}`);
            return copy;
          }

          return capabilities;
        };

        log('[shapeshift][media] RTCRtpReceiver.getCapabilities hooked');
      }
    });
  });
})();
