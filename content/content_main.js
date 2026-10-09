(function () {
  const ready = globalThis.ssReady;
  const installers = globalThis.ssHookInstallers || [];
  const testFingerprint = globalThis.ssTestFingerprint;

  if (!ready || !installers.length) return;

  // P0 1.2/1.3: the self-test used to run on EVERY page load and sample the
  // ISOLATED world (canvas/audio/navigator), which is not what the page sees -
  // it produced a "Before/After" pair that proved nothing while costing two
  // full fingerprint sweeps per load. It is diagnostic output, so it is now
  // opt-in behind the debug flag; in normal browsing the sampler is never
  // called and the page-visible DOM/console surface stays untouched.
  const runTest = typeof testFingerprint === 'function'
    ? testFingerprint
    : async () => 0;
  // The sampler is only invoked under the debug flag. Passing a no-op keeps the
  // call sites below simple without paying for two fingerprint sweeps a load.

  ready.then(async env => {
    if (!env) {
      // Deliberately silent: bootstrap can legitimately return null when the
      // origin is paused, and a console line here leaked the extension to the
      // page on every load.
      return;
    }
    const log = env.config?.debug ? console.log : () => { };

    log('[shapeshift] Starting hook installation...');
    log('[shapeshift] Config:', env.config);
    log('[shapeshift] Installers count:', installers.length);

    // P0 1.2/1.3: sampling only happens in debug mode. The Before/After pair
    // measured the ISOLATED world, not what the page sees, so it was never a
    // real safety signal - just two extra fingerprint sweeps per page load.
    const sampler = env.config?.debug ? runTest : async () => 0;
    const before = await sampler();

    // Installers are independent surfaces. One throwing must not stop the rest,
    // but it must not vanish either: a silent failure used to look identical to
    // a hook that was switched off in Settings. Count failures and always report
    // them, regardless of the debug flag.
    let failed = 0;
    const tasks = installers.map(fn => {
      try {
        return fn(env);
      } catch (e) {
        failed++;
        console.error('[shapeshift] Hook installer failed:', e);
        return null;
      }
    });

    for (const t of tasks) {
      if (t && typeof t.then === "function") {
        try { await t; } catch (e) {
          failed++;
          console.error('[shapeshift] Async hook installer failed:', e);
        }
      }
    }

    if (failed > 0) {
      console.warn(`[shapeshift] ${failed} of ${installers.length} hook installers failed`);
    }

    // P2: a failed installer used to be visible only in the console. Report the
    // count to the service worker so it can raise the toolbar badge and the
    // Diagnostics pane can show it without the user opening devtools. This is a
    // runtime message, not a page-visible signal, so it cannot fingerprint the
    // extension. Best-effort: a missing receiver must never break installation.
    try {
      if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
        const report = chrome.runtime.sendMessage({
          type: 'HOOK_STATUS',
          failed: failed,
          total: installers.length,
          origin: location.origin
        });
        if (report && typeof report.catch === 'function') report.catch(() => {});
      }
    } catch (e) {
      // Diagnostics are optional; installation already succeeded.
    }

    const after = await sampler();
    // P0 1.3: this used to run unconditionally, so every page load wrote a
    // ShapeShift banner to the console that any page script could observe by
    // wrapping console.log. It is diagnostic output, so it belongs behind the
    // debug flag like every other log in this file.
    log(`[shapeshift] applied. Before: ${before} After: ${after}`);

    // Clean up globals to hide extension fingerprinting
    if (globalThis.ssStealth && globalThis.ssStealth.cleanupGlobals) {
      globalThis.ssStealth.cleanupGlobals();
    }
  });

  // Feature 7.3 (self-test surface): the Options diagnostics button asks the
  // active tab to sample every surface on demand, instead of the user digging
  // the composite hash out of the console. The listener lives in the ISOLATED
  // world, so the page can neither see nor call it, and it answers with the
  // per-surface digests plus warnings for surfaces the sampler could not reach
  // on this tab (no WebGL, no Web Audio, ...).
  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
      if (!message || message.type !== 'SS_RUN_SELF_TEST') return;
      const report = globalThis.ssTestFingerprintReport;
      if (typeof report !== 'function') {
        sendResponse({ success: false, error: 'self-test not available' });
        return true;
      }
      Promise.resolve()
        .then(report)
        .then(function (r) { sendResponse({ success: true, report: r }); })
        .catch(function (e) { sendResponse({ success: false, error: String((e && e.message) || e) }); });
      return true; // keep the channel open for the async reply
    });
  }
})();
