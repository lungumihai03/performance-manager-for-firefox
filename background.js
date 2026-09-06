const DEFAULTS = {
  enabled: true,
  idleMinutes: 1,
  checkSeconds: 5,

  // Resource-control style setting:
  // keep at most this many non-discarded tabs awake.
  maxAwakeTabsEnabled: false,
  maxAwakeTabs: 8,

  skipPinned: true,
  skipAudible: true,
  skipPlaying: true,
  skipPrivate: false,
  excludedDomains: []
};

const ALARM = "ram-saver-check";
const STATE_KEY = "tabInactiveSince";
const LOG_KEY = "activityLog";
const LOG_LIMIT = 200;

async function getSettings() {
  return browser.storage.local.get(DEFAULTS);
}

async function addLog(type, title, detail = "") {
  const data = await browser.storage.local.get({ [LOG_KEY]: [] });
  const log = Array.isArray(data[LOG_KEY]) ? data[LOG_KEY] : [];
  log.unshift({ time: Date.now(), type, title, detail });
  if (log.length > LOG_LIMIT) log.length = LOG_LIMIT;
  await browser.storage.local.set({ [LOG_KEY]: log });
}

async function getLog() {
  const data = await browser.storage.local.get({ [LOG_KEY]: [] });
  return Array.isArray(data[LOG_KEY]) ? data[LOG_KEY] : [];
}

async function getState() {
  const data = await browser.storage.local.get({ [STATE_KEY]: {} });
  return data[STATE_KEY] || {};
}

async function saveState(state) {
  await browser.storage.local.set({ [STATE_KEY]: state });
}

function domainOf(url) {
  try { return new URL(url).hostname.toLowerCase(); }
  catch (_) { return ""; }
}

function isExcluded(url, domains) {
  const host = domainOf(url);
  return domains.some(item => {
    const d = String(item).trim().toLowerCase();
    return d && (host === d || host.endsWith("." + d));
  });
}

function canDiscard(tab, cfg) {
  if (!tab || !tab.id || tab.active || tab.discarded) return false;
  if (cfg.skipPinned && tab.pinned) return false;
  if (cfg.skipAudible && tab.audible) return false;
  if (cfg.skipPlaying && tab.status === "loading") return false;
  if (cfg.skipPrivate && tab.incognito) return false;
  if (isExcluded(tab.url, cfg.excludedDomains)) return false;
  return true;
}

async function cleanupState(tabs, state) {
  const ids = new Set(tabs.map(t => String(t.id)));
  let changed = false;

  for (const key of Object.keys(state)) {
    if (!ids.has(key)) {
      delete state[key];
      changed = true;
    }
  }

  for (const tab of tabs) {
    const key = String(tab.id);
    if (tab.active || tab.discarded) {
      if (state[key] !== undefined) {
        delete state[key];
        changed = true;
      }
    }
  }

  return changed;
}

async function ensureInactiveTimestamps(tabs, state) {
  const now = Date.now();
  let changed = false;

  for (const tab of tabs) {
    if (!tab.id || tab.active || tab.discarded) continue;

    const key = String(tab.id);
    if (state[key] === undefined) {
      state[key] = now;
      changed = true;
    }
  }

  return changed;
}

async function discardTab(tabId, state) {
  try {
    const tab = await browser.tabs.get(tabId);
    await browser.tabs.discard(tabId);
    delete state[String(tabId)];
    await addLog("success", "Tab put to sleep", tab.title || domainOf(tab.url) || `Tab ${tabId}`);
    return true;
  } catch (_) {
    await addLog("error", "Could not sleep tab", `Tab ${tabId}`);
    return false;
  }
}

async function enforceMaxAwakeTabs(tabs, state, cfg) {
  if (!cfg.maxAwakeTabsEnabled) return 0;

  const limit = Math.max(1, Number(cfg.maxAwakeTabs));
  const awake = tabs.filter(t => t.id && !t.discarded);
  const active = awake.filter(t => t.active);
  const inactiveAwake = awake.filter(t => !t.active);

  // Active tabs cannot be discarded. If several windows are active,
  // those active tabs are always protected.
  let excess = awake.length - limit;
  if (excess <= 0) return 0;

  // Oldest inactive tabs are discarded first.
  inactiveAwake.sort((a, b) => {
    const ta = Number(state[String(a.id)] || 0);
    const tb = Number(state[String(b.id)] || 0);
    return ta - tb;
  });

  let count = 0;

  for (const tab of inactiveAwake) {
    if (excess <= 0) break;
    if (!canDiscard(tab, cfg)) continue;

    if (await discardTab(tab.id, state)) {
      count++;
      excess--;
    }
  }

  return count;
}

async function discardInactive() {
  const cfg = await getSettings();
  if (!cfg.enabled) return { discarded: 0, skipped: 0 };

  const tabs = await browser.tabs.query({});
  const state = await getState();

  let stateChanged = await cleanupState(tabs, state);
  stateChanged = (await ensureInactiveTimestamps(tabs, state)) || stateChanged;

  const now = Date.now();
  const timeoutMs = Math.max(1, Number(cfg.idleMinutes)) * 60000;

  let discarded = 0;
  let skipped = 0;

  // First enforce the optional "maximum awake tabs" limit.
  discarded += await enforceMaxAwakeTabs(tabs, state, cfg);

  // Re-query because the previous operation may have changed tab state.
  const currentTabs = await browser.tabs.query({});

  for (const tab of currentTabs) {
    if (!tab.id || tab.active || tab.discarded) continue;

    const key = String(tab.id);

    if (state[key] === undefined) {
      state[key] = now;
      stateChanged = true;
      continue;
    }

    if (now - Number(state[key]) < timeoutMs) continue;

    if (!canDiscard(tab, cfg)) {
      skipped++;
      continue;
    }

    if (await discardTab(tab.id, state)) {
      discarded++;
      stateChanged = true;
    } else {
      skipped++;
    }
  }

  if (stateChanged || discarded > 0) {
    await saveState(state);
  }

  await updateBadge();
  return { discarded, skipped };
}

async function freeMemoryNow() {
  const cfg = await getSettings();
  const tabs = await browser.tabs.query({});
  const state = await getState();

  let changed = await cleanupState(tabs, state);
  changed = (await ensureInactiveTimestamps(tabs, state)) || changed;

  let discarded = 0;
  let skipped = 0;

  // One-click cleanup: discard every eligible inactive tab.
  for (const tab of tabs) {
    if (!canDiscard(tab, cfg)) {
      if (tab.id && !tab.active && !tab.discarded) skipped++;
      continue;
    }

    if (await discardTab(tab.id, state)) {
      discarded++;
      changed = true;
    } else {
      skipped++;
    }
  }

  if (changed) await saveState(state);
  await addLog("info", "Manual memory cleanup", `${discarded} tab${discarded === 1 ? "" : "s"} put to sleep`);
  await updateBadge();
  return { discarded, skipped };
}


async function updateBadge() {
  try {
    const tabs = await browser.tabs.query({});
    const sleeping = tabs.filter(t => t.discarded).length;
    await browser.browserAction.setBadgeText({ text: sleeping ? String(Math.min(99, sleeping)) : "" });
    if (sleeping) await browser.browserAction.setBadgeBackgroundColor({ color: "#2f8f58" });
  } catch (_) {}
}

async function ensureAlarm() {
  const cfg = await getSettings();
  await browser.alarms.clear(ALARM);

  if (!cfg.enabled) return;

  const seconds = Math.max(5, Number(cfg.checkSeconds));

  await browser.alarms.create(ALARM, {
    delayInMinutes: seconds / 60,
    periodInMinutes: seconds / 60
  });
}

browser.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const tab = await browser.tabs.get(tabId);
    if (tab.discarded) {
      await addLog("info", "Tab restored", tab.title || domainOf(tab.url) || `Tab ${tabId}`);
    }
  } catch (_) {}
  await markTabActive(tabId);

  const tabs = await browser.tabs.query({});
  const state = await getState();
  let changed = await ensureInactiveTimestamps(tabs, state);

  if (changed) await saveState(state);

  // Optional resource-control limit is enforced immediately after
  // switching tabs, rather than waiting for the next alarm.
  const cfg = await getSettings();
  if (cfg.enabled && cfg.maxAwakeTabsEnabled) {
    const freshTabs = await browser.tabs.query({});
    const freshState = await getState();
    const count = await enforceMaxAwakeTabs(freshTabs, freshState, cfg);
    if (count) await saveState(freshState);
  }
});

async function markTabActive(tabId) {
  const state = await getState();
  const key = String(tabId);

  if (state[key] !== undefined) {
    delete state[key];
    await saveState(state);
  }
}

browser.tabs.onCreated.addListener(async tab => {
  const state = await getState();
  const key = String(tab.id);

  if (tab.active) delete state[key];
  else state[key] = Date.now();

  await saveState(state);
});

browser.tabs.onRemoved.addListener(async tabId => {
  const state = await getState();
  delete state[String(tabId)];
  await saveState(state);
});

browser.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  const state = await getState();
  const key = String(tabId);

  if (tab.active) {
    if (state[key] !== undefined) {
      delete state[key];
      await saveState(state);
    }
  } else if (!tab.discarded && state[key] === undefined) {
    state[key] = Date.now();
    await saveState(state);
  }
});

browser.alarms.onAlarm.addListener(async alarm => {
  if (alarm.name === ALARM) await discardInactive();
});

browser.runtime.onMessage.addListener(async message => {
  if (message?.type === "discardNow") return discardInactive();
  if (message?.type === "freeMemory") return freeMemoryNow();

  if (message?.type === "getStatus") {
    const cfg = await getSettings();
    const tabs = await browser.tabs.query({});
    const state = await getState();

    return {
      enabled: cfg.enabled,
      idleMinutes: cfg.idleMinutes,
      checkSeconds: cfg.checkSeconds,
      maxAwakeTabsEnabled: cfg.maxAwakeTabsEnabled,
      maxAwakeTabs: cfg.maxAwakeTabs,
      total: tabs.length,
      discarded: tabs.filter(t => t.discarded).length,
      active: tabs.filter(t => t.active).length,
      awake: tabs.filter(t => !t.discarded).length,
      timers: Object.keys(state).length
    };
  }

  if (message?.type === "getLog") {
    return getLog();
  }

  if (message?.type === "clearLog") {
    await browser.storage.local.set({ [LOG_KEY]: [] });
    return { ok: true };
  }

  if (message?.type === "reloadAlarm") {
    await ensureAlarm();
    return { ok: true };
  }
});

browser.runtime.onStartup.addListener(async () => {
  await initialize();
  await ensureAlarm();
});

browser.runtime.onInstalled.addListener(async details => {
  const current = await browser.storage.local.get();
  const missing = {};
  for (const [key, value] of Object.entries(DEFAULTS)) {
    if (current[key] === undefined) missing[key] = value;
  }
  if (Object.keys(missing).length) await browser.storage.local.set(missing);
  if (details.reason === "install") {
    await addLog("info", "Extension installed", "Performance Manager for Firefox 1.0.1");
  } else if (details.reason === "update") {
    await addLog("info", "Extension updated", "Performance Manager for Firefox 1.0.1");
  }
  await initialize();
  await ensureAlarm();
});

async function initialize() {
  const tabs = await browser.tabs.query({});
  const state = await getState();

  let changed = await cleanupState(tabs, state);
  changed = (await ensureInactiveTimestamps(tabs, state)) || changed;

  if (changed) await saveState(state);
  await updateBadge();
}

(async () => {
  await initialize();
  await ensureAlarm();
})();