'use strict';
/* Load js/background.js into a vm sandbox backed by the chrome mock.
 * Returns { sandbox, chrome, sendMessage, tick, fire* }.
 */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createChromeMock } = require('./chrome-mock');

const ROOT = path.join(__dirname, '..', '..');

function loadBackground(seedLocal = {}, seedSync = {}) {
  const chrome = createChromeMock();
  Object.assign(chrome._stores.local, seedLocal);
  Object.assign(chrome._stores.sync, seedSync);

  const sandbox = {
    chrome,
    console,
    URL,
    setTimeout,
    clearTimeout,
    Date,
    Math,
    JSON,
    Object,
    Array,
    RegExp,
    String,
    Number,
    Promise,
    queueMicrotask,
  };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  sandbox.window = sandbox;

  const ctx = vm.createContext(sandbox);
  sandbox.importScripts = (...files) => {
    for (const f of files) {
      const code = fs.readFileSync(path.join(ROOT, 'js', path.basename(f)), 'utf8');
      vm.runInContext(code, ctx, { filename: f });
    }
  };

  const bgCode = fs.readFileSync(path.join(ROOT, 'js', 'background.js'), 'utf8');
  vm.runInContext(bgCode, ctx, { filename: 'background.js' });

  // Structured-clone responses like real Chrome message passing does.
  // This also brings values into the main realm so deepStrictEqual works.
  const clone = (v) => {
    if (v === undefined) return v;
    try {
      return JSON.parse(JSON.stringify(v));
    } catch {
      return v;
    }
  };

  const sendMessage = (msg) =>
    new Promise((resolve) => {
      chrome.runtime.onMessage.last(msg, {}, (resp) => resolve(clone(resp)));
    });

  const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

  return {
    sandbox,
    chrome,
    sendMessage,
    tick,
    async fireBeforeNavigate(details) {
      await chrome.webNavigation.onBeforeNavigate.fire(details);
      await tick(15);
    },
    async fireHistoryUpdated(details) {
      await chrome.webNavigation.onHistoryStateUpdated.fire(details);
      await tick(15);
    },
    async fireTabsUpdated(tabId, url) {
      await chrome.tabs.onUpdated.fire(tabId, { url });
      await tick(15);
    },
    getStore() {
      return chrome._stores.local;
    },
  };
}

module.exports = { loadBackground, ROOT };
