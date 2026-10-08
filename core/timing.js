// Timing utilities to prevent timing attack detection.
// Adds random micro-delays and execution path variations to make
// hook operations timing-resistant.
(function () {
  let prng = null;
  // Timing jitter is OFF by default (P1 2.14). It is invoked from every hooked
  // getter (123 call sites), so leaving it on made each property read do extra
  // work for a signal a site can average out anyway. Opt in with
  // config.timingJitter = true when you are specifically testing timing.
  let jitterEnabled = false;

  // Initialize with PRNG after bootstrap
  function initTimingUtils(prngFunction) {
    prng = prngFunction;
    const config = globalThis.ssConfig || {};
    jitterEnabled = config.timingJitter === true;
  }

  // Add random micro-delay (0-5ms) to prevent timing measurements
  async function randomDelay() {
    if (!prng || !jitterEnabled) return;
    const delay = Math.floor(prng() * 5); // 0-5ms
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
