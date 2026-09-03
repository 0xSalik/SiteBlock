'use strict';
/* Tests for js/content.js — runs in a vm sandbox with mocked window/chrome. */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const CONTENT_SRC = fs.readFileSync(path.join(__dirname, '..', 'js', 'content.js'), 'utf8');

function runContent({ href, protocol = 'https:', topFrame = true, match = null, lastError = false }) {
  const calls = { stopped: false, replacedWith: null, messages: [] };
  const win = {
    location: {
      href,
      protocol,
      replace(url) { calls.replacedWith = url; },
    },
    top: null,
    self: null,
    stop() { calls.stopped = true; },
  };
  win.top = topFrame ? win.self = win : {};
  if (topFrame) win.self = win;
  else win.self = {};

  const chrome = {
    runtime: {
      lastError: lastError ? { message: 'nope' } : undefined,
      getURL(p) { return `chrome-extension://test-id/${p}`; },
      sendMessage(msg, cb) {
        calls.messages.push(msg);
        cb({ match });
      },
    },
  };
  const sandbox = { window: win, chrome, console, URL, encodeURIComponent };
  // content.js references bare `window` and `chrome`.
  vm.createContext(sandbox);
  vm.runInContext(CONTENT_SRC, sandbox, { filename: 'content.js' });
  return calls;
}

describe('content.js fallback', () => {
  it('redirects (history-free) on match and stops the page', () => {
    const calls = runContent({ href: 'https://m.facebook.com/feed', match: 'facebook.com' });
    assert.equal(calls.stopped, true);
    assert.match(calls.replacedWith, /blocked\.html\?u=/);
    assert.match(decodeURIComponent(calls.replacedWith), /m\.facebook\.com/);
    assert.match(calls.replacedWith, /p=facebook\.com/);
    assert.equal(calls.messages[0].type, 'checkUrl');
  });

  it('does nothing when there is no match', () => {
    const calls = runContent({ href: 'https://example.com/', match: null });
    assert.equal(calls.replacedWith, null);
    assert.equal(calls.stopped, false);
  });

  it('ignores non-http(s) pages', () => {
    for (const href of ['chrome://extensions/', 'about:blank', 'file:///tmp/x.html']) {
      const calls = runContent({ href, match: 'facebook.com' });
      assert.equal(calls.messages.length, 0, href);
      assert.equal(calls.replacedWith, null, href);
    }
  });

  it('ignores chrome-extension pages and subframes', () => {
    const ext = runContent({
      href: 'chrome-extension://test-id/html/blocked.html',
      protocol: 'chrome-extension:',
      match: 'facebook.com',
    });
    assert.equal(ext.messages.length, 0);

    const sub = runContent({ href: 'https://facebook.com/', topFrame: false, match: 'facebook.com' });
    assert.equal(sub.messages.length, 0);
    assert.equal(sub.replacedWith, null);
  });

  it('swallows runtime.lastError without crashing', () => {
    const calls = runContent({ href: 'https://facebook.com/', match: 'facebook.com', lastError: true });
    assert.equal(calls.replacedWith, null);
  });
});
