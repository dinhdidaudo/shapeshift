// ShapeShift - options controller (control room).

// Architecture §4: the defaults have exactly one definition, in
// core/config-schema.js. options.html loads that file before this controller,
// so the Options page and the hooks can no longer disagree about a default.
// ssFlatDefaults expands the nested groups into the flat keys rendered here.
const DEFAULTS = globalThis.ssFlatDefaults || {};

const GROUPS = {
  groupSurfaces: [
    { key: 'enableCanvasNoise', name: 'Canvas noise', desc: 'Perturb rendered pixels so canvas hashes differ per origin.' },
    { key: 'canvasNoiseStrength', name: 'Canvas strength', desc: 'Pixel delta applied to canvas reads.', range: [0, 10, 0.1] },
    { key: 'enableWebGLMasking', name: 'WebGL masking', desc: 'Alter GPU parameters, vendor and renderer strings.' },
    { key: 'webglJitter', name: 'WebGL jitter', desc: 'Amount of jitter applied to WebGL parameters.', range: [0, 10, 0.1] },
    { key: 'maskWebGLVendorStrings', name: 'Mask vendor strings', desc: 'Replace GPU vendor and renderer with plausible values.' },
    { key: 'shuffleWebGLExtensions', name: 'Shuffle extensions', desc: 'Randomise extension enumeration order.' },
    { key: 'enableWebGPUProtection', name: 'WebGPU masking', desc: 'Report the same GPU persona through navigator.gpu.' },
    { key: 'enableKeyboardProtection', name: 'Keyboard layout', desc: 'Report a keyboard layout that matches the user-agent persona.' },
    { key: 'enableAudioNoise', name: 'Audio noise', desc: 'Subtle offsets in AudioContext sample data.' },
    { key: 'audioNoiseStrength', name: 'Audio strength', desc: 'Magnitude of audio sample perturbation.', number: true },
    { key: 'enableFontProtection', name: 'Font protection', desc: 'Blunt font enumeration and measurement.' }
  ],
  groupNetwork: [
    { key: 'enableWebRTCProtection', name: 'WebRTC protection', desc: 'Stop local IP addresses leaking through ICE candidates.' },
    // P2 7.2: the three WebRTC switches collapsed into one explicit policy.
    // `relay-only` may break peer-to-peer calls, which is why it is not the
    // default; `block-host-srflx` removes the address-bearing candidates while
    // leaving a real call able to negotiate.
    { key: 'webrtcMode', name: 'WebRTC policy', desc: 'How much of the session description ShapeShift rewrites.', enum: true, select: [['block-host-srflx', 'Block host and srflx candidates'], ['relay-only', 'Relay only (strictest)'], ['off', 'Off (leave the SDP untouched)']] },
    { key: 'enableMediaDeviceProtection', name: 'Media device protection', desc: 'Hide the real device inventory.' },
    { key: 'randomizeDeviceIds', name: 'Randomise device IDs', desc: 'Stable fake identifiers per origin.' },
    { key: 'spoofDeviceLabels', name: 'Spoof labels', desc: 'Generic labels instead of real hardware names.' },
    { key: 'enableGeolocationProtection', name: 'Geolocation fuzzing', desc: 'Small coordinate offsets on position reads.' },
    { key: 'noiseLevel', name: 'Geolocation offset', desc: 'Maximum coordinate offset in degrees.', range: [0, 0.05, 0.001] },
    { key: 'enableSensorProtection', name: 'Sensor protection', desc: 'Battery, performance timing and device sensors.' },
    { key: 'hideGamepads', name: 'Hide gamepads', desc: 'Return no connected gamepads.' }
  ],
  groupIdentity: [
    { key: 'perOriginFingerprint', name: 'Per-origin fingerprints', desc: 'Derive an independent seed for every site.' },
    // P2 7.4 (persona profile): 'auto' keeps the seed-derived OS family, the
    // three explicit values pin it so the UA platform, the WebGL renderer, the
    // WebGPU adapter and the keyboard layout all describe one real machine.
    { key: 'persona', name: 'Persona profile', desc: 'Which OS family every spoofed surface should describe.', enum: true, select: [['auto', 'Automatic (derived from seed)'], ['windows', 'Windows'], ['mac', 'macOS'], ['linux', 'Linux']] },
    { key: 'useGaussianNoise', name: 'Gaussian noise', desc: 'Natural distribution instead of uniform noise.' },
    { key: 'enableNavigatorFuzz', name: 'Navigator fuzzing', desc: 'Vary CPU, memory and language signals.' },
    { key: 'fuzzHardwareConcurrency', name: 'Fuzz CPU cores', desc: 'Report a plausible core count.' },
    { key: 'fuzzDeviceMemory', name: 'Fuzz device memory', desc: 'Report a plausible memory tier.' },
    { key: 'shuffleLanguages', name: 'Shuffle languages', desc: 'Reorder the navigator language list.' },
    { key: 'enableScreenProtection', name: 'Screen protection', desc: 'Reshape resolution and pixel ratio.' },
    { key: 'useRealDistribution', name: 'Realistic resolutions', desc: 'Sample from real-world screen sizes.' },
    { key: 'enableTimezoneProtection', name: 'Timezone protection', desc: 'Offset the reported timezone.' },
    { key: 'autoRotateFingerprint', name: 'Auto rotation', desc: 'Regenerate the identity on a schedule.' },
    { key: 'rotationIntervalHours', name: 'Rotation interval', desc: 'Hours between automatic rotations.', select: [[0.5, '30 minutes'], [1, '1 hour'], [6, '6 hours'], [12, '12 hours'], [24, '24 hours'], [72, '3 days'], [168, '7 days']] },
    { key: 'rotateOnStartup', name: 'Rotate on startup', desc: 'New identity every browser launch.' }
  ],
  groupCrypto: [
    { key: 'useStrongKDF', name: 'Strong key derivation', desc: 'Iterated hashing when deriving per-origin seeds.' },
    { key: 'kdfIterations', name: 'KDF iterations', desc: 'Higher is slower and harder to brute force.', number: true },
    { key: 'enableTouchProtection', name: 'Touch protection', desc: 'Normalise touch capability signals.' },
    { key: 'enableUserAgentProtection', name: 'User agent protection', desc: 'Reduce user-agent entropy.' },
    { key: 'enableMediaProtection', name: 'Media codec protection', desc: 'Blunt codec and DRM capability probing.' },
    { key: 'enableDetectionResistance', name: 'Detection resistance', desc: 'Blunt extension and automation detection.' },
    { key: 'timingJitter', name: 'Timing jitter', desc: 'Milliseconds of jitter added to hooked reads (0 disables).', range: [0, 20, 0.5] }
  ],
  groupDebug: [
    { key: 'notifyOnRotation', name: 'Notify on rotation', desc: 'Show a system notification when the identity rotates.' },
    { key: 'reloadTabsOnRotation', name: 'Reload tabs on rotation', desc: 'Refresh open http(s) tabs so they pick up the new identity.' },
    { key: 'debug', name: 'Debug logging', desc: 'Verbose console output for troubleshooting.' }
  ]
};

const TITLES = { overview: ['Overview', 'Control how ShapeShift reshapes your fingerprint.'], surfaces: ['Surfaces', 'Rendering-level signals: canvas, WebGL, audio and fonts.'], network: ['Network & media', 'Connections, capture devices and low-level sensors.'], identity: ['Identity', 'How seeds are derived, fuzzed and rotated.'], sites: ['Sites', 'Origins where protection is paused.'], advanced: ['Advanced', 'Cryptography, extra surfaces and diagnostics.'], about: ['About', 'Version, data handling and licence.'] };

function $(id) { return document.getElementById(id); }

function get(keys) { return new Promise(function (r) { try { chrome.storage.local.get(keys, function (x) { r(x || {}); }); } catch (e) { r({}); } }); }
function set(items) { return new Promise(function (r) { try { chrome.storage.local.set(items, function () { r(true); }); } catch (e) { r(false); } }); }
function remove(keys) { return new Promise(function (r) { try { chrome.storage.local.remove(keys, function () { r(true); }); } catch (e) { r(false); } }); }

let toastTimer = null;
function toast(msg) {
  const el = $('toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function () { el.classList.remove('show'); }, 2400);
}

function isControl(item) { return !!(item.range || item.select || item.number); }

function makeRow(item) {
  const row = document.createElement('div');
  row.className = 'row';
  const text = document.createElement('div');
  text.className = 'row-text';
  const strong = document.createElement('strong');
  strong.textContent = item.name;
  const span = document.createElement('span');
  span.textContent = item.desc;
  text.appendChild(strong);
  text.appendChild(span);
  row.appendChild(text);
  return row;
}

function switchRow(item, config) {
  const row = makeRow(item);
  const label = document.createElement('label');
  label.className = 'switch';
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.dataset.key = item.key;
  // P1: an absent key used to render as ON (`!== false`), so every
  // default-false switch (debug, forceRelay, autoRotateFingerprint,
  // rotateOnStartup) appeared enabled on a fresh install even though the
  // hooks read the schema default and left it off. Fall back to the same
  // schema default the hooks use, so the panel and the runtime agree.
  const storedSwitch = config[item.key];
  input.checked = storedSwitch !== undefined
    ? storedSwitch !== false
    : DEFAULTS[item.key] !== false;
  const track = document.createElement('span');
  track.className = 'switch-track';
  const thumb = document.createElement('span');
  thumb.className = 'switch-thumb';
  track.appendChild(thumb);
  label.appendChild(input);
  label.appendChild(track);
  row.appendChild(label);
  return row;
}

function controlRow(item, config) {
  const row = makeRow(item);
  const control = document.createElement('div');
  control.className = 'row-control';
  const value = config[item.key] !== undefined ? config[item.key] : DEFAULTS[item.key];

  if (item.range) {
    const input = document.createElement('input');
    input.type = 'range';
    input.min = item.range[0];
    input.max = item.range[1];
    input.step = item.range[2];
    input.value = value;
    input.dataset.key = item.key;
    input.dataset.kind = 'number';
    const chip = document.createElement('span');
    chip.className = 'value-chip';
    chip.textContent = Number(value).toFixed(1);
    input.addEventListener('input', function () { chip.textContent = Number(input.value).toFixed(1); });
    control.appendChild(input);
    control.appendChild(chip);
  } else if (item.select) {
    const select = document.createElement('select');
    select.dataset.key = item.key;
    // P2 7.2: a select may be numeric (rotation interval) or a string enum
    // (WebRTC policy). Tagging every select as 'number' made collect() run a
    // string value through clampNumber, so the enum was written back as NaN.
    select.dataset.kind = item.enum ? 'enum' : 'number';
    item.select.forEach(function (pair) {
      const opt = document.createElement('option');
      opt.value = pair[0];
      opt.textContent = pair[1];
      if (String(pair[0]) === String(value)) opt.selected = true;
      select.appendChild(opt);
    });
    control.appendChild(select);
  } else {
    const input = document.createElement('input');
    input.type = 'number';
    input.value = value;
    input.dataset.key = item.key;
    input.dataset.kind = 'number';
    control.appendChild(input);
  }

  row.appendChild(control);
  return row;
}

function renderGroups(config) {
  Object.keys(GROUPS).forEach(function (groupId) {
    const host = $(groupId);
    if (!host) return;
    host.textContent = '';
    GROUPS[groupId].forEach(function (item) {
      host.appendChild(isControl(item) ? controlRow(item, config) : switchRow(item, config));
    });
  });
}

// Bounds for the free-form numeric inputs. A negative or absurd value used to be
// written straight into ssConfig, where it reached the hooks as NaN/garbage
// (e.g. a negative kdfIterations made seed derivation degrade to one pass).
const NUMERIC_BOUNDS = {
  canvasNoiseStrength: [0, 10],
  webglJitter: [0, 10],
  audioNoiseStrength: [0, 1],
  kdfIterations: [1, 100000],
  rotationIntervalHours: [0.5, 8760]
};

function clampNumber(key, raw) {
  const bounds = NUMERIC_BOUNDS[key];
  let value = Number(raw);
  if (!isFinite(value)) {
    value = Number(DEFAULTS[key]);
    if (!isFinite(value)) value = 0;
  }
  if (bounds) value = Math.min(bounds[1], Math.max(bounds[0], value));
  return value;
}

function collect() {
  const config = {};
  const nodes = document.querySelectorAll('[data-key]');
  for (let i = 0; i < nodes.length; i++) {
    const el = nodes[i];
    if (el.dataset.kind === 'enum') {
      config[el.dataset.key] = el.value;
    } else {
      config[el.dataset.key] = el.dataset.kind === 'number' ? clampNumber(el.dataset.key, el.value) : el.checked;
    }
  }
  return config;
}

// The canonical set of protection surfaces, shared with popup.js `MODULES`.
// The score used to be computed over every switch in GROUPS (33 of them here)
// while the popup scored the 10 primary surfaces, so the same configuration
// displayed two different numbers. Both UIs now report the same percentage.
const MODULE_KEYS = [
  'enableCanvasNoise',
  'enableWebGLMasking',
  'enableAudioNoise',
  'enableWebRTCProtection',
  'enableScreenProtection',
  'enableFontProtection',
  'enableTimezoneProtection',
  'enableSensorProtection',
  'enableNavigatorFuzz',
  'enableGeolocationProtection'
];

function switchKeys() {
  return MODULE_KEYS;
}

function updateOverview(config) {
  const keys = switchKeys();
  let on = 0;
  keys.forEach(function (k) { if (config[k] !== false) on++; });
  const pct = Math.round((on / keys.length) * 100);
  const ring = $('overviewRing');
  if (ring) ring.setAttribute('stroke-dashoffset', String(251.3 * (1 - pct / 100)));
  if ($('overviewScore')) $('overviewScore').textContent = String(pct);
  if ($('statSurfaces')) $('statSurfaces').textContent = String(on);
  if ($('overviewStatus')) $('overviewStatus').textContent = on === keys.length ? 'Full coverage' : on + ' of ' + keys.length + ' surfaces on';
}

async function refreshStats() {
  const data = await get(['ss_stats', 'ss_site_settings', 'ss_rotation_info']);
  const stats = data.ss_stats || {};
  const total = (stats.totalCanvasReads || 0) + (stats.totalWebGLCalls || 0) + (stats.totalAudioCalls || 0) + (stats.totalNavigatorReads || 0) + (stats.totalWebRTCCalls || 0) + (stats.totalScreenReads || 0) + (stats.totalFontReads || 0) + (stats.totalTimezoneReads || 0) + (stats.totalSensorReads || 0) + (stats.totalMediaCodecReads || 0) + (stats.totalDrmReads || 0) + (stats.totalGeolocationReads || 0) + (stats.totalTouchReads || 0);
  const sites = Object.keys(data.ss_site_settings || {}).length;
  if ($('statSites')) $('statSites').textContent = String(sites);
  if ($('statSignals')) $('statSignals').textContent = String(total);
  // Feature 5.9: the About pane shows the same local counters the popup
  // aggregates. Rendering them from ss_stats keeps one source of truth, and
  // nothing here is uploaded - these are read-only numbers on this machine.
  if ($('aboutSites')) $('aboutSites').textContent = String(stats.sitesProtected || 0);
  if ($('aboutSignals')) $('aboutSignals').textContent = String(total);
  if ($('aboutRotations')) $('aboutRotations').textContent = String((data.ss_rotation_info || {}).rotationCount || 0);
}

// Diagnostics (P2): the hook installers report failures to the service worker,
// which stores them in storage.session and raises the toolbar badge. This pane
// is the readable half - it tells the user *which* load degraded instead of
// leaving a red dot with no explanation.
function diagnosticRow(label, value) {
  const row = document.createElement('div');
  row.className = 'row';
  const text = document.createElement('div');
  text.className = 'row-text';
  const strong = document.createElement('strong');
  strong.textContent = label;
  const span = document.createElement('span');
  span.textContent = value;
  text.appendChild(strong);
  text.appendChild(span);
  row.appendChild(text);
  return row;
}

async function renderDiagnostics() {
  const host = $('diagnosticsBody');
  if (!host) return;
  host.textContent = '';
  let diagnostics = null;
  try {
    const res = await chrome.runtime.sendMessage({ type: 'GET_DIAGNOSTICS' });
    if (res && res.success) diagnostics = res.diagnostics;
  } catch (e) { /* service worker may be restarting */ }
  if (!diagnostics) {
    host.appendChild(diagnosticRow('Status', 'Unavailable - reload the extension and try again.'));
    return;
  }
  const failed = Number(diagnostics.failedInstallers) || 0;
  const total = Number(diagnostics.totalInstallers) || 0;
  host.appendChild(diagnosticRow('Last load', failed > 0
    ? failed + ' of ' + (total || '?') + ' installers failed'
    : 'All installers succeeded'));
  if (diagnostics.lastFailureAt) {
    host.appendChild(diagnosticRow('Last failure', new Date(diagnostics.lastFailureAt).toLocaleString()));
  }
  if (diagnostics.lastFailureOrigin) {
    host.appendChild(diagnosticRow('Last failure origin', diagnostics.lastFailureOrigin));
  }
}

// Feature 7.3 (self-test surface): ask a real page to sample every surface.
// The tab answers with one digest per surface plus a warning for every surface
// it could not reach, so a tab without WebGL or Web Audio no longer reports a
// healthy-looking composite hash that proved nothing.
async function renderSelfTest() {
  const host = $('selfTestBody');
  if (!host) return;
  host.textContent = '';
  host.appendChild(diagnosticRow('Status', 'Running...'));

  let tabs = [];
  try {
    tabs = await new Promise(function (resolve) {
      chrome.tabs.query({}, function (list) { resolve(list || []); });
    });
  } catch (e) { /* tabs permission unavailable */ }

  // The options page itself is chrome-extension://, so it never qualifies.
  const candidates = tabs.filter(function (t) {
    return t && t.id != null && /^https?:/i.test(t.url || '');
  });
  let tab = null;
  for (let i = 0; i < candidates.length; i++) {
    if (candidates[i].active) { tab = candidates[i]; break; }
  }
  if (!tab) tab = candidates[0] || null;

  host.textContent = '';
  if (!tab) {
    host.appendChild(diagnosticRow('Status', 'No http(s) tab is open - load a site and run the test again.'));
    return;
  }

  let response = null;
  try {
    response = await chrome.tabs.sendMessage(tab.id, { type: 'SS_RUN_SELF_TEST' });
  } catch (e) { /* no content script answered */ }

  host.textContent = '';
  if (!response || !response.success) {
    host.appendChild(diagnosticRow('Target', tab.url || 'unknown'));
    host.appendChild(diagnosticRow('Status', 'Not installed on this tab - reload it and run the test again.'));
    if (response && response.error) host.appendChild(diagnosticRow('Reason', response.error));
    return;
  }

  const report = response.report || {};
  const parts = report.parts || {};
  const labels = { canvas: 'Canvas', webgl: 'WebGL', audio: 'Audio', navigator: 'Navigator' };
  ['canvas', 'webgl', 'audio', 'navigator'].forEach(function (key) {
    if (parts[key]) host.appendChild(diagnosticRow(labels[key], parts[key]));
  });
  host.appendChild(diagnosticRow('Composite', report.composite || 'unavailable'));
  host.appendChild(diagnosticRow('Target', tab.url || 'unknown'));

  const warnings = Array.isArray(report.warnings) ? report.warnings : [];
  if (warnings.length) {
    warnings.forEach(function (w) { host.appendChild(diagnosticRow('Not available', w)); });
  } else {
    host.appendChild(diagnosticRow('Warnings', 'None - every surface answered'));
  }
}

// Feature 5.1: import / export. Only ssConfig travels; the salt lives in
// chrome.storage.local and is deliberately never written to the file, so a
// shared profile cannot clone the identity of the machine that exported it.
async function exportConfigToFile() {
  const stored = (await get(['ssConfig'])).ssConfig || {};
  const payload = {
    app: 'ShapeShift',
    kind: 'ssConfig',
    exportedAt: new Date().toISOString(),
    config: stored
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'shapeshift-config.json';
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
}

async function importConfigFromFile(file) {
  const text = await file.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new Error('not valid JSON');
  }
  const incoming = parsed && typeof parsed === 'object' && parsed.config ? parsed.config : parsed;
  if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) {
    throw new Error('missing a config object');
  }
  // Only ssConfig is written. A file containing ss_salt is ignored on purpose.
  await set({ ssConfig: incoming });
}

async function renderSites() {
  const host = $('siteList');
  if (!host) return;
  host.textContent = '';
  const store = (await get(['ss_site_settings'])).ss_site_settings || {};
  const origins = Object.keys(store);
  if (!origins.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = 'Protection is active on every site. Add an origin to pause it there.';
    host.appendChild(empty);
    return;
  }
  origins.forEach(function (origin) {
    const item = document.createElement('div');
    item.className = 'site-item';
    const text = document.createElement('div');
    const strong = document.createElement('strong');
    strong.textContent = origin;
    const span = document.createElement('span');
    span.textContent = 'Protection paused';
    text.appendChild(strong);
    text.appendChild(span);
    const btn = document.createElement('button');
    btn.className = 'btn ghost';
    btn.type = 'button';
    btn.textContent = 'Resume';
    btn.addEventListener('click', async function () {
      const current = (await get(['ss_site_settings'])).ss_site_settings || {};
      delete current[origin];
      await set({ ss_site_settings: current });
      toast('Protection resumed on ' + origin);
      renderSites();
      refreshStats();
    });
    item.appendChild(text);
    item.appendChild(btn);
    host.appendChild(item);
  });
}

async function main() {
  const stored = (await get(['ssConfig'])).ssConfig || {};
  const config = Object.assign({}, DEFAULTS, stored);

  renderGroups(config);
  updateOverview(config);
  refreshStats();
  renderSites();
  // Populate the Hook health card on load too. renderDiagnostics() was only
  // reachable from the Advanced nav click and the Refresh button, so the pane
  // showed placeholder text until the user interacted with it.
  renderDiagnostics();
  if ($('aboutVersion')) {
    try { $('aboutVersion').textContent = chrome.runtime.getManifest().version; } catch (e) { }
  }

  document.addEventListener('change', function () { updateOverview(collect()); });
  document.addEventListener('input', function () { updateOverview(collect()); });

  const nav = $('nav');
  if (nav) {
    nav.addEventListener('click', function (event) {
      const btn = event.target.closest('.nav-item');
      if (!btn) return;
      const target = btn.dataset.panel;
      const items = nav.querySelectorAll('.nav-item');
      for (let i = 0; i < items.length; i++) items[i].classList.toggle('active', items[i] === btn);
      const panels = document.querySelectorAll('.panel');
      for (let i = 0; i < panels.length; i++) panels[i].classList.toggle('active', panels[i].id === 'panel-' + target);
      const meta = TITLES[target] || ['', ''];
      if ($('panelTitle')) $('panelTitle').textContent = meta[0];
      if ($('panelSub')) $('panelSub').textContent = meta[1];
      if (target === 'sites') renderSites();
      if (target === 'advanced') renderDiagnostics();
      if (target === 'about' || target === 'overview') { updateOverview(collect()); refreshStats(); }
    });
  }

  // P2 7.2 (feature): the named profiles were `balanced` / `strict` / `compat`
  // and the patch was applied with a two-way branch - `number` wrote `.value`,
  // everything else wrote `.checked`. `webrtcMode` is a <select> rendered with
  // `data-kind="enum"`, so every preset wrote a *string* into `.checked` (a
  // no-op property) and the WebRTC policy silently stayed whatever it was. The
  // preset row therefore never actually changed the one setting it advertised.
  // Three explicit levels now, each patching the enum through `.value`.
  const presets = {
    light: {
      canvasNoiseStrength: 0.6, webglJitter: 0.6, audioNoiseStrength: 1e-8,
      enableDetectionResistance: false, webrtcMode: 'off',
      enableWebGPUProtection: false, enableKeyboardProtection: false
    },
    balanced: {
      canvasNoiseStrength: 2, webglJitter: 2, audioNoiseStrength: 1e-7,
      enableDetectionResistance: true, webrtcMode: 'block-host-srflx',
      enableWebGPUProtection: true, enableKeyboardProtection: true
    },
    maximum: {
      canvasNoiseStrength: 6, webglJitter: 6, audioNoiseStrength: 1e-6,
      enableDetectionResistance: true, webrtcMode: 'relay-only',
      enableWebGPUProtection: true, enableKeyboardProtection: true
    }
  };
  const presetLabels = { light: 'Light', balanced: 'Balanced', maximum: 'Maximum' };
  const presetBtns = document.querySelectorAll('.preset');
  for (let i = 0; i < presetBtns.length; i++) {
    presetBtns[i].addEventListener('click', function () {
      const name = presetBtns[i].dataset.preset;
      const patch = presets[name];
      if (!patch) return;
      Object.keys(patch).forEach(function (key) {
        const el = document.querySelector('[data-key="' + key + '"]');
        if (!el) return;
        // A checkbox is the only control without an explicit kind; selects are
        // 'enum' and sliders/number inputs are 'number'. Both of those take the
        // value directly so a string enum reaches the right property.
        if (!el.dataset.kind) {
          el.checked = !!patch[key];
        } else {
          el.value = patch[key];
          // A slider's value chip is refreshed only by its own 'input' listener,
          // so a preset that wrote .value directly left the chip showing the old
          // number next to the new slider position. Dispatch the event the
          // control already listens for instead of duplicating the formatting.
          el.dispatchEvent(new Event('input', { bubbles: false }));
        }
      });
      updateOverview(collect());
      toast('Preset applied: ' + (presetLabels[name] || name) + '. Remember to save.');
    });
  }

  if ($('saveBtn')) {
    $('saveBtn').addEventListener('click', async function () {
      const merged = Object.assign({}, config, collect());
      await set({ ssConfig: merged });
      try { await chrome.runtime.sendMessage({ type: 'UPDATE_ROTATION_CONFIG' }); } catch (e) { }
      if ($('sideStatus')) $('sideStatus').textContent = 'Saved ' + new Date().toLocaleTimeString();
      toast('Settings saved');
      updateOverview(merged);
    });
  }

  if ($('refreshDiagnosticsBtn')) {
    $('refreshDiagnosticsBtn').addEventListener('click', function () {
      renderDiagnostics();
      toast('Diagnostics refreshed');
    });
  }

  if ($('runSelfTestBtn')) {
    $('runSelfTestBtn').addEventListener('click', async function () {
      toast('Running self-test');
      await renderSelfTest();
    });
  }

  if ($('exportConfigBtn')) {
    $('exportConfigBtn').addEventListener('click', async function () {
      await exportConfigToFile();
      toast('Configuration exported');
    });
  }

  if ($('importConfigBtn') && $('importConfigFile')) {
    $('importConfigBtn').addEventListener('click', function () {
      $('importConfigFile').click();
    });
    $('importConfigFile').addEventListener('change', async function (event) {
      const file = event.target.files && event.target.files[0];
      if (!file) return;
      try {
        await importConfigFromFile(file);
        toast('Configuration imported - reloading');
        setTimeout(function () { location.reload(); }, 600);
      } catch (e) {
        toast('Import failed: ' + ((e && e.message) || 'invalid file'));
      }
      event.target.value = '';
    });
  }

  if ($('resetAllBtn')) {
    $('resetAllBtn').addEventListener('click', async function () {
      await remove('ssConfig');
      toast('Settings restored to defaults');
      setTimeout(function () { location.reload(); }, 600);
    });
  }

  if ($('rotateNowBtn')) {
    $('rotateNowBtn').addEventListener('click', async function () {
      // Same path as the popup: let the service worker own the rotation so the
      // notification, rotation info and alarm re-arm all happen exactly once.
      let rotated = false;
      try {
        const res = await chrome.runtime.sendMessage({ type: 'ROTATE_NOW' });
        rotated = !!(res && res.success);
      } catch (e) { /* fall through to the local path */ }
      if (!rotated) {
        await remove('ss_salt');
        const rotation = (await get(['ss_rotation_info'])).ss_rotation_info || {};
        await set({ ss_rotation_info: { lastRotation: new Date().toISOString(), rotationCount: (rotation.rotationCount || 0) + 1 } });
      }
      toast('New identity generated - reloading tabs');
      refreshStats();
      // A new salt only reaches the page on the next load, so reload every
      // http(s) tab here the way the popup already does. Without this the new
      // identity existed in storage but no open page ever picked it up.
      try {
        const tabs = await new Promise(function (resolve) {
          chrome.tabs.query({}, function (list) { resolve(list || []); });
        });
        for (const t of tabs) {
          if (t && t.url && /^https?:/i.test(t.url) && t.id != null) chrome.tabs.reload(t.id);
        }
      } catch (e) { /* reload is best-effort */ }
    });
  }

  if ($('addSiteBtn')) {
    $('addSiteBtn').addEventListener('click', async function () {
      const input = $('newSiteInput');
      const raw = (input.value || '').trim().toLowerCase();
      if (!raw) return;
      let origin;
      try { origin = new URL(/^https?:/.test(raw) ? raw : 'https://' + raw).origin; }
      catch (e) { toast('Enter a valid domain'); return; }
      const store = (await get(['ss_site_settings'])).ss_site_settings || {};
      store[origin] = { enabled: false, reason: 'Disabled in options' };
      await set({ ss_site_settings: store });
      input.value = '';
      toast('Paused on ' + origin);
      renderSites();
      refreshStats();
    });
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', main);
} else {
  main();
}
