'use strict';
/* Unit tests for js/matcher.js — pure functions, no chrome needed. */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const SB = require('../js/matcher.js');

describe('normalize', () => {
  const cases = [
    ['facebook.com', 'facebook.com'],
    ['  Facebook.COM  ', 'facebook.com'],
    ['https://www.facebook.com/', 'facebook.com'],
    ['http://m.facebook.com/profile?q=1#frag', 'm.facebook.com/profile'],
    ['www.youtube.com/shorts/', 'youtube.com/shorts'],
    ['youtube.com/shorts///', 'youtube.com/shorts'],
    ['*.Example.COM', '*.example.com'],
    ['*.www.example.com', '*.example.com'],
    ['*BET*', '*bet*'],
    ['*ads*', '*ads*'],
    ['facebook.com.', 'facebook.com'],
    ['http://localhost:3000/x/', 'localhost/x'],
    ['user:pass@evil.com/path', 'evil.com/path'],
    ['HTTP://WWW.X.COM:443/A?B=C', 'x.com/A'.toLowerCase()],
    ['', ''],
    [null, ''],
    [undefined, ''],
    ['   ', ''],
  ];
  for (const [input, want] of cases) {
    it(`normalize(${JSON.stringify(input)}) === ${JSON.stringify(want)}`, () => {
      assert.equal(SB.normalize(input), want);
    });
  }

  it('keeps path but drops query/hash', () => {
    assert.equal(SB.normalize('youtube.com/shorts?utm=x#y'), 'youtube.com/shorts');
  });
});

describe('isValid', () => {
  const valid = [
    'facebook.com', 'm.facebook.com', 'mail.google.com', 'youtube.com/shorts',
    '*.example.com', '*bet*', '*ads*', 'localhost', 'localhost/x',
    'a-b_c123.co.uk', 'example.com/a-b_c',
  ];
  for (const p of valid) {
    it(`accepts ${p}`, () => assert.equal(SB.isValid(p), true));
  }
  const invalid = [
    '', '*', '*.*', '*/', '*.com', '*.co', 'a', 'ab',
    'not a site', 'face,book.com', 'foo bar', '<script>',
    '.example.com', 'example.com.', 'exa..mple.com',
    'http://facebook.com', // schemes must be normalized away first
    'singleword',
  ];
  for (const p of invalid) {
    it(`rejects ${JSON.stringify(p)}`, () => assert.equal(SB.isValid(p), false));
  }
});

describe('matchesUrl — exact, subdomain, anti-spoof', () => {
  const yes = [
    ['https://www.facebook.com/', 'facebook.com'],
    ['https://facebook.com/', 'facebook.com'],
    ['https://m.facebook.com/x', 'facebook.com'],
    ['https://deep.sub.facebook.com/', 'facebook.com'],
    ['https://mail.google.com/', 'mail.google.com'],
    ['https://sub.mail.google.com/inbox', 'mail.google.com'],
    ['https://example.com/', '*.example.com'],
    ['https://sub.example.com/a', '*.example.com'],
    ['https://x.bet365ads.com/', '*bet*'],
    ['https://youtube.com/shorts/abc', 'youtube.com/shorts'],
    ['https://www.youtube.com/shorts/abc?x=1', 'youtube.com/shorts'],
  ];
  for (const [url, pat] of yes) {
    it(`BLOCKS ${url} vs ${pat}`, () => assert.equal(SB.matchesUrl(url, pat), true));
  }
  const no = [
    ['https://notfacebook.com/', 'facebook.com'],
    ['https://facebook.com.evil.com/', 'facebook.com'],
    ['https://evilfacebook.com/', 'facebook.com'],
    ['https://myfacebook.com.evil.org/', 'facebook.com'],
    ['https://mail.google.com.evil.com/', 'mail.google.com'],
    ['https://www.youtube.com/watch?v=1', 'youtube.com/shorts'],
    ['https://youtube.com/', 'youtube.com/shorts'],
    ['https://example.com/', 'other.com'],
    ['chrome://extensions/', 'facebook.com'],
    ['chrome-extension://abc/html/blocked.html', 'facebook.com'],
    ['ftp://facebook.com/x', 'facebook.com'],
    ['not a url', 'facebook.com'],
    ['https://facebook.com/', 'notfacebook.com'],
  ];
  for (const [url, pat] of no) {
    it(`allows ${url} vs ${pat}`, () => assert.equal(SB.matchesUrl(url, pat), false));
  }
});

describe('findMatch — lists, enabled flags, first-match wins', () => {
  it('returns matching pattern from object entries', () => {
    const sites = [{ pattern: 'facebook.com', enabled: true }];
    assert.equal(SB.findMatch('https://m.facebook.com/', sites), 'facebook.com');
  });
  it('skips disabled entries', () => {
    const sites = [{ pattern: 'facebook.com', enabled: false }];
    assert.equal(SB.findMatch('https://facebook.com/', sites), null);
  });
  it('supports legacy string entries', () => {
    assert.equal(SB.findMatch('https://x.com/', ['x.com']), 'x.com');
  });
  it('normalizes messy entries before matching', () => {
    assert.equal(
      SB.findMatch('https://facebook.com/', ['  HTTPS://WWW.Facebook.com/ ']),
      'facebook.com'
    );
  });
  it('returns null for non-web URLs', () => {
    assert.equal(SB.findMatch('chrome://extensions/', [{ pattern: 'facebook.com' }]), null);
  });
  it('returns null for empty/invalid lists', () => {
    assert.equal(SB.findMatch('https://facebook.com/', []), null);
    assert.equal(SB.findMatch('https://facebook.com/', null), null);
    assert.equal(SB.findMatch('https://facebook.com/', [{ pattern: '***' }]), null);
  });
  it('path rules only match the path prefix', () => {
    const sites = [{ pattern: 'youtube.com/shorts' }];
    assert.equal(SB.findMatch('https://youtube.com/shorts/a', sites), 'youtube.com/shorts');
    assert.equal(SB.findMatch('https://youtube.com/watch', sites), null);
  });
});

describe('parseUrl', () => {
  it('parses http/https, rejects the rest', () => {
    assert.deepEqual(SB.parseUrl('https://Example.COM/a?b#c'), {
      hostname: 'example.com',
      path: 'example.com/a',
    });
    assert.equal(SB.parseUrl('chrome://extensions/'), null);
    assert.equal(SB.parseUrl('about:blank'), null);
    assert.equal(SB.parseUrl('garbage'), null);
  });
});

describe('toDnrFilter', () => {
  const cases = [
    ['facebook.com', '||facebook.com^'],
    ['mail.google.com', '||mail.google.com^'],
    ['*.example.com', '||example.com^'],
    ['youtube.com/shorts', '||youtube.com/shorts'],
    ['*bet*', '*bet*'],
  ];
  for (const [pat, want] of cases) {
    it(`${pat} -> ${want}`, () => assert.equal(SB.toDnrFilter(pat), want));
  }
  it('returns null for invalid patterns', () => {
    assert.equal(SB.toDnrFilter('*.com'), null);
    assert.equal(SB.toDnrFilter('*'), null);
    assert.equal(SB.toDnrFilter(''), null);
  });
});
