// WebGL fingerprint mutation: jitter numeric params and mask vendor strings.
(function () {
  const installers = (globalThis.ssHookInstallers = globalThis.ssHookInstallers || []);

  installers.push(function installWebGLHooks (env) {
    if (!env || !env.config?.enableWebGLMasking) return;
    const { config, seed } = env;

    // P1 2.1: the vendor suffix must be stable across reads. It used to be
    // drawn from a streaming PRNG, so two getParameter(VENDOR) calls returned
    // two different strings - a one-line detector. Key it on (seed, param,
    // value) instead, exactly like canvas/audio already do.
    const hashString = globalThis.ssHashString;
    function stableSuffix (param, value) {
      if (!hashString) return 1;
      return (hashString(((seed >>> 0) || 0) + ':webgl:' + param + ':' + value) % 0xFFFF) || 1;
    }
    const jitter = config.webglJitter ?? 1;
    const maskVendors = config.maskWebGLVendorStrings !== false;
    const shuffleExt = config.shuffleWebGLExtensions !== false;
    const debug = config.debug ? true : false;
    const log = debug ? console.log : () => {};

    function patchSelf (proto) {
      if (!proto || !proto.getParameter) return;
      const origGetParameter = proto.getParameter;
      // Use stealth tracking instead of __ss_patched
      if (globalThis.ssStealth && globalThis.ssStealth.isPatched(origGetParameter)) return;
      if (globalThis.ssStealth) globalThis.ssStealth.markPatched(origGetParameter);

      proto.getParameter = function (p) {
        // Track statistics
        if (globalThis.ssStatsTracker) {
          globalThis.ssStatsTracker.increment('webglCalls');
        }

        // Add timing resistance
        if (globalThis.ssTimingUtils) {
          globalThis.ssTimingUtils.randomDelaySync();
          globalThis.ssTimingUtils.executionJitter();
        }

        const value = origGetParameter.call(this, p);

        if (typeof value === "number") {
          const delta = jitter || 1;
          const out = value + delta;
          log("[shapeshift][webgl][cs] jitter", p, "base", value, "delta", delta, "out", out);
          return out;
        }

        const gl = this;
        const vendorParams = [
          gl.VENDOR,
          gl.RENDERER,
          gl.UNMASKED_VENDOR_WEBGL,
          gl.UNMASKED_RENDERER_WEBGL
        ].filter(Boolean);

        if (maskVendors && vendorParams.includes(p) && typeof value === "string") {
          const suffix = stableSuffix(p, value);
          const out = value + " (fp-" + suffix + ")";
          log("[shapeshift][webgl][cs] vendor", value, "->", out);
          return out;
        }

        return value;
      };

      if (proto.getSupportedExtensions && shuffleExt) {
        const origGetSupportedExtensions = proto.getSupportedExtensions;
        if (!globalThis.ssStealth || !globalThis.ssStealth.isPatched(origGetSupportedExtensions)) {
          if (globalThis.ssStealth) globalThis.ssStealth.markPatched(origGetSupportedExtensions);
          proto.getSupportedExtensions = function () {
            const list = origGetSupportedExtensions.call(this);
            if (Array.isArray(list)) {
              const reversed = list.slice().reverse();
              log("[shapeshift][webgl][cs] extensions", reversed);
              return reversed;
            }
            return list;
          };
        }
      }

      log("[shapeshift][webgl][cs] patched", proto.constructor && proto.constructor.name);
    }

    // Patch content-script world so testFingerprint (which runs here) sees changes.
    try {
      if (window.WebGLRenderingContext) patchSelf(WebGLRenderingContext.prototype);
      if (window.WebGL2RenderingContext) patchSelf(WebGL2RenderingContext.prototype);
    } catch (e) { /* ignore */ }

    // The page world is patched once, by content/page_world_injector.js in the
    // MAIN world. This installer used to also inject content/webgl_page_patch.js
    // into the page context, which wrapped the *same* prototypes a second time:
    // numeric parameters were jittered twice and vendor strings received two
    // suffixes. That duplicate script also forced a second entry into
    // web_accessible_resources, widening the extension's detectable surface.
    // patchSelf() above is still needed: the ISOLATED world has its own
    // WebGLRenderingContext prototypes, which page_world_injector.js cannot
    // reach, and content/test_fingerprint.js samples them from this world.
  });
})();
