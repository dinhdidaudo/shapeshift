// Audio fingerprint mutation: add deterministic noise to channel data.
(function () {
  const installers = (globalThis.ssHookInstallers = globalThis.ssHookInstallers || []);

  installers.push(function installAudioHooks (env) {
    if (!env || !env.config?.enableAudioNoise) return;
    const { noise, config } = env;
    const strength = config.audioNoiseStrength ?? 1e-7;
    const seed = (env.seed >>> 0) || 0;

    // Same determinism contract as canvas: repeated getChannelData() on one
    // AudioBuffer must return the same samples, otherwise reading twice is
    // itself the detection signal.
    //
    // P1 (hot loop): this built a fresh string and re-hashed the whole
    // "seed:a:channel:" prefix for every sample - a 16k-sample buffer meant 16k
    // concatenations and ~16k * 20 character folds per read. FNV-1a is a pure
    // sequential fold, so the state after the constant prefix is computed once
    // per channel and only the index digits are folded per sample. The result
    // is byte-identical to the old formula, which keeps existing identities
    // stable across the upgrade.
    const prefixCache = Object.create(null);
    function channelPrefix (channel) {
      let st = prefixCache[channel];
      if (st === undefined) {
        const init = globalThis.ssFnvInit;
        const upd = globalThis.ssFnvUpdate;
        st = (init && upd) ? upd(init(), seed + ':a:' + channel + ':') : null;
        prefixCache[channel] = st;
      }
      return st;
    }

    function sampleNoise (channel, index) {
      const upd = globalThis.ssFnvUpdate;
      const prefix = upd ? channelPrefix(channel) : null;
      if (prefix === null) {
        const hash = globalThis.ssHashString;
        if (!hash) return noise(strength);
        return (((hash(seed + ':a:' + channel + ':' + index)) / 4294967296) - 0.5) * strength;
      }
      // P0: the channel argument was ignored, so getChannelData(0) and
      // getChannelData(1) shared one noise stream. Key on (seed, channel,
      // index) so each channel stays deterministic and distinct, matching
      // the MAIN world formula.
      const h = upd(prefix, index);
      return ((h / 4294967296) - 0.5) * strength;
    }

    function safeWrap (fn) {
      try {
        fn();
      } catch (e) { /* ignore */ }
    }

    safeWrap(() => {
      const AudioBufferProto = window.AudioBuffer && window.AudioBuffer.prototype;
      if (!AudioBufferProto || !AudioBufferProto.getChannelData) return;

      // P1 (double-patch): canvas, fonts, webgl and navigator all guard their
      // install against a second wrap; this installer did not, so a second
      // content-script run (or a re-init) wrapped getChannelData twice and the
      // page could count the wrappers. Guard on the AudioBuffer prototype.
      if (globalThis.ssStealth && globalThis.ssStealth.isPatched(AudioBufferProto)) return;
      if (globalThis.ssStealth) globalThis.ssStealth.markPatched(AudioBufferProto);

      const origGetChannelData = AudioBufferProto.getChannelData;
      AudioBufferProto.getChannelData = function () {
        // Track statistics
        if (globalThis.ssStatsTracker) {
          globalThis.ssStatsTracker.increment('audioCalls');
        }

        // Add timing resistance
        if (globalThis.ssTimingUtils) {
          globalThis.ssTimingUtils.randomDelaySync();
          globalThis.ssTimingUtils.executionJitter();
        }

        const channel = arguments[0] || 0;
        const data = origGetChannelData.apply(this, arguments);
        const copy = new Float32Array(data.length);
        for (let i = 0; i < data.length; i++) {
          copy[i] = data[i] + sampleNoise(channel, i);
        }

        // Add exit jitter
        if (globalThis.ssTimingUtils) {
          globalThis.ssTimingUtils.executionJitter();
        }

        return copy;
      };
    });
  });
})();
