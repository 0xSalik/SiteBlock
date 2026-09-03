/* SiteBlock shared matcher — loaded in background (importScripts),
 * content scripts, popup, options, blocked pages via <script> tag.
 * No modules, no chrome deps: exposes global `SiteBlock` so it can be
 * unit-tested with node. All functions are pure. */
(function (global) {
  'use strict';

  /**
   * Normalize raw user input ("https://www.Facebook.com/ ", "facebook.com",
   * "*.example.com", "*ads*", "youtube.com/shorts") into a canonical
   * lowercase pattern string.
   */
  function normalize(raw) {
    if (raw === null || raw === undefined) return '';
    let s = String(raw).trim().toLowerCase();
    if (!s) return '';
    // Strip scheme like https://, http://, ftp:// etc.
    s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
    // Strip protocol-relative leading //
    s = s.replace(/^\/+/, '');
    // Take only first token (input may contain spaces/commas when pasted)
    s = s.split(/[\s,;]+/)[0] || '';
    if (!s) return '';
    // Strip credentials user:pass@
    const at = s.lastIndexOf('@');
    if (at >= 0) s = s.slice(at + 1);

    // Split host vs path
    const sep = s.search(/[/?#]/);
    let host = sep === -1 ? s : s.slice(0, sep);
    let rest = sep === -1 ? '' : s.slice(sep);
    // Strip port (:8080, :443)
    host = host.replace(/:\d+$/, '');
    // Strip trailing dots ("example.com." -> "example.com")
    host = host.replace(/\.+$/, '');
    host = host.trim();
    // Keep only the path, drop query + hash
    rest = rest.split(/[?#]/)[0] || '';
    if (rest.length > 1) rest = rest.replace(/\/+$/, '');
    if (rest === '/') rest = '';
    // Collapse duplicate slashes in path
    rest = rest.replace(/\/{2,}/g, '/');

    // Canonicalize www.: "*.www.example.com" -> "*.example.com",
    // "www.example.com" -> "example.com" (matching is www-transparent
    // anyway, this keeps the stored list deduplicated).
    if (host.startsWith('*.')) {
      const bare = host.slice(2).replace(/^www\./, '');
      host = '*.' + bare;
    } else if (!host.startsWith('*')) {
      host = host.replace(/^www\./, '');
    }

    s = host + rest;
    // Collapse accidental e.g. "example.com//shorts"
    s = s.replace(/([^:])\/{2,}/g, '$1/');
    return s;
  }

  /** Basic sanity check for a normalized pattern. */
  function isValid(norm) {
    if (!norm || typeof norm !== 'string') return false;
    if (norm.length < 3 || norm.length > 253) return false;
    if (/\s/.test(norm)) return false;
    if (/[<>"'`\\(){}\[\]|^]/.test(norm)) return false;
    if (norm === '*' || norm === '*.*' || norm === '*/') return false;
    if (norm.includes('..')) return false;
    if (/^[./-]/.test(norm) && !norm.startsWith('*')) return false;
    if (/[./-]$/.test(norm)) return false;

    const withoutStars = norm.replace(/\*/g, '');
    // Must retain at least a couple of meaningful characters
    if (withoutStars.replace(/[./-]/g, '').length < 2) return false;

    // "*.com" / "*.co" would nuke the whole web — refuse single-label suffix.
    if (norm.startsWith('*.')) {
      const suffix = norm.slice(2).split('/')[0];
      if (!suffix.includes('.') && suffix !== 'localhost') return false;
    }
    // Non-wildcard entries need a dot (or path, or localhost).
    if (!norm.includes('*')) {
      const hostPart = norm.split('/')[0];
      if (!hostPart.includes('.') && hostPart !== 'localhost') return false;
    }
    // Allowed charset only
    if (!/^[a-z0-9*._\/-]+$/.test(norm)) return false;
    return true;
  }

  function escapeRegExp(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  /** Build a RegExp for a normalized pattern. Returns null if invalid. */
  function toRegExp(pattern) {
    if (!isValid(pattern)) return null;
    // Path-aware patterns (contain /): match against "hostname + pathname"
    if (pattern.includes('/')) {
      const [hostPart, ...pathParts] = pattern.split('/');
      const pathPart = pathParts.join('/');
      if (hostPart.includes('*')) {
        const hostSrc = hostPart.split('*').map(escapeRegExp).join('.*');
        const pathSrc = pathPart.split('*').map(escapeRegExp).join('.*');
        return new RegExp('^(?:www\\.)?' + hostSrc + '\\/' + pathSrc + '(?:[\\/?#]|$)', 'i');
      }
      if (hostPart.startsWith('*.')) {
        const bare = escapeRegExp(hostPart.slice(2));
        const pathSrc = escapeRegExp(pathPart);
        return new RegExp('^(?:[^/]+\\.)?' + bare + '\\/' + pathSrc + '(?:[\\/?#]|$)', 'i');
      }
      const bare = escapeRegExp(hostPart.replace(/^www\./, ''));
      const pathSrc = escapeRegExp(pathPart);
      // Apex + any subdomain, prefix match on path
      return new RegExp('^(?:[a-z0-9-]+\\.)*' + bare + '\\/' + pathSrc + '(?:[\\/?#]|$)', 'i');
    }
    // Host-only patterns
    if (pattern.startsWith('*.')) {
      const bare = escapeRegExp(pattern.slice(2));
      return new RegExp('^(?:[^.]+\\.)?' + bare + '$', 'i');
    }
    if (pattern.includes('*')) {
      const src = pattern.split('*').map(escapeRegExp).join('.*');
      return new RegExp('^' + src + '$', 'i');
    }
    // Plain domain: match apex + ALL subdomains (most intuitive for blockers).
    // "facebook.com" blocks facebook.com, www.facebook.com, m.facebook.com…
    // "mail.google.com" blocks mail.google.com + *.mail.google.com only.
    const bare = escapeRegExp(pattern);
    return new RegExp('^(?:[a-z0-9-]+\\.)*' + bare + '$', 'i');
  }

  /** Safely extract { hostname, path } from an arbitrary URL string. */
  function parseUrl(urlString) {
    try {
      const u = new URL(urlString);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
      const hostname = u.hostname.toLowerCase().replace(/\.+$/, '');
      if (!hostname) return null;
      return { hostname, path: (hostname + u.pathname).toLowerCase() };
    } catch (e) {
      return null;
    }
  }

  /**
   * Test a full URL against one normalized pattern.
   * Returns true if blocked.
   */
  function matchesUrl(urlString, pattern) {
    const parsed = parseUrl(urlString);
    if (!parsed || !pattern) return false;
    const re = toRegExp(pattern);
    if (!re) return false;
    if (pattern.includes('/')) return re.test(parsed.path);
    return re.test(parsed.hostname);
  }

  /**
   * Test a full URL against a list of entries.
   * entries: array of strings or { pattern, enabled } objects.
   * Returns the matching pattern string or null.
   */
  function findMatch(urlString, entries) {
    const parsed = parseUrl(urlString);
    if (!parsed) return null;
    const list = Array.isArray(entries) ? entries : [];
    for (const entry of list) {
      const pattern = typeof entry === 'string' ? normalize(entry) : normalize(entry && entry.pattern);
      const enabled = typeof entry === 'string' ? true : !entry || entry.enabled !== false;
      if (!enabled || !pattern || !isValid(pattern)) continue;
      const re = toRegExp(pattern);
      if (!re) continue;
      const hay = pattern.includes('/') ? parsed.path : parsed.hostname;
      if (re.test(hay)) return pattern;
    }
    return null;
  }

  /**
   * Map a normalized pattern to a declarativeNetRequest urlFilter.
   * Uses ||domain^ syntax (matches domain + subdomains) for plain domains,
   * which is exactly the semantics of findMatch() above.
   */
  function toDnrFilter(pattern) {
    if (!isValid(pattern)) return null;
    // "*.example.com" -> apex + subdomains, same as plain domain.
    if (/^\*\.[^*]+\.[^*]+$/.test(pattern) && !pattern.includes('/')) {
      return '||' + pattern.slice(2) + '^';
    }
    if (pattern.includes('*')) {
      // DNR urlFilter already supports * wildcards.
      return pattern;
    }
    if (pattern.includes('/')) {
      return '||' + pattern;
    }
    if (pattern.startsWith('*.')) {
      return '||' + pattern.slice(2) + '^';
    }
    return '||' + pattern + '^';
  }

  const SiteBlock = {
    normalize,
    isValid,
    toRegExp,
    parseUrl,
    matchesUrl,
    findMatch,
    toDnrFilter,
  };

  // Support both browsers (window/chrome) and node (module.exports).
  global.SiteBlock = SiteBlock;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = SiteBlock;
  }
})(typeof self !== 'undefined' ? self : typeof window !== 'undefined' ? window : globalThis);
