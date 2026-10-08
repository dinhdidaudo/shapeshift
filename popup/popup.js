// ShapeShift - popup controller.

const DEFAULTS = { perOriginFingerprint: true, useGaussianNoise: true, useStrongKDF: true, enableCanvasNoise: true, enableWebGLMasking: true, enableAudioNoise: true, enableNavigatorFuzz: true, enableWebRTCProtection: true, enableMediaDeviceProtection: true, enableScreenProtection: true, enableFontProtection: true, enableTimezoneProtection: true, enableSensorProtection: true, enableTouchProtection: true, enableUserAgentProtection: true, enableMediaProtection: true, enableGeolocationProtection: true, enableDetectionResistance: true };

const MODULES = [
  { key: 'enableCanvasNoise', label: 'Canvas', icon: 'M3 3h18v18H3zM3 9h18M9 21V9' },
  { key: 'enableWebGLMasking', label: 'WebGL', icon: 'M12 2 3 7v10l9 5 9-5V7l-9-5Z' },
  { key: 'enableAudioNoise', label: 'Audio', icon: 'M11 5 6 9H3v6h3l5 4V5Z' },
  { key: 'enableWebRTCProtection', label: 'WebRTC', icon: 'M4 5h16v14H4zM9 12h6M12 9v6' },
  { key: 'enableScreenProtection', label: 'Screen', icon: 'M3 4h18v12H3zM8 20h8M12 16v4' },
  { key: 'enableFontProtection', label: 'Fonts', icon: 'M5 20 12 4l7 16M8.5 14h7' },
  { key: 'enableTimezoneProtection', label: 'Timezone', icon: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18ZM3 12h18' },
  { key: 'enableSensorProtection', label: 'Sensors', icon: 'M4 18V9M10 18V5M16 18v-7M22 18v-3' },
  { key: 'enableNavigatorFuzz', label: 'Navigator', icon: 'M12 2 2 7l10 5 10-5-10-5Z' },
  { key: 'enableGeolocationProtection', label: 'Geolocation', icon: 'M12 21s7-6.2 7-11a7 7 0 1 0-14 0c0 4.8 7 11 7 11Z' }
];

const $ = function (id) { return document.getElementById(id); };

const SVG_NS = 'http://www.w3.org/2000/svg';
function svgIcon (path) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '13');
  svg.setAttribute('height', '13');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.7');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  const p = document.createElementNS(SVG_NS, 'path');
  p.setAttribute('d', String(path || ''));
  svg.appendChild(p);
  return svg;
}

function storageGet (keys) {
  return new Promise(function (resolve) {
    try { chrome.storage.local.get(keys, function (r) { resolve(r || {}); }); }
    catch (e) { resolve({}); }
  });
}

function storageSet (items) {
  return new Promise(function (resolve) {
    try { chrome.storage.local.set(items, function () { resolve(true); }); }
    catch (e) { resolve(false); }
  });
}

function storageRemove (keys) {
  return new Promise(function (resolve) {
    try { chrome.storage.local.remove(keys, function () { resolve(true); }); }
    catch (e) { resolve(false); }
  });
}

function formatNumber (n) {
  const v = Number(n) || 0;
  if (v >= 1e6) return (v / 1e6).toFixed(1).replace('.0', '') + 'M';
  if (v >= 1e3) return (v / 1e3).toFixed(1).replace('.0', '') + 'K';
  return String(v);
}

let toastTimer = null;
function toast (message) {
  const el = $('toast');
  if (!el) return;
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function () { el.classList.remove('show'); }, 2400);
}

async function activeTab () {
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    return tabs && tabs[0] ? tabs[0] : null;
  } catch (e) { return null; }
}

function originOf (tab) {
  if (!tab || !tab.url) return null;
  try { return new URL(tab.url).origin; } catch (e) { return null; }
}

function hostOf (tab) {
  if (!tab || !tab.url) return 'this page';
  try { return new URL(tab.url).hostname || 'this page'; } catch (e) { return 'this page'; }
}

function renderModules (config) {
  const grid = $('moduleGrid');
  if (!grid) return;
  grid.textContent = '';
  let on = 0;
  MODULES.forEach(function (mod) {
    const enabled = config[mod.key] !== false;
    if (enabled) on++;
    const row = document.createElement('div');
    row.className = 'module' + (enabled ? '' : ' off');
    row.title = mod.label + (enabled ? ' - active' : ' - off');
    const glyph = document.createElement('span');
    glyph.className = 'module-glyph';
    glyph.appendChild(svgIcon(mod.icon));
    const name = document.createElement('span');
    name.className = 'module-name';
    name.textContent = mod.label;
    const state = document.createElement('span');
    state.className = 'module-state';
    row.appendChild(glyph);
    row.appendChild(name);
    row.appendChild(state);
    grid.appendChild(row);
  });
  const counter = $('moduleCounter');
  if (counter) counter.textContent = on + ' / ' + MODULES.length;
}

function setHero (enabled, config) {
  const hero = $('heroCard');
  if (!hero) return;
  const activeCount = MODULES.filter(function (m) { return config[m.key] !== false; }).length;
  const pct = enabled ? Math.round((activeCount / MODULES.length) * 100) : 0;
  const ring = $('ringProgress');
  if (ring) ring.setAttribute('stroke-dashoffset', String(251.3 * (1 - pct / 100)));
  const score = $('heroScore');
  if (score) score.textContent = String(pct);
  hero.classList.toggle('off', !enabled);
  const pill = $('heroPill');
  if (pill) pill.classList.toggle('off', !enabled);
  const status = $('heroStatus');
  const headline = $('heroHeadline');
  const sub = $('heroSub');
  if (!enabled) {
    if (status) status.textContent = 'Paused here';
    if (headline) headline.textContent = 'Protection paused for this site';
    if (sub) sub.textContent = 'Your real fingerprint is visible on this origin.';
  } else {
    if (status) status.textContent = 'Protection active';
    if (headline) headline.textContent = 'Fingerprint is being shaped';
    if (sub) sub.textContent = activeCount + ' of ' + MODULES.length + ' modules shaping this origin.';
  }
}

function setSiteState (enabled) {
  const note = $('siteNote');
  const toggle = $('siteToggle');
  if (toggle) toggle.checked = enabled;
  if (note) {
    note.textContent = enabled ? 'Protection is on for this origin. Reload applies changes instantly.' : 'Protection is off for this origin. The site sees your real device.';
  }
}

async function loadStats () {
  const data = await storageGet(['ss_stats', 'ss_rotation_info']);
  const stats = data.ss_stats || {};
  const rotation = data.ss_rotation_info || {};
  const total = (stats.totalCanvasReads || 0) + (stats.totalWebGLCalls || 0) + (stats.totalAudioCalls || 0) + (stats.totalNavigatorReads || 0) + (stats.totalWebRTCCalls || 0) + (stats.totalScreenReads || 0) + (stats.totalFontReads || 0) + (stats.totalTimezoneReads || 0) + (stats.totalSensorReads || 0);
  if ($('sitesProtected')) $('sitesProtected').textContent = formatNumber(stats.sitesProtected || 0);
  if ($('totalCalls')) $('totalCalls').textContent = formatNumber(total);
  if ($('rotationCount')) $('rotationCount').textContent = formatNumber(rotation.rotationCount || 0);
}

async function loadRotation () {
  const section = $('rotationSection');
  if (!section) return;
  try {
    const response = await chrome.runtime.sendMessage({ type: 'GET_ROTATION_STATUS' });
    if (!response || !response.success || !response.status || !response.status.enabled) {
      section.hidden = true;
      return;
    }
    const status = response.status;
    section.hidden = false;
    if ($('rotationStatus')) $('rotationStatus').textContent = 'Every ' + status.intervalHours + 'h';
    let label = '-';
    let pct = 0;
    if (status.nextRotation) {
      const diff = new Date(status.nextRotation).getTime() - Date.now();
      const mins = Math.max(0, Math.round(diff / 60000));
      label = mins < 60 ? mins + ' min' : Math.round(mins / 60) + ' h';
      const intervalMs = (status.intervalHours || 24) * 3600000;
      pct = Math.min(100, Math.max(0, 100 - (diff / intervalMs) * 100));
    }
    if ($('nextRotation')) $('nextRotation').textContent = label;
    if ($('rotationProgress')) $('rotationProgress').style.width = pct.toFixed(1) + '%';
  } catch (e) {
    section.hidden = true;
  }
}

async function main () {
  const tab = await activeTab();
  const origin = originOf(tab);
  const host = hostOf(tab);
  if ($('currentSite')) $('currentSite').textContent = host;

  const data = await storageGet(['ssConfig', 'ss_site_settings']);
  const config = Object.assign({}, DEFAULTS, data.ssConfig || {});
  const siteSettings = data.ss_site_settings || {};
  const siteEntry = origin ? siteSettings[origin] : null;
  const enabled = siteEntry ? siteEntry.enabled !== false : true;

  renderModules(config);
  setSiteState(enabled);
  setHero(enabled, config);
  await loadStats();
  await loadRotation();

  const toggle = $('siteToggle');
  if (toggle) {
    toggle.addEventListener('change', async function () {
      const next = toggle.checked;
      const store = (await storageGet(['ss_site_settings'])).ss_site_settings || {};
      if (!origin) {
        toast('This tab has no protectable origin.');
        toggle.checked = !next;
        return;
      }
      if (next) delete store[origin];
      else store[origin] = { enabled: false, reason: 'Disabled by user' };
      await storageSet({ ss_site_settings: store });
      setSiteState(next);
      setHero(next, config);
      toast(next ? 'Protection resumed - reloading tab' : 'Protection paused - reloading tab');
      if (tab && tab.id != null) {
        try { chrome.tabs.reload(tab.id); } catch (e) { }
      }
    });
  }

  const reset = $('resetBtn');
  if (reset) {
    reset.addEventListener('click', async function () {
      reset.disabled = true;
      await storageRemove('ss_salt');
      const rotation = (await storageGet(['ss_rotation_info'])).ss_rotation_info || {};
      await storageSet({ ss_rotation_info: { lastRotation: new Date().toISOString(), rotationCount: (rotation.rotationCount || 0) + 1 } });
      toast('New identity generated - reloading tabs');
      try {
        const tabs = await chrome.tabs.query({});
        for (const t of tabs) {
          if (t && t.url && /^https?:/i.test(t.url)) chrome.tabs.reload(t.id);
        }
      } catch (e) { }
      setTimeout(function () { window.close(); }, 900);
    });
  }

  ['optionsBtn', 'optionsBtnSecondary'].forEach(function (id) {
    const btn = $(id);
    if (btn) btn.addEventListener('click', function () { chrome.runtime.openOptionsPage(); });
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', main);
} else {
  main();
}
