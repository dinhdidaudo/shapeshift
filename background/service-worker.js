// Background service worker for ShapeShift
// Handles statistics tracking, aggregation, and automatic fingerprint rotation

// Initialize on install or startup
chrome.runtime.onInstalled.addListener(async () => {
  await initializeStorage();
  await checkAndRotateFingerprint();
  await setupRotationAlarm();
  await setupSaltGuardAlarm();
});

chrome.runtime.onStartup.addListener(async () => {
  // Re-assert the storage contract on every browser start: a cleared profile,
  // a partial sync, or a manual wipe must not leave the UI with undefined keys.
  await initializeStorage();
  await checkRotateOnStartup();
  await setupRotationAlarm();
  await setupSaltGuardAlarm();
});

// Initialize statistics storage
async function initializeStorage() {
  const result = await chrome.storage.local.get(['ss_stats', 'ss_rotation_info']);

  if (!result.ss_stats) {
    await chrome.storage.local.set({
      ss_stats: {
        sitesProtectedArray: [],
        sitesProtected: 0,
        totalCanvasReads: 0,
        totalWebGLCalls: 0,
        totalAudioCalls: 0,
        totalNavigatorReads: 0,
        totalWebRTCCalls: 0,
        totalScreenReads: 0,
        totalFontReads: 0,
        totalTimezoneReads: 0,
        totalSensorReads: 0,
        totalMediaCodecReads: 0,
        totalDrmReads: 0,
        totalGeolocationReads: 0,
        totalTouchReads: 0,
        lastReset: new Date().toISOString()
      }
    });
  }

  if (!result.ss_rotation_info) {
    await chrome.storage.local.set({
      ss_rotation_info: {
        lastRotation: new Date().toISOString(),
        rotationCount: 0
      }
    });
  }
}

// Listen for statistics updates from content scripts
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'UPDATE_STATS') {
    updateStatistics(message.data, sender.tab?.url, sender.url).then(() => {
      sendResponse({ success: true });
    }).catch(error => {
      console.error('Failed to update statistics:', error);
      sendResponse({ success: false, error: error.message });
    });
    return true; // Keep channel open for async response
  }

  if (message.type === 'GET_STATS') {
    getStatistics().then(stats => {
      sendResponse({ success: true, stats });
    }).catch(error => {
      console.error('Failed to get statistics:', error);
      sendResponse({ success: false, error: error.message });
    });
    return true;
  }

  if (message.type === 'RESET_STATS') {
    resetStatistics().then(() => {
      sendResponse({ success: true });
    }).catch(error => {
      console.error('Failed to reset statistics:', error);
      sendResponse({ success: false, error: error.message });
    });
    return true;
  }

  if (message.type === 'HOOK_STATUS') {
    reportHookStatus(message.failed, message.total, message.origin).then(diagnostics => {
      sendResponse({ success: true, diagnostics });
    }).catch(error => {
      console.error('Failed to record hook status:', error);
      sendResponse({ success: false, error: error.message });
    });
    return true;
  }

  if (message.type === 'GET_DIAGNOSTICS') {
    getDiagnostics().then(diagnostics => {
      sendResponse({ success: true, diagnostics });
    }).catch(error => {
      console.error('Failed to read diagnostics:', error);
      sendResponse({ success: false, error: error.message });
    });
    return true;
  }

  if (message.type === 'GET_ROTATION_STATUS') {
    getRotationStatus().then(status => {
      sendResponse({ success: true, status });
    }).catch(error => {
      console.error('Failed to get rotation status:', error);
      sendResponse({ success: false, error: error.message });
    });
    return true;
  }

  if (message.type === 'ROTATE_NOW') {
    rotateFingerprintNow().then(() => {
      sendResponse({ success: true });
    }).catch(error => {
      console.error('Failed to rotate fingerprint:', error);
      sendResponse({ success: false, error: error.message });
    });
    return true;
  }

  if (message.type === 'UPDATE_ROTATION_CONFIG') {
    setupRotationAlarm().then(() => {
      sendResponse({ success: true });
    }).catch(error => {
      console.error('Failed to update rotation config:', error);
      sendResponse({ success: false, error: error.message });
    });
    return true;
  }
});

// Diagnostics (P2): which hook installers failed on the most recent page load,
// and when. Lives in storage.session so it is per-browser-session state, never
// synced and never written to disk; the badge is the user-visible part.
const DIAGNOSTICS_KEY = 'ss_diagnostics';

async function getDiagnostics() {
  const result = await chrome.storage.session.get([DIAGNOSTICS_KEY]);
  return result[DIAGNOSTICS_KEY] || {
    failedInstallers: 0,
    totalInstallers: 0,
    lastFailureAt: null,
    lastFailureOrigin: null
  };
}

async function reportHookStatus(failed, total, origin) {
  const previous = await getDiagnostics();
  const diagnostics = {
    failedInstallers: Number(failed) > 0 ? Number(failed) : 0,
    totalInstallers: Number(total) > 0 ? Number(total) : previous.totalInstallers,
    // Keep the last real failure around even after a clean load, so Diagnostics
    // can say when the problem was last seen instead of going blank.
    lastFailureAt: Number(failed) > 0 ? new Date().toISOString() : previous.lastFailureAt,
    lastFailureOrigin: Number(failed) > 0 ? (origin || null) : previous.lastFailureOrigin
  };
  await chrome.storage.session.set({ [DIAGNOSTICS_KEY]: diagnostics });

  try {
    if (diagnostics.failedInstallers > 0) {
      await chrome.action.setBadgeBackgroundColor({ color: '#e5484d' });
      await chrome.action.setBadgeText({ text: '!' });
    } else {
      await chrome.action.setBadgeText({ text: '' });
    }
  } catch (e) {
    // Badge updates are best-effort (no window may be open).
  }

  return diagnostics;
}

// Serialize statistics read-modify-write. Content scripts flush on independent
// timers, so two overlapping updateStatistics() calls could both read the same
// snapshot and the later write silently discarded the earlier increments.
// Chaining every update onto one promise makes the cycle atomic per worker.
let statsQueue = Promise.resolve();

function updateStatistics(data, tabUrl, senderUrl) {
  const run = statsQueue.then(() => applyStatistics(data, tabUrl, senderUrl), () => applyStatistics(data, tabUrl, senderUrl));
  // Keep the chain alive after a failure without unhandled rejections.
  statsQueue = run.catch(() => {});
  return run;
}

async function applyStatistics(data, tabUrl, senderUrl) {
  try {
    const result = await chrome.storage.local.get(['ss_stats']);
    let stats = result.ss_stats || {};

    // Convert Set to Array for storage, then back to Set
    let sitesProtected = new Set(stats.sitesProtectedArray || []);

    // Add current origin to sites protected.
    // P2: sender.tab is undefined for messages from the popup/options pages, so
    // a future UI-originated UPDATE_STATS would silently skip this. Fall back
    // to sender.url, and only count http(s) origins: a chrome-extension:// URL
    // is the extension talking to itself, not a protected site.
    const sourceUrl = tabUrl || senderUrl;
    if (sourceUrl) {
      try {
        const parsed = new URL(sourceUrl);
        if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
          sitesProtected.add(parsed.origin);
        }
      } catch (e) {
        // Invalid URL, skip
      }
    }

    // Update counters
    stats = {
      sitesProtectedArray: Array.from(sitesProtected),
      sitesProtected: sitesProtected.size,
      totalCanvasReads: (stats.totalCanvasReads || 0) + (data.canvasReads || 0),
      totalWebGLCalls: (stats.totalWebGLCalls || 0) + (data.webglCalls || 0),
      totalAudioCalls: (stats.totalAudioCalls || 0) + (data.audioCalls || 0),
      totalNavigatorReads: (stats.totalNavigatorReads || 0) + (data.navigatorReads || 0),
      totalWebRTCCalls: (stats.totalWebRTCCalls || 0) + (data.webrtcCalls || 0),
      totalScreenReads: (stats.totalScreenReads || 0) + (data.screenReads || 0),
      totalFontReads: (stats.totalFontReads || 0) + (data.fontReads || 0),
      totalTimezoneReads: (stats.totalTimezoneReads || 0) + (data.timezoneReads || 0),
      totalSensorReads: (stats.totalSensorReads || 0) + (data.sensorReads || 0),
      totalMediaCodecReads: (stats.totalMediaCodecReads || 0) + (data.mediaCodecReads || 0),
      totalDrmReads: (stats.totalDrmReads || 0) + (data.drmReads || 0),
      totalGeolocationReads: (stats.totalGeolocationReads || 0) + (data.geolocationReads || 0),
      totalTouchReads: (stats.totalTouchReads || 0) + (data.touchReads || 0),
      lastUpdate: new Date().toISOString(),
      lastReset: stats.lastReset || new Date().toISOString()
    };

    await chrome.storage.local.set({ ss_stats: stats });
  } catch (error) {
    console.error('Error updating statistics:', error);
    throw error;
  }
}

async function getStatistics() {
  const result = await chrome.storage.local.get(['ss_stats']);
  const stats = result.ss_stats || {};

  // Ensure sitesProtected is a number
  if (!stats.sitesProtected && stats.sitesProtectedArray) {
    stats.sitesProtected = stats.sitesProtectedArray.length;
  }

  return stats;
}

async function resetStatistics() {
  await chrome.storage.local.set({
    ss_stats: {
      sitesProtectedArray: [],
      sitesProtected: 0,
      totalCanvasReads: 0,
      totalWebGLCalls: 0,
      totalAudioCalls: 0,
      totalNavigatorReads: 0,
      totalWebRTCCalls: 0,
      totalScreenReads: 0,
      totalFontReads: 0,
      totalTimezoneReads: 0,
      totalSensorReads: 0,
      totalMediaCodecReads: 0,
      totalDrmReads: 0,
      totalGeolocationReads: 0,
      totalTouchReads: 0,
      lastReset: new Date().toISOString()
    }
  });
}

// ============================================================================
// AUTOMATIC FINGERPRINT ROTATION
// ============================================================================

// Check if fingerprint should be rotated on startup
async function checkRotateOnStartup() {
  const result = await chrome.storage.local.get(['ssConfig']);
  const config = result.ssConfig || {};

  if (config.rotateOnStartup === true) {
    console.log('[ShapeShift Rotation] Rotating fingerprint on startup');
    await rotateFingerprintNow();
  }
}

// Check if scheduled rotation is needed
async function checkAndRotateFingerprint() {
  const result = await chrome.storage.local.get(['ssConfig', 'ss_rotation_info']);
  const config = result.ssConfig || {};
  const rotationInfo = result.ss_rotation_info || {};

  if (!config.autoRotateFingerprint) {
    return; // Auto-rotation disabled
  }

  // Same clamp as setupRotationAlarm(): a 0.5 h setting must mean 30 minutes
  // here too, or the alarm fires while this check still thinks 24 h remain.
  const intervalHours = Math.max(0.5, Number(config.rotationIntervalHours) || 24);
  const intervalMs = intervalHours * 60 * 60 * 1000;
  const lastRotation = rotationInfo.lastRotation ? new Date(rotationInfo.lastRotation) : new Date(0);
  const now = new Date();
  const timeSinceRotation = now - lastRotation;

  if (timeSinceRotation >= intervalMs) {
    console.log(`[ShapeShift Rotation] Time for scheduled rotation (${intervalHours}h interval)`);
    await rotateFingerprintNow();
  } else {
    const nextRotation = new Date(lastRotation.getTime() + intervalMs);
    const timeUntil = nextRotation - now;
    console.log(`[ShapeShift Rotation] Next rotation in ${Math.round(timeUntil / 1000 / 60)} minutes`);
  }
}

// Setup alarm to periodically check for rotation
async function setupRotationAlarm() {
  // Clear any existing alarms
  await chrome.alarms.clear('fingerprint-rotation-check');

  const result = await chrome.storage.local.get(['ssConfig']);
  const config = result.ssConfig || {};

  if (config.autoRotateFingerprint) {
    // Track the configured interval instead of a hard-coded hour, so a
    // sub-hour rotation setting is honoured rather than delayed by up to 60 min.
    const intervalHours = Math.max(0.5, Number(config.rotationIntervalHours) || 24);
    const periodInMinutes = Math.max(1, Math.round(intervalHours * 60));
    await chrome.alarms.create('fingerprint-rotation-check', { periodInMinutes });
    console.log(`[ShapeShift Rotation] Rotation alarm set (checks every ${periodInMinutes} minutes)`);
  }
}

// Listen for alarm
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'fingerprint-rotation-check') {
    await checkAndRotateFingerprint();
  } else if (alarm.name === SALT_GUARD_ALARM) {
    await reloadStaleTabs();
  }
});

// Perform fingerprint rotation
async function rotateFingerprintNow() {
  try {
    // Generate new salt (removes old one, forcing regeneration)
    await chrome.storage.local.remove('ss_salt');

    // Feature 5.4: advance the generation so every already-stamped tab counts
    // as stale and is reloaded once it is next activated (see the salt guard
    // below). The stamp is what makes a bfcache restore detectable at all.
    await bumpSaltGeneration();

    // Update rotation info
    const result = await chrome.storage.local.get(['ss_rotation_info']);
    const rotationInfo = result.ss_rotation_info || {};

    await chrome.storage.local.set({
      ss_rotation_info: {
        lastRotation: new Date().toISOString(),
        rotationCount: (rotationInfo.rotationCount || 0) + 1
      }
    });

    console.log('[ShapeShift Rotation] Fingerprint rotated successfully');

    // Both side effects are opt-in (Security 3): a background rotation used to
    // reload every open tab and raise an OS notification unconditionally, which
    // is invasive and impossible to decline. Read the switches here rather than
    // at the call sites so every rotation path honours them.
    const cfgResult = await chrome.storage.local.get(['ssConfig']);
    const cfg = cfgResult.ssConfig || {};

    // Reload open http(s) tabs so they pick up the new identity. Only the pages
    // the extension actually protects are touched; chrome:// and other
    // privileged surfaces are left alone.
    if (cfg.reloadTabsOnRotation !== false) {
      const tabs = await chrome.tabs.query({});
      for (const tab of tabs) {
        if (tab.url && !tab.url.startsWith('chrome://') && !tab.url.startsWith('chrome-extension://')) {
          try {
            await chrome.tabs.reload(tab.id);
          } catch (e) {
            // Tab might not be reloadable, skip
          }
        }
      }
    }

    // Send notification
    if (cfg.notifyOnRotation !== false) {
      try {
        await chrome.notifications.create({
          type: 'basic',
          iconUrl: chrome.runtime.getURL('images/icon128.png'),
          title: 'Fingerprint Rotated',
          message: 'Your browser fingerprint has been automatically rotated.',
          priority: 1
        });
      } catch (e) {
        // Notifications might not be available
      }
    }
  } catch (error) {
    console.error('[ShapeShift Rotation] Failed to rotate fingerprint:', error);
  }
}

// Get rotation status (for UI)
async function getRotationStatus() {
  const result = await chrome.storage.local.get(['ssConfig', 'ss_rotation_info']);
  const config = result.ssConfig || {};
  const rotationInfo = result.ss_rotation_info || {};

  if (!config.autoRotateFingerprint) {
    return {
      enabled: false,
      nextRotation: null,
      lastRotation: rotationInfo.lastRotation || null,
      rotationCount: rotationInfo.rotationCount || 0
    };
  }

  // Keep the status countdown consistent with the alarm that drives it.
  const intervalHours = Math.max(0.5, Number(config.rotationIntervalHours) || 24);
  const intervalMs = intervalHours * 60 * 60 * 1000;
  const lastRotation = rotationInfo.lastRotation ? new Date(rotationInfo.lastRotation) : new Date();
  const nextRotation = new Date(lastRotation.getTime() + intervalMs);

  return {
    enabled: true,
    intervalHours,
    nextRotation: nextRotation.toISOString(),
    lastRotation: rotationInfo.lastRotation || null,
    rotationCount: rotationInfo.rotationCount || 0,
    rotateOnStartup: config.rotateOnStartup || false
  };
}

// ============================================================================
// SALT-CHANGE GUARD (Feature 5.4)
//
// A tab restored from the back/forward cache is NOT re-executed: its content
// scripts keep the hooks and the seed they were given on the original load, so
// after a rotation that tab still advertises the previous identity. Nothing
// noticed, because no navigation event fires on a bfcache restore.
//
// The guard stamps every completed tab load with the salt generation that was
// current at that moment (storage.session, per browser session) and compares it
// again when the tab is activated and when the periodic alarm fires. A tab
// whose stamp is older than the live generation is reloaded so it re-derives
// the new identity.
// ============================================================================
const SALT_GENERATION_KEY = 'ss_salt_generation';
const TAB_STAMP_PREFIX = 'ss_tab_gen_';
const SALT_GUARD_ALARM = 'salt-integrity-check';

async function getSaltGeneration() {
  const result = await chrome.storage.local.get([SALT_GENERATION_KEY]);
  return Number(result[SALT_GENERATION_KEY]) || 0;
}

// Bumped by rotateFingerprintNow(). A missing key means generation 0, which is
// exactly the state of a profile that has never rotated.
async function bumpSaltGeneration() {
  const next = (await getSaltGeneration()) + 1;
  await chrome.storage.local.set({ [SALT_GENERATION_KEY]: next });
  return next;
}

async function stampTab(tabId) {
  if (typeof tabId !== 'number') return;
  const generation = await getSaltGeneration();
  await chrome.storage.session.set({ [TAB_STAMP_PREFIX + tabId]: generation });
}

async function isTabStale(tabId) {
  if (typeof tabId !== 'number') return false;
  const key = TAB_STAMP_PREFIX + tabId;
  const result = await chrome.storage.session.get([key]);
  const stamped = result[key];
  // A tab we never stamped (pre-existing session, extension just updated) is
  // not reloaded: the guard must not start by closing the user's pages.
  if (typeof stamped !== 'number') return false;
  return stamped < (await getSaltGeneration());
}

function isReloadable(url) {
  return !!url && !url.startsWith('chrome://') && !url.startsWith('chrome-extension://') &&
    !url.startsWith('devtools://') && !url.startsWith('edge://') && !url.startsWith('about:');
}

// Reload every stamped-but-stale tab. Used by the periodic alarm; the activation
// path only ever reloads the tab the user just brought to the foreground.
async function reloadStaleTabs() {
  const generation = await getSaltGeneration();
  const tabs = await chrome.tabs.query({});
  let reloaded = 0;
  for (const tab of tabs) {
    if (!isReloadable(tab.url)) continue;
    const key = TAB_STAMP_PREFIX + tab.id;
    const result = await chrome.storage.session.get([key]);
    const stamped = result[key];
    if (typeof stamped !== 'number' || stamped >= generation) continue;
    try {
      await chrome.tabs.reload(tab.id);
      reloaded++;
    } catch (e) {
      // Tab disappeared mid-loop; skip it.
    }
  }
  return reloaded;
}

async function setupSaltGuardAlarm() {
  await chrome.alarms.clear(SALT_GUARD_ALARM);
  // 30 minutes is the shortest period Chrome reliably honours for a packed
  // extension and is far below the shortest rotation interval the UI offers.
  await chrome.alarms.create(SALT_GUARD_ALARM, { periodInMinutes: 30 });
}

// Stamp on every completed load, so a normal navigation refreshes the stamp and
// only a bfcache restore can leave a tab behind.
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status !== 'complete') return;
  stampTab(tabId).catch(() => {});
});

// bfcache restores are invisible to onUpdated; activation is the hook we get.
chrome.tabs.onActivated.addListener(async (activeInfo) => {
  try {
    if (!(await isTabStale(activeInfo.tabId))) return;
    const tab = await chrome.tabs.get(activeInfo.tabId);
    if (!isReloadable(tab.url)) return;
    await chrome.tabs.reload(activeInfo.tabId);
  } catch (e) {
    // Best effort: never break tab switching over a stale stamp.
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.session.remove([TAB_STAMP_PREFIX + tabId]).catch(() => {});
});
