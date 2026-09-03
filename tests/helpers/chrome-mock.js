'use strict';
/* In-memory mock of the subset of chrome.* APIs used by SiteBlock.
 * Functional (not just stubs): storage actually stores, DNR actually
 * keeps rules, tabs.update logs redirects — so tests exercise real logic.
 */
const fs = require('node:fs');

function makeListener() {
  const fns = [];
  return {
    fns,
    addListener(fn) { fns.push(fn); },
    async fire(...args) {
      for (const fn of fns) await fn(...args);
    },
    get last() { return fns[fns.length - 1]; },
    get count() { return fns.length; },
  };
}

function storageArea(mock, areaName) {
  return {
    get(keys, cb) {
      const store = mock._stores[areaName];
      let out = {};
      if (keys === null || keys === undefined) out = { ...store };
      else if (typeof keys === 'string') { if (keys in store) out[keys] = store[keys]; }
      else if (Array.isArray(keys)) { for (const k of keys) if (k in store) out[k] = store[k]; }
      else if (typeof keys === 'object') {
        for (const [k, def] of Object.entries(keys)) out[k] = k in store ? store[k] : def;
      }
      if (typeof cb === 'function') cb(out);
      return Promise.resolve(out);
    },
    set(obj, cb) {
      const store = mock._stores[areaName];
      const changes = {};
      for (const [k, v] of Object.entries(obj)) {
        changes[k] = { oldValue: store[k], newValue: v };
        store[k] = v;
      }
      if (typeof cb === 'function') cb();
      // Fire onChanged like real Chrome (async microtask).
      queueMicrotask(() => mock.storage.onChanged.fire(changes, areaName));
      return Promise.resolve();
    },
    remove(keys, cb) {
      const store = mock._stores[areaName];
      const arr = Array.isArray(keys) ? keys : [keys];
      for (const k of arr) delete store[k];
      if (typeof cb === 'function') cb();
      return Promise.resolve();
    },
    clear(cb) {
      mock._stores[areaName] = {};
      if (typeof cb === 'function') cb();
      return Promise.resolve();
    },
  };
}

function createChromeMock() {
  const mock = {
    _stores: { local: {}, sync: {} },
    _dnrRules: [],
    _tabsUpdated: [], // { tabId, url }
    _tabsCreated: [],
    _alarms: {},
    lastError: undefined,

    storage: null,
    declarativeNetRequest: null,
    tabs: null,
    runtime: null,
    webNavigation: null,
    alarms: null,
  };

  const onChanged = makeListener();
  mock.storage = {
    local: storageArea(mock, 'local'),
    sync: storageArea(mock, 'sync'),
    onChanged,
  };

  mock.declarativeNetRequest = {
    async getDynamicRules() { return mock._dnrRules.map((r) => ({ ...r })); },
    async updateDynamicRules({ removeRuleIds = [], addRules = [] } = {}) {
      mock._dnrRules = mock._dnrRules.filter((r) => !removeRuleIds.includes(r.id));
      for (const rule of addRules) {
        if (mock._dnrRules.some((r) => r.id === rule.id)) {
          throw new Error(`Duplicate rule id ${rule.id}`);
        }
        mock._dnrRules.push(JSON.parse(JSON.stringify(rule)));
      }
    },
  };

  const onUpdated = makeListener();
  mock.tabs = {
    onUpdated,
    async update(tabId, props) {
      mock._tabsUpdated.push({ tabId, url: props.url });
      return { id: tabId, ...props };
    },
    async create(props) {
      mock._tabsCreated.push(props);
      return { id: 999, ...props };
    },
    async query() { return []; },
  };

  const onInstalled = makeListener();
  const onStartup = makeListener();
  const onMessage = makeListener();
  const onAlarm = makeListener();
  mock.runtime = {
    onInstalled, onStartup, onMessage,
    getURL(path) { return `chrome-extension://test-id/${path.replace(/^\//, '')}`; },
    openOptionsPage: undefined, // intentionally undefined; pages handle fallback
    sendMessage(msg, cb) {
      // Route to the background onMessage handler like real Chrome.
      const handler = onMessage.last;
      if (!handler) { if (cb) cb(undefined); return Promise.resolve(undefined); }
      return new Promise((resolve) => {
        let responded = false;
        const sendResponse = (resp) => { responded = true; if (cb) cb(resp); resolve(resp); };
        const ret = handler(msg, {}, sendResponse);
        // Background returns true (async). Resolve is via sendResponse.
        if (ret !== true) setTimeout(() => { if (!responded) { if (cb) cb(undefined); resolve(undefined); } }, 10);
      });
    },
  };

  mock.webNavigation = {
    onBeforeNavigate: makeListener(),
    onHistoryStateUpdated: makeListener(),
  };

  mock.alarms = {
    onAlarm: onAlarm,
    async create(name, info) { mock._alarms[name] = info; },
    async clear(name) {
      if (name === undefined) { const had = Object.keys(mock._alarms).length > 0; mock._alarms = {}; return had; }
      const had = name in mock._alarms;
      delete mock._alarms[name];
      return had;
    },
  };
  // Convenience alias used by background.js
  mock.alarms.onAlarm = onAlarm;

  mock._reset = () => {
    mock._stores = { local: {}, sync: {} };
    mock._dnrRules = [];
    mock._tabsUpdated = [];
    mock._tabsCreated = [];
    mock._alarms = {};
  };

  return mock;
}

module.exports = { createChromeMock, makeListener, fs };
