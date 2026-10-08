// ShapeShift - options controller (control room).

const DEFAULTS = { perOriginFingerprint: true, useGaussianNoise: true, useStrongKDF: true, kdfIterations: 1000, enableCanvasNoise: true, canvasNoiseStrength: 2, enableWebGLMasking: true, webglJitter: 2, maskWebGLVendorStrings: true, shuffleWebGLExtensions: true, enableAudioNoise: true, audioNoiseStrength: 1e-7, enableNavigatorFuzz: true, fuzzHardwareConcurrency: true, fuzzDeviceMemory: true, shuffleLanguages: true, enableWebRTCProtection: true, blockIPLeak: true, randomizeSDP: true, forceRelay: false, enableMediaDeviceProtection: true, randomizeDeviceIds: true, spoofDeviceLabels: true, enableScreenProtection: true, useRealDistribution: true, enableFontProtection: true, enableTimezoneProtection: true, enableSensorProtection: true, hideGamepads: true, enableTouchProtection: true, enableUserAgentProtection: true, enableMediaProtection: true, enableGeolocationProtection: true, enableDetectionResistance: true, autoRotateFingerprint: false, rotationIntervalHours: 24, rotateOnStartup: false, debug: false };

const GROUPS = {
  groupSurfaces: [
    { key: 'enableCanvasNoise', name: 'Canvas noise', desc: 'Perturb rendered pixels so canvas hashes differ per origin.' },
    { key: 'canvasNoiseStrength', name: 'Canvas strength', desc: 'Pixel delta applied to canvas reads.', range: [0, 10, 0.1] },
    { key: 'enableWebGLMasking', name: 'WebGL masking', desc: 'Alter GPU parameters, vendor and renderer strings.' },
    { key: 'webglJitter', name: 'WebGL jitter', desc: 'Amount of jitter applied to WebGL parameters.', range: [0, 10, 0.1] },
    { key: 'maskWebGLVendorStrings', name: 'Mask vendor strings', desc: 'Replace GPU vendor and renderer with plausible values.' },
    { key: 'shuffleWebGLExtensions', name: 'Shuffle extensions', desc: 'Randomise extension enumeration order.' },
    { key: 'enableAudioNoise', name: 'Audio noise', desc: 'Subtle offsets in AudioContext sample data.' },
    { key: 'audioNoiseStrength', name: 'Audio strength', desc: 'Magnitude of audio sample perturbation.', number: true },
    { key: 'enableFontProtection', name: 'Font protection', desc: 'Blunt font enumeration and measurement.' }
  ],
  groupNetwork: [
    { key: 'enableWebRTCProtection', name: 'WebRTC protection', desc: 'Stop local IP addresses leaking through ICE candidates.' },
    { key: 'blockIPLeak', name: 'Block IP leak', desc: 'Strip host and srflx candidates from offers.' },
    { key: 'randomizeSDP', name: 'Randomise SDP', desc: 'Vary session description fingerprints.' },
    { key: 'forceRelay', name: 'Force relay only', desc: 'Maximum privacy; may break peer-to-peer calls.' },
    { key: 'enableMediaDeviceProtection', name: 'Media device protection', desc: 'Hide the real device inventory.' },
    { key: 'randomizeDeviceIds', name: 'Randomise device IDs', desc: 'Stable fake identifiers per origin.' },
    { key: 'spoofDeviceLabels', name: 'Spoof labels', desc: 'Generic labels instead of real hardware names.' },
    { key: 'enableGeolocationProtection', name: 'Geolocation fuzzing', desc: 'Small coordinate offsets on position reads.' },
    { key: 'enableSensorProtection', name: 'Sensor protection', desc: 'Battery, performance timing and device sensors.' },
    { key: 'hideGamepads', name: 'Hide gamepads', desc: 'Return no connected gamepads.' }
  ],
  groupIdentity: [
    { key: 'perOriginFingerprint', name: 'Per-origin fingerprints', desc: 'Derive an independent seed for every site.' },
    { key: 'useGaussianNoise', name: 'Gaussian noise', desc: 'Natural distribution instead of uniform noise.' },
    { key: 'enableNavigatorFuzz', name: 'Navigator fuzzing', desc: 'Vary CPU, memory and language signals.' },
    { key: 'fuzzHardwareConcurrency', name: 'Fuzz CPU cores', desc: 'Report a plausible core count.' },
    { key: 'fuzzDeviceMemory', name: 'Fuzz device memory', desc: 'Report a plausible memory tier.' },
    { key: 'shuffleLanguages', name: 'Shuffle languages', desc: 'Reorder the navigator language list.' },
    { key: 'enableScreenProtection', name: 'Screen protection', desc: 'Reshape resolution and pixel ratio.' },
    { key: 'useRealDistribution', name: 'Realistic resolutions', desc: 'Sample from real-world screen sizes.' },
    { key: 'enableTimezoneProtection', name: 'Timezone protection', desc: 'Offset the reported timezone.' },
    { key: 'autoRotateFingerprint', name: 'Auto rotation', desc: 'Regenerate the identity on a schedule.' },
    { key: 'rotationIntervalHours', name: 'Rotation interval', desc: 'Hours between automatic rotations.', select: [[1, '1 hour'], [6, '6 hours'], [12, '12 hours'], [24, '24 hours'], [72, '3 days'], [168, '7 days']] },
    { key: 'rotateOnStartup', name: 'Rotate on startup', desc: 'New identity every browser launch.' }
  ],
  groupCrypto: [
    { key: 'useStrongKDF', name: 'Strong key derivation', desc: 'Iterated hashing when deriving per-origin seeds.' },
    { key: 'kdfIterations', name: 'KDF iterations', desc: 'Higher is slower and harder to brute force.', number: true },
    { key: 'enableTouchProtection', name: 'Touch protection', desc: 'Normalise touch capability signals.' },
    { key: 'enableUserAgentProtection', name: 'User agent protection', desc: 'Reduce user-agent entropy.' },
    { key: 'enableMediaProtection', name: 'Media codec protection', desc: 'Blunt codec and DRM capability probing.' },
    { key: 'enableDetectionResistance', name: 'Detection resistance', desc: 'Blunt extension and automation detection.' }
  ],
  groupDebug: [
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
  input.checked = config[item.key] !== false;
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
    select.dataset.kind = 'number';
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

function collect() {
  const config = {};
  const nodes = document.querySelectorAll('[data-key]');
  for (let i = 0; i < nodes.length; i++) {
    const el = nodes[i];
    config[el.dataset.key] = el.dataset.kind === 'number' ? Number(el.value) : el.checked;
  }
  return config;
}

function switchKeys() {
  const keys = [];
  Object.keys(GROUPS).forEach(function (g) {
    GROUPS[g].forEach(function (item) { if (!isControl(item)) keys.push(item.key); });
  });
  return keys;
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
  const data = await get(['ss_stats', 'ss_site_settings']);
  const stats = data.ss_stats || {};
  const total = (stats.totalCanvasReads || 0) + (stats.totalWebGLCalls || 0) + (stats.totalAudioCalls || 0) + (stats.totalNavigatorReads || 0) + (stats.totalWebRTCCalls || 0) + (stats.totalScreenReads || 0) + (stats.totalFontReads || 0) + (stats.totalTimezoneReads || 0) + (stats.totalSensorReads || 0);
  const sites = Object.keys(data.ss_site_settings || {}).length;
  if ($('statSites')) $('statSites').textContent = String(sites);
  if ($('statSignals')) $('statSignals').textContent = String(total);
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
      if (target === 'overview') { updateOverview(collect()); refreshStats(); }
    });
  }

  const presets = {
    balanced: { canvasNoiseStrength: 2, webglJitter: 2, enableDetectionResistance: true, forceRelay: false, audioNoiseStrength: 1e-7 },
    strict: { canvasNoiseStrength: 6, webglJitter: 6, enableDetectionResistance: true, forceRelay: true, audioNoiseStrength: 1e-6 },
    compat: { canvasNoiseStrength: 0.6, webglJitter: 0.6, enableDetectionResistance: false, forceRelay: false, audioNoiseStrength: 1e-8 }
  };
  const presetBtns = document.querySelectorAll('.preset');
  for (let i = 0; i < presetBtns.length; i++) {
    presetBtns[i].addEventListener('click', function () {
      const patch = presets[presetBtns[i].dataset.preset];
      if (!patch) return;
      Object.keys(patch).forEach(function (key) {
        const el = document.querySelector('[data-key="' + key + '"]');
        if (!el) return;
        if (el.dataset.kind === 'number') el.value = patch[key];
        else el.checked = patch[key];
      });
      updateOverview(collect());
      toast('Preset applied: ' + presetBtns[i].dataset.preset + '. Remember to save.');
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

  if ($('resetAllBtn')) {
    $('resetAllBtn').addEventListener('click', async function () {
      await remove('ssConfig');
      toast('Settings restored to defaults');
      setTimeout(function () { location.reload(); }, 600);
    });
  }

  if ($('rotateNowBtn')) {
    $('rotateNowBtn').addEventListener('click', async function () {
      await remove('ss_salt');
      const rotation = (await get(['ss_rotation_info'])).ss_rotation_info || {};
      await set({ ss_rotation_info: { lastRotation: new Date().toISOString(), rotationCount: (rotation.rotationCount || 0) + 1 } });
      toast('New identity generated');
      refreshStats();
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
