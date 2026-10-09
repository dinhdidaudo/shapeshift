// Timing utilities to prevent timing attack detection.
// Adds random micro-delays and execution path variations to make
// hook operations timing-resistant.
(function () {
  let prng = null;
  // Timing jitter is OFF by default (P1 2.14). It is invoked from every hooked
  // getter (123 call sites), so leaving it on made each property read do extra
  // work for a signal a site can average out anyway. Opt in through Options.
  let jitterEnabled = false;
  // The configured magnitude, in milliseconds. Options renders `timingJitter`
  // as a 0-20 slider and the schema default is the NUMBER 0.
  let jitterMs = 0;

  // Initialize with PRNG after bootstrap
  function initTimingUtils(prngFunction) {
    prng = prngFunction;
    const config = globalThis.ssConfig || {};
    // P1 (feature completely dead): the schema default is a number
    // (`timingJitter: 0`, rendered as a 0-20 slider) while the old check used
    // `=== true`, so the slider could never turn the feature on - every value
    // except the boolean `true` was read as "off". Accept either a boolean
    // `true` from a hand-edited config or a positive number from the slider,
    // and remember the magnitude so the delay is not a hard-coded 5 ms.
    const raw = config.timingJitter;
    const ms = raw === true ? 5 : Number(raw);
    jitterMs = Number.isFinite(ms) ? Math.min(20, Math.max(0, ms)) : 0;
    jitterEnabled = jitterMs > 0;
  }

  // Add random micro-delay (0..jitterMs) to prevent timing measurements
  async function randomDelay() {
    if (!prng || !jitterEnabled) return;
    const delay = Math.floor(prng() * (jitterMs + 1));
    if (delay > 0) {
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  // Synchronous jitter for hot synchronous code paths.
  // Deliberately does NOT busy-wait on the clock: blocking the main thread for
  // up to 2 ms on every getter read is a larger timing signal (and a jank
  // source) than the jitter it was meant to hide.
  function randomDelaySync() {
    if (!prng || !jitterEnabled) return;
    const iterations = Math.floor(prng() * 32);
    let dummy = 0;
    for (let i = 0; i < iterations; i++) {
      dummy += i & 1;
    }
    return dummy;
  }

  // Add random execution path jitter
  function executionJitter() {
    if (!prng || !jitterEnabled) return;
    // Perform random number of no-op operations
    const iterations = Math.floor(prng() * 10);
    let dummy = 0;
    for (let i = 0; i < iterations; i++) {
      dummy += Math.sqrt(i + 1);
    }
    return dummy; // Return to prevent optimization
  }

  // Wrap a function with timing resistance
  function timingResistant(fn, async = false) {
    if (async) {
      return async function (...args) {
        await randomDelay();
        executionJitter();
        const result = await fn.apply(this, args);
        await randomDelay();
        return result;
      };
    } else {
      return function (...args) {
        randomDelaySync();
        executionJitter();
        const result = fn.apply(this, args);
        return result;
      };
    }
  }

  // Expose globally for hook modules
  globalThis.ssTimingUtils = {
    init: initTimingUtils,
    randomDelay,
    randomDelaySync,
    executionJitter,
    timingResistant
  };
})();
