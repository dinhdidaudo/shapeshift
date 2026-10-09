// Fingerprint sampler utilities for debugging/testing.
(function () {
  const hash = globalThis.ssHashString || (s => s.length);
  const debug = (globalThis.ssConfig && globalThis.ssConfig.debug) || false;
  const dlog = debug ? console.log : () => { };

  function safe (fn, fallback) {
    try {
      return fn();
    } catch (e) {
      return fallback;
    }
  }

  function toHex (num) {
    return (num >>> 0).toString(16);
  }

  function sampleCanvas () {
    const canvas = document.createElement("canvas");
    canvas.width = 32;
    canvas.height = 32;
    const ctx = canvas.getContext("2d");
    if (!ctx) return "noctx";
    ctx.fillStyle = "#f60";
    ctx.fillRect(0, 0, 32, 32);
    ctx.fillStyle = "#069";
    ctx.fillRect(2, 2, 29, 29);
    ctx.fillStyle = "#fff";
    ctx.fillText("fp", 4, 16);
    return canvas.toDataURL();
  }

  function sampleAudio () {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return "no-audio";
    const ctx = new AC();
    const buffer = ctx.createBuffer(1, 16, 44100);
    const channel = buffer.getChannelData(0);
    const sample = Array.from(channel.slice(0, 5));
    if (typeof ctx.close === "function") ctx.close();
    return sample;
  }

  function sampleNavigator () {
    const nav = window.navigator || {};
    return {
      hardwareConcurrency: nav.hardwareConcurrency,
      deviceMemory: nav.deviceMemory,
      languages: Array.isArray(nav.languages) ? nav.languages.slice() : nav.languages
    };
  }

  // P0 1.3: the old path injected <script src="chrome-extension://..."> into
  // the page DOM so a MAIN-world helper could sample WebGL. That was observable
  // by any page script (MutationObserver, resource timing entries, message
  // listeners) and it ran on every load. MAIN world now owns the WebGL hooks,
  // and manifest.json exposes no web_accessible_resources, so the injection is
  // gone: a dangling chrome.runtime.getURL() would only produce a failed
  // request plus a 1s timeout. Sample from the ISOLATED copy instead.
  function sampleWebGL () {
    const canvas = document.createElement("canvas");
    const gl = safe(
      () => canvas.getContext("webgl") || canvas.getContext("experimental-webgl"),
      null
    );
    if (!gl) return "no-webgl";
    const dbg = safe(() => gl.getExtension("WEBGL_debug_renderer_info"), null);
    return {
      vendor: safe(() => gl.getParameter(gl.VENDOR), null),
      renderer: safe(() => gl.getParameter(gl.RENDERER), null),
      unmaskedVendor: dbg ? safe(() => gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL), null) : null,
      unmaskedRenderer: dbg ? safe(() => gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL), null) : null
    };
  }

  async function testFingerprint () {
    const canvas = safe(sampleCanvas, "canvas-error");
    const webgl = safe(sampleWebGL, "webgl-error");
    const audio = safe(sampleAudio, "audio-error");
    const nav = safe(sampleNavigator, "nav-error");

    dlog("[shapeshift][test] samples", { webgl, canvas: typeof canvas === "string" ? canvas.slice(0, 32) + "..." : canvas, audio: audio, nav });

    const parts = {
      canvas: toHex(hash(String(canvas))),
      webgl: toHex(hash(JSON.stringify(webgl))),
      audio: toHex(hash(JSON.stringify(audio))),
      navigator: toHex(hash(JSON.stringify(nav)))
    };

    return `C${parts.canvas}W${parts.webgl}A${parts.audio}N${parts.navigator}`;
  }

  globalThis.ssTestFingerprint = testFingerprint;
})();
