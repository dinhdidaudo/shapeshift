(function () {
  const ready = globalThis.ssReady;
  const installers = globalThis.ssHookInstallers || [];
  const testFingerprint = globalThis.ssTestFingerprint;

  if (!ready || !installers.length || !testFingerprint) return;

  ready.then(async env => {
    if (!env) {
      console.log('[shapeshift] Bootstrap returned null - protection disabled or failed');
      return;
    }
    const log = env.config?.debug ? console.log : () => { };

    log('[shapeshift] Starting hook installation...');
    log('[shapeshift] Config:', env.config);
    log('[shapeshift] Installers count:', installers.length);

    const before = await testFingerprint();

    const tasks = installers.map(fn => {
      try {
        return fn(env);
      } catch (e) {
        // Best-effort; keep page functional
        return null;
      }
    });

    for (const t of tasks) {
      if (t && typeof t.then === "function") {
        try { await t; } catch (e) { /* ignore */ }
      }
    }

    const after = await testFingerprint();
    console.log(`ShapeShift applied. Before: ${before} After: ${after}`);
    log("[shapeshift] before", before, "after", after);

    // Clean up globals to hide extension fingerprinting
    if (globalThis.ssStealth && globalThis.ssStealth.cleanupGlobals) {
      globalThis.ssStealth.cleanupGlobals();
    }
  });
})();
