'use strict';
/* Static integrity tests: manifest schema, file references, page wiring. */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

describe('manifest.json', () => {
  it('is MV3 with required keys', () => {
    assert.equal(manifest.manifest_version, 3);
    assert.ok(manifest.name);
    assert.match(manifest.version, /^\d+\.\d+\.\d+/);
    assert.ok(manifest.description);
  });

  it('declares all permissions the code needs', () => {
    for (const p of ['storage', 'webNavigation', 'tabs', 'declarativeNetRequest', 'alarms']) {
      assert.ok(manifest.permissions.includes(p), `missing permission ${p}`);
    }
    assert.ok(manifest.host_permissions.some((h) => h.includes('https')), 'needs https host access');
  });

  it('wires background, popup, options, content scripts to real files', () => {
    assert.ok(fs.existsSync(path.join(ROOT, manifest.background.service_worker)));
    assert.ok(fs.existsSync(path.join(ROOT, manifest.action.default_popup)));
    assert.ok(fs.existsSync(path.join(ROOT, manifest.options_ui.page)));
    assert.notEqual(manifest.action.default_popup, manifest.options_ui.page, 'popup must not be the options page');
    for (const cs of manifest.content_scripts) {
      for (const js of cs.js) assert.ok(fs.existsSync(path.join(ROOT, js)), `missing ${js}`);
      assert.ok(cs.run_at === 'document_start', 'content script must run at document_start');
    }
    for (const size of ['16', '48', '128']) {
      assert.ok(fs.existsSync(path.join(ROOT, manifest.icons[size])), `missing icon ${size}`);
    }
  });
});

describe('html pages', () => {
  it('options.html loads matcher+options, has every ID options.js needs', () => {
    const html = read('html/options.html');
    assert.match(html, /js\/matcher\.js/);
    assert.match(html, /js\/options\.js/);
    assert.ok(!html.includes('siteblock.js'), 'dead siteblock.js reference must be gone');
    for (const id of ['msg', 'newSite', 'addBtn', 'search', 'siteList', 'siteCount',
      'emptyNote', 'pauseState', 'statsLine', 'exportBtn', 'importToggle',
      'importBox', 'importText', 'importConfirm', 'clearBtn', 'resumeBtn']) {
      assert.match(html, new RegExp(`id="${id}"`), `options.html missing #${id}`);
    }
  });

  it('popup.html loads matcher+popup, has every ID popup.js needs', () => {
    const html = read('html/popup.html');
    assert.match(html, /js\/matcher\.js/);
    assert.match(html, /js\/popup\.js/);
    for (const id of ['currentHost', 'stateLine', 'toggleBtn', 'optionsBtn',
      'resumeBtn', 'msg', 'statsLine', 'openOptions']) {
      assert.match(html, new RegExp(`id="${id}"`), `popup.html missing #${id}`);
    }
  });

  it('blocked.html loads matcher+blocked, has every ID blocked.js needs', () => {
    const html = read('html/blocked.html');
    assert.match(html, /js\/matcher\.js/);
    assert.match(html, /js\/blocked\.js/);
    for (const id of ['blockedUrl', 'patternLine', 'backBtn', 'allowBtn', 'manageBtn', 'quote']) {
      assert.match(html, new RegExp(`id="${id}"`), `blocked.html missing #${id}`);
    }
  });
});

describe('js hygiene', () => {
  it('background uses guarded navigation (frameId/tabId/scheme checks)', () => {
    const src = read('js/background.js');
    assert.match(src, /frameId !== 0/);
    assert.match(src, /tabId < 0/);
    assert.match(src, /\^https\?:/);
    assert.match(src, /onHistoryStateUpdated/);
  });

  it('no file references the deleted siteblock.js', () => {
    for (const f of ['html/options.html', 'html/popup.html', 'html/blocked.html',
      'js/options.js', 'js/popup.js', 'js/background.js', 'js/content.js', 'js/blocked.js']) {
      assert.ok(!read(f).includes('siteblock.js'), f);
    }
  });

  it('all js files parse cleanly', async () => {
    const { execFile } = require('node:child_process');
    for (const f of ['js/matcher.js', 'js/background.js', 'js/content.js',
      'js/options.js', 'js/popup.js', 'js/blocked.js']) {
      await new Promise((resolve, reject) => {
        execFile(process.execPath, ['--check', path.join(ROOT, f)], (err) => (err ? reject(err) : resolve()));
      });
    }
  });
});
