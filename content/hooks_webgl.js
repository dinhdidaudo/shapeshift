// WebGL fingerprint mutation: jitter numeric params and mask vendor strings.
(function () {
  const installers = (globalThis.ssHookInstallers = globalThis.ssHookInstallers || []);

  installers.push(function installWebGLHooks (env) {
    if (!env || !env.config?.enableWebGLMasking) return;
    const { config, seed } = env;

    // P1 2.1: every read must be stable. Two getParameter(VENDOR) calls used to
    // return two different strings because the value was drawn from a streaming
    // PRNG - a one-line detector. All derivations below are keyed on
    // (seed, param, value) instead, exactly like canvas/audio already do.
    //
    // The `stableSuffix(param, value)` helper that used to sit here was dead
    // code: no call site ever invoked it, and it hashed a different key
    // (`:webgl:`) than the live jitter path (`:wgl:`), so it could only ever
    // have re-introduced a divergence from the MAIN world. Removed rather than
    // left as a trap.
    const hashString = globalThis.ssHashString;
    // Must match page_world_injector.js (webglJitter ?? 2). A divergent default
    // made the two worlds perturb by different magnitudes.
    const jitter = config.webglJitter ?? 2;
    const maskVendors = config.maskWebGLVendorStrings !== false;
    const shuffleExt = config.shuffleWebGLExtensions !== false;
    const debug = config.debug ? true : false;
    const log = debug ? console.log : () => {};

    // Parameters whose exact value IS the fingerprint (hardware limits).
    const INTEGER_LIMIT_PARAMS = new Set([
      0x0D33 /* MAX_TEXTURE_SIZE */, 0x851C /* MAX_3D_TEXTURE_SIZE */,
      0x8073 /* MAX_ARRAY_TEXTURE_LAYERS */, 0x8869 /* MAX_VERTEX_ATTRIBS */,
      0x8B4D /* MAX_COMBINED_UNIFORM_BLOCKS */, 0x8DFB /* MAX_ELEMENT_INDEX */,
      0x8B4C /* MAX_UNIFORM_BLOCK_SIZE */, 0x0D3A /* MAX_VIEWPORT_DIMS */
    ]);
    const isIntegerValue = (v) => typeof v === 'number' && Number.isInteger(v);

    // Read the UNMASKED_* params by their literal enum values: the gl.UNMASKED_*
    // constants are undefined until WEBGL_debug_renderer_info is enabled, so a
    // `filter(Boolean)` silently dropped both and left 0x9245 / 0x9246 exposed.
    const UNMASKED_VENDOR = 0x9245;
    const UNMASKED_RENDERER = 0x9246;

    // Same GPU personas and the same seed key as the MAIN world, so both worlds
    // report the identical vendor/renderer pair.
    // P2 7.2 (coherent persona): page_world_injector.js owns one ':persona' OS
    // pick that the UA platform, the WebGL renderer and the WebGPU adapter all
    // share. This world must filter with the SAME key over the SAME list, or
    // the ISOLATED copy (which test_fingerprint.js samples) would report a
    // different renderer than the page - a cross-world divergence that is
    // itself a fingerprint.
    const PERSONA_OS = ['windows', 'mac', 'linux'];
    // P2 7.4: an explicit profile pins the family; 'auto' keeps the derived
    // pick. Must mirror page_world_injector.js exactly, or the ISOLATED copy
    // (which test_fingerprint.js samples) would report a different renderer
    // than the page.
    const personaOs = PERSONA_OS.indexOf(config.persona) !== -1
      ? config.persona
      : (hashString
        ? PERSONA_OS[hashString(((seed >>> 0) || 0) + ':persona') % PERSONA_OS.length]
        : 'windows');
    const GPU_PERSONAS_ALL = [
      { os: 'windows', vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1660 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
      { os: 'windows', vendor: 'Google Inc. (Intel)', renderer: 'ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
      { os: 'windows', vendor: 'Google Inc. (AMD)', renderer: 'ANGLE (AMD, AMD Radeon RX 580 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
      { os: 'mac', vendor: 'Google Inc. (Apple)', renderer: 'ANGLE (Apple, Apple M1, OpenGL 4.1)' },
      { os: 'linux', vendor: 'Google Inc. (Intel)', renderer: 'ANGLE (Intel, Mesa Intel(R) UHD Graphics 620 (CML GT2), OpenGL 4.6 (Core Profile) Mesa 21.2.6)' },
      { os: 'linux', vendor: 'Google Inc. (AMD)', renderer: 'ANGLE (AMD, AMD Radeon RX 580 (POLARIS10, DRM 3.40.0, LLVM 12.0.1), OpenGL 4.6 (Core Profile) Mesa 21.2.6)' }
    ];
    const GPU_PERSONAS = GPU_PERSONAS_ALL.filter((p) => p.os === personaOs);
    const gpuPersona = hashString
      ? GPU_PERSONAS[hashString(((seed >>> 0) || 0) + ':gpu') % GPU_PERSONAS.length]
      : GPU_PERSONAS[0];
    const GPU_VENDOR_STRING = gpuPersona.vendor;
    const GPU_RENDERER_STRING = gpuPersona.renderer;

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
          // Integer queries must stay integer, and the hardware-limit params
          // above must stay exact. The old `value + delta` reported
          // MAX_TEXTURE_SIZE = 16385, a number no real GPU ever returns.
          if (INTEGER_LIMIT_PARAMS.has(p) || isIntegerValue(value)) return value;
          if (!hashString) return value;
          const key = (((seed >>> 0) || 0) + ':wgl:' + p + ':' + value);
          return value + (((hashString(key) % 1000) / 1000) - 0.5) * jitter;
        }

        const gl = this;
        const vendorParams = [
          gl.VENDOR,
          gl.RENDERER,
          UNMASKED_VENDOR,
          UNMASKED_RENDERER
        ].filter((v) => typeof v === 'number' && v > 0);

        if (maskVendors && vendorParams.includes(p) && typeof value === "string") {
          // Return a coherent persona string. Appending ' (ss-...)' leaked the
          // extension name into page-readable output and is itself a
          // fingerprint no real GPU emits.
          const isRenderer = p === gl.RENDERER || p === UNMASKED_RENDERER;
          return isRenderer ? GPU_RENDERER_STRING : GPU_VENDOR_STRING;
        }

        return value;
      };

      if (proto.getSupportedExtensions && shuffleExt) {
        const origGetSupportedExtensions = proto.getSupportedExtensions;
        if (!globalThis.ssStealth || !globalThis.ssStealth.isPatched(origGetSupportedExtensions)) {
          if (globalThis.ssStealth) globalThis.ssStealth.markPatched(origGetSupportedExtensions);
          proto.getSupportedExtensions = function () {
            const list = origGetSupportedExtensions.call(this);
            if (!Array.isArray(list)) return list;
            // Seed-keyed Fisher-Yates: the SET is identical to native, only the
            // order varies. A plain .reverse() produced the same order on every
            // machine, which no real browser does.
            const out = list.slice();
            if (!hashString) return out;
            const s = (seed >>> 0) || 0;
            for (let i = out.length - 1; i > 0; i--) {
              const j = hashString(s + ':wglext:' + i + ':' + out[i]) % (i + 1);
              const tmp = out[i]; out[i] = out[j]; out[j] = tmp;
            }
            return out;
          };
        }
      }

      // P2 (world split, audit 3.2): getShaderPrecisionFormat leaked the GPU's
      // float precision triple. page_world_injector.js already shifted
      // `precision` by at most one under the ':wglprec:' key, but this world
      // left it fully real - so a page that reads the triple from the ISOLATED
      // copy (test_fingerprint.js does exactly that) saw a different answer than
      // the MAIN world for one machine. Same key, same shift rule, same shape on
      // the native prototype: the object handed back is built on the real
      // result's own prototype with non-enumerable own accessors, so
      // `instanceof WebGLShaderPrecisionFormat` and the property list still look
      // native.
      if (proto.getShaderPrecisionFormat) {
        const origPrecisionFormat = proto.getShaderPrecisionFormat;
        if (!globalThis.ssStealth || !globalThis.ssStealth.isPatched(origPrecisionFormat)) {
          if (globalThis.ssStealth) globalThis.ssStealth.markPatched(origPrecisionFormat);
          proto.getShaderPrecisionFormat = function (shaderType, precisionType) {
            const real = origPrecisionFormat.call(this, shaderType, precisionType);
            if (!real || typeof real.precision !== 'number' || !hashString) return real;
            const shifted = real.precision > 0 &&
              (hashString(((seed >>> 0) || 0) + ':wglprec:' + shaderType + ':' + precisionType) % 2) === 1
              ? real.precision - 1
              : real.precision;
            if (shifted === real.precision) return real;
            const out = Object.create(Object.getPrototypeOf(real));
            const shadow = (key, value) => {
              try {
                Object.defineProperty(out, key, {
                  get: () => value, enumerable: false, configurable: true
                });
              } catch (e) { /* ignore */ }
            };
            shadow('rangeMin', real.rangeMin);
            shadow('rangeMax', real.rangeMax);
            shadow('precision', shifted);
            return out;
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
