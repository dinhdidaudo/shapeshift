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
    function sampleNoise (index) {
      const hash = globalThis.ssHashString;
      if (!hash) return noise(strength);
      const h = hash(seed + ':a:' + index);
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

        const data = origGetChannelData.apply(this, arguments);
        const copy = new Float32Array(data.length);
        for (let i = 0; i < data.length; i++) {
          copy[i] = data[i] + sampleNoise(i);
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
