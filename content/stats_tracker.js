// Statistics tracker for content scripts
// Batches statistics updates and sends them to the background script

(function () {
  'use strict';

  // Local counters (batched before sending)
  const localStats = {
    canvasReads: 0,
    webglCalls: 0,
    audioCalls: 0,
    navigatorReads: 0,
    webrtcCalls: 0,
    screenReads: 0,
    fontReads: 0,
    timezoneReads: 0,
    sensorReads: 0,
    mediaCodecReads: 0,
    drmReads: 0,
    geolocationReads: 0,
    touchReads: 0
  };

  let flushTimeout = null;
  // P2: 2 s per tab meant 20 open tabs sent 10 messages/s, each waking the
  // service worker for a storage read-modify-write. 15 s keeps the counters
  // useful while cutting the wakeups by ~7x; beforeunload still flushes.
  const FLUSH_INTERVAL = 15000;

  // Increment a statistic counter.
  // P1: `localStats.hasOwnProperty(...)` breaks when the object has no
  // prototype (or when a page shadows the method); the call form is the one
  // that is safe on every object.
  function increment(category) {
    if (Object.prototype.hasOwnProperty.call(localStats, category)) {
      localStats[category]++;
      scheduleFlush();
    }
  }

  // Schedule a flush of statistics to background
  function scheduleFlush() {
    if (flushTimeout) return; // Already scheduled

    flushTimeout = setTimeout(() => {
      flushStats();
      flushTimeout = null;
    }, FLUSH_INTERVAL);
  }

  // Flush statistics to background script
  function flushStats() {
    // P2: a pending timer used to survive the flush, so a page that flushed
    // on pagehide/unload still left a 15 s timeout scheduled against a dead
    // context. Cancel it here - this is the single place a flush happens.
    if (flushTimeout) {
      clearTimeout(flushTimeout);
      flushTimeout = null;
    }

    // Check if there are any updates to send
    const hasUpdates = Object.values(localStats).some(count => count > 0);
    if (!hasUpdates) return;

    // Create a copy of current stats. The counters are NOT zeroed yet: the old
    // order reset them before sendMessage, so a rejected send (service worker
    // restarting, extension reloading) silently discarded the whole batch.
    const statsToSend = { ...localStats };
    const clearCounters = () => {
      Object.keys(statsToSend).forEach(key => {
        if (localStats[key] === statsToSend[key]) localStats[key] = 0;
      });
    };

    // Send to background
    try {
      const sent = chrome.runtime.sendMessage({
        type: 'UPDATE_STATS',
        data: statsToSend
      });
      if (sent && typeof sent.then === 'function') {
        sent.then(clearCounters).catch(error => {
          // Keep the counters so the next flush retries them.
          if (globalThis.ssConfig?.debug) {
            console.warn('[shapeshift][stats] Failed to send stats:', error);
          }
        });
      } else {
        // Callback-style API with no promise: assume delivery.
        clearCounters();
      }
    } catch (error) {
      // Keep the counters; the extension context may just be reloading.
      if (globalThis.ssConfig?.debug) {
        console.warn('[shapeshift][stats] Failed to send stats:', error);
      }
    }
  }

  // Flush on page unload. P2: `beforeunload` is unreliable on mobile and is
  // skipped entirely in the back/forward cache path, so the last batch of
  // counters was routinely dropped. `pagehide` fires in every teardown path
  // (including bfcache) and is the event spec recommends for exactly this.
  window.addEventListener('beforeunload', () => {
    flushStats();
  });
  window.addEventListener('pagehide', () => {
    flushStats();
  });

  // P2 (§7.1): the MAIN world cannot call ssStatsTracker directly - it is a
  // different world with its own global object - so page_world_injector.js
  // reports its reads as SS_STAT window messages. Fold them into the same
  // counters the ISOLATED hooks use, so a canvas read performed by a page
  // script that only ever touches the MAIN-world patched prototype is still
  // counted. Only the fixed category label crosses the boundary, and it is
  // validated against localStats before it is applied.
  window.addEventListener('message', function (event) {
    if (event.source !== window) return;
    if (event.origin !== location.origin) return;
    const data = event.data;
    if (!data || data.type !== 'SS_STAT' || data.protocol !== 1) return;
    increment(data.category);
  });

  // Export to global scope
  globalThis.ssStatsTracker = {
    increment,
    flush: flushStats
  };
})();
