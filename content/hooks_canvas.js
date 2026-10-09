// Canvas fingerprint mutation using deterministic noise.
(function () {
  const installers = (globalThis.ssHookInstallers = globalThis.ssHookInstallers || []);

  installers.push(function installCanvasHooks (env) {
    if (!env || !env.config?.enableCanvasNoise) return;

    // Default must match core/config.js (canvasNoiseStrength: 2) and the MAIN
    // world injector; a divergent literal here meant the same page received two
    // different noise magnitudes depending on which world read the canvas.
    const noiseStrength = env.config.canvasNoiseStrength ?? 2;
    const noise = env.noise;
    const seed = (env.seed >>> 0) || 0;
    void noise; // kept as the documented fallback source for pixelNoise()

    // Deterministic per-pixel noise. The streaming PRNG advanced on every read,
    // so two getImageData() calls on the same canvas produced different pixels —
    // a page could detect the shim by simply reading twice. Keying the noise on
    // (seed, byte index) keeps the value stable across reads while still varying
    // per origin and per pixel.
    //
    // P1 (hot loop): this concatenated a fresh string and re-folded the whole
    // "<seed>:" prefix for every single byte - a 1920x1080 read meant ~8.3
    // million concatenations and ~90 million character folds on the main thread.
    // FNV-1a is a pure sequential fold, so the state after the constant prefix
    // is computed once and only the index digits are folded per byte. The
    // output is byte-identical to the old formula, so existing identities do
    // not shift.
    const prefixState = (function () {
      const init = globalThis.ssFnvInit;
      const upd = globalThis.ssFnvUpdate;
      if (!init || !upd) return null;
      return upd(init(), seed + ':');
    })();

    function pixelNoise (index) {
      const upd = globalThis.ssFnvUpdate;
      if (!upd || prefixState === null) {
        const hash = globalThis.ssHashString;
        if (!hash) return noise(noiseStrength);
        return (((hash(seed + ':' + index)) / 4294967296) - 0.5) * noiseStrength;
      }
      const h = upd(prefixState, index);
      return ((h / 4294967296) - 0.5) * noiseStrength;
    }

    function safeWrap (fn) {
      try {
        fn();
      } catch (e) {
        // Best-effort; avoid breaking the page
      }
    }

    safeWrap(() => {
      // P1: this installer had no ssStealth guard at all, so a second install
      // (or a second content-script run) re-wrapped every entry point and the
      // page could count the wrappers. Guard both prototypes that get patched.
      const canvasProto = HTMLCanvasElement.prototype;
      const ctxProto = CanvasRenderingContext2D.prototype;
      if (globalThis.ssStealth) {
        if (globalThis.ssStealth.isPatched(canvasProto)) return;
        globalThis.ssStealth.markPatched(canvasProto);
        globalThis.ssStealth.markPatched(ctxProto);
      }

      const origToDataURL = canvasProto.toDataURL;
      const origToBlob = canvasProto.toBlob;
      const origGetImageData = ctxProto.getImageData;
      const origGetContext = canvasProto.getContext;

      // P1 (page-state hygiene): toDataURL()/toBlob() used to call
      // this.getContext("2d") purely to read pixels back. On a canvas the page
      // never used as 2d that CREATES a 2d context as a side effect of merely
      // exporting, and on a canvas whose context was created with other
      // attributes it logs a warning. Remember which canvases really do have a
      // 2d context and only perturb those.
      const twoDContexts = new WeakSet();
      canvasProto.getContext = function (type) {
        const ctx = origGetContext.apply(this, arguments);
        if (ctx && type === '2d') twoDContexts.add(this);
        return ctx;
      };

      function noisedImageData (ctx, x, y, w, h) {
        // Track statistics
        if (globalThis.ssStatsTracker) {
          globalThis.ssStatsTracker.increment('canvasReads');
        }

        // Add timing resistance
        if (globalThis.ssTimingUtils) {
          globalThis.ssTimingUtils.randomDelaySync();
          globalThis.ssTimingUtils.executionJitter();
        }

        const imgData = origGetImageData.call(ctx, x, y, w, h);
        const data = imgData.data;
        for (let i = 0; i < data.length; i += 4) {
          data[i] += pixelNoise(i);
          data[i + 1] += pixelNoise(i + 1);
          data[i + 2] += pixelNoise(i + 2);
        }

        // Add exit jitter
        if (globalThis.ssTimingUtils) {
          globalThis.ssTimingUtils.executionJitter();
        }

        return imgData;
      }

      ctxProto.getImageData = function (x, y, w, h) {
        return noisedImageData(this, x, y, w, h);
      };

      // Snapshot / noised copy / export / restore. Writing the noised pixels
      // straight back into the backing store permanently mutated the canvas, so
      // every subsequent toDataURL()/toBlob() stacked noise on top of the last
      // one and the drawn canvas drifted away from what the page painted.
      function noisedCopyOf (ctx, width, height) {
        const original = origGetImageData.call(ctx, 0, 0, width, height);
        const copy = ctx.createImageData(original.width, original.height);
        copy.data.set(original.data);
        for (let i = 0; i < copy.data.length; i += 4) {
          copy.data[i] += pixelNoise(i);
          copy.data[i + 1] += pixelNoise(i + 1);
          copy.data[i + 2] += pixelNoise(i + 2);
        }
        return { original: original, noised: copy };
      }

      canvasProto.toDataURL = function () {
        let ctx = null;
        let snapshot = null;
        try {
          if (globalThis.ssStatsTracker) {
            globalThis.ssStatsTracker.increment('canvasReads');
          }
          // Only read back from a canvas that already has a 2d context; see
          // the twoDContexts note above. Passing willReadFrequently here would
          // also silently switch an existing canvas to software rendering.
          if (twoDContexts.has(this)) ctx = origGetContext.call(this, '2d');
          if (ctx && origGetImageData) {
            snapshot = noisedCopyOf(ctx, this.width, this.height);
            ctx.putImageData(snapshot.noised, 0, 0);
          }
        } catch (e) { /* ignore */ }
        try {
          return origToDataURL.apply(this, arguments);
        } finally {
          if (ctx && snapshot) {
            try { ctx.putImageData(snapshot.original, 0, 0); } catch (e) { /* ignore */ }
          }
        }
      };

      canvasProto.toBlob = function () {
        const args = arguments;
        // P1: the pending 2d context and the pristine ImageData used to be
        // stashed on the canvas element itself as `__ssCtx` / `__ssSnapshot`.
        // That made them enumerable own properties of a DOM node the page can
        // walk (`Object.keys(canvas)`), and two overlapping toBlob calls on the
        // same canvas overwrote each other's stash, so the second callback
        // restored the wrong snapshot. Keep both in this call's closure.
        let pendingCtx = null;
        let pendingSnapshot = null;
        function restore () {
          if (pendingCtx && pendingSnapshot) {
            try { pendingCtx.putImageData(pendingSnapshot, 0, 0); } catch (e) { /* ignore */ }
          }
          pendingCtx = null;
          pendingSnapshot = null;
        }
        try {
          if (globalThis.ssStatsTracker) {
            globalThis.ssStatsTracker.increment('canvasReads');
          }
          const ctx = twoDContexts.has(this) ? origGetContext.call(this, '2d') : null;
          if (ctx && origGetImageData) {
            const snapshot = noisedCopyOf(ctx, this.width, this.height);
            pendingCtx = ctx;
            pendingSnapshot = snapshot.original;
            ctx.putImageData(snapshot.noised, 0, 0);
          }
        } catch (e) { /* ignore */ }
        // toBlob is asynchronous: the backing store must stay noised until the
        // encoder has read it, then be restored in the callback.
        const wrappedCallback = typeof args[0] === 'function'
          ? function (blob) { restore(); return args[0](blob); }
          : undefined;
        try {
          return wrappedCallback
            ? origToBlob.call(this, wrappedCallback, args[1])
            : origToBlob.apply(this, args);
        } catch (e) {
          restore();
          throw e;
        }
      };
    });
  });
})();
