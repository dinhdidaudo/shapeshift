(function () {
  const ready = globalThis.ssReady;
  const installers = globalThis.ssHookInstallers || [];
  const testFingerprint = globalThis.ssTestFingerprint;

  if (!ready || !installers.length) return;

  // The self-test harness is a diagnostic, not a prerequisite: if it failed to
  // load the ISOLATED hooks must still install, otherwise every protected
  // surface silently disappears.
  const runTest = typeof testFingerprint === 'function'
    ? testFingerprint
    : async () => 0;

  ready.then(async env => {
    if (!env) {
      console.log('[shapeshift] Bootstrap returned null - protection disabled or failed');
      return;
    }
    const log = env.config?.debug ? console.log : () => { };

    log('[shapeshift] Starting hook installation...');
    log('[shapeshift] Config:', env.config);
    log('[shapeshift] Installers count:', installers.length);

    const before = await runTest();

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

    const after = await runTest();
    console.log(`ShapeShift applied. Before: ${before} After: ${after}`);
    log("[shapeshift] before", before, "after", after);

    // Clean up globals to hide extension fingerprinting
    if (globalThis.ssStealth && globalThis.ssStealth.cleanupGlobals) {
      globalThis.ssStealth.cleanupGlobals();
    }
  });
})();
