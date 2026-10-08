// Media codec and DRM capabilities protection.
// Protects against media codec enumeration and DRM capability fingerprinting.
(function () {
  const installers = (globalThis.ssHookInstallers = globalThis.ssHookInstallers || []);

  installers.push(function installMediaHooks (env) {
    if (!env || !env.config?.enableMediaProtection) return;
    const prng = env.prngFor ? env.prngFor('media') : env.prng;
    const { config } = env;
    const debug = config.debug ? true : false;
    const log = debug ? console.log : () => {};

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

          // Randomly change "maybe" to "probably" or vice versa (10% chance)
          // This adds noise without breaking functionality
          if (prng() < 0.1) {
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
          const nonCriticalCodecs = ['av01', 'vp9', 'opus'];
          const isNonCritical = nonCriticalCodecs.some(codec => type.includes(codec));

          if (isNonCritical && prng() < 0.05) {
            log(`[shapeshift][media] isTypeSupported: Flipped result for ${type}`);
            return !result;
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

          // Add subtle variations to the results
          // Occasionally flip powerEfficient (10% chance)
          if (prng() < 0.1 && info.powerEfficient !== undefined) {
            info.powerEfficient = !info.powerEfficient;
            log('[shapeshift][media] decodingInfo: Flipped powerEfficient');
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
          enumerable: true,
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

          const result = origIsTypeSupported.call(this, type);

          // Add very rare flips for uncommon formats (5% chance)
          const uncommonFormats = ['video/av1', 'audio/opus'];
          if (uncommonFormats.some(fmt => type.includes(fmt)) && prng() < 0.05) {
            log(`[shapeshift][media] MediaRecorder.isTypeSupported: Flipped for ${type}`);
            return !result;
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

          // Shuffle codec order slightly (deterministic)
          if (capabilities && capabilities.codecs && capabilities.codecs.length > 1) {
            const codecs = [...capabilities.codecs];

            // Swap two random codecs
            const idx1 = Math.floor(prng() * codecs.length);
            const idx2 = Math.floor(prng() * codecs.length);
            [codecs[idx1], codecs[idx2]] = [codecs[idx2], codecs[idx1]];

            capabilities.codecs = codecs;
            log(`[shapeshift][media] RTCRtpSender.getCapabilities: Shuffled codec order for ${kind}`);
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

          // Shuffle codec order slightly
          if (capabilities && capabilities.codecs && capabilities.codecs.length > 1) {
            const codecs = [...capabilities.codecs];

            const idx1 = Math.floor(prng() * codecs.length);
            const idx2 = Math.floor(prng() * codecs.length);
            [codecs[idx1], codecs[idx2]] = [codecs[idx2], codecs[idx1]];

            capabilities.codecs = codecs;
            log(`[shapeshift][media] RTCRtpReceiver.getCapabilities: Shuffled codec order for ${kind}`);
          }

          return capabilities;
        };

        log('[shapeshift][media] RTCRtpReceiver.getCapabilities hooked');
      }
    });
  });
})();
