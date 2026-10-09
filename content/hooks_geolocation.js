// Geolocation API protection.
//
// P0 (world split): every hook in this file used to run in the ISOLATED world,
// where the page can never observe it - `navigator.geolocation` as read by page
// script is the MAIN-world object, so all of this was dead weight that still
// advertised a protection it did not provide. It also drew a fresh streaming
// `noise()` value on every read, so a page that *could* have seen it would have
// seen coordinates that changed on every single call.
//
// The real, page-visible implementation now lives in the MAIN world
// (content/page_world_injector.js, "GEOLOCATION HOOKS"): it keys the offset on
// (seed, coordinate) so repeated reads of the same fix agree, and it shadows the
// accessors on an object that keeps the native prototype so
// `coords instanceof GeolocationCoordinates` still holds.
//
// This installer is intentionally a no-op: running a second fuzz pass here would
// either be invisible (if applied to the ISOLATED copy of navigator) or would
// double-shift the coordinates the page finally receives.
(function () {
  const installers = (globalThis.ssHookInstallers = globalThis.ssHookInstallers || []);

  installers.push(function installGeolocationHooks (env) {
    if (!env || !env.config?.enableGeolocationProtection) return;
    if (env.config.debug) {
      console.log('[shapeshift][geolocation] ISOLATED installer skipped; MAIN world owns this surface');
    }
  });
})();
