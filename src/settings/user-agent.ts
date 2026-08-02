/** Escape a string for safe use inside a RegExp source (all regex metacharacters). */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// App names that must never be stripped as the "app-name token", because they collide with a
// real UA component (Chrome/Chromium/Safari/etc.) or are too short/generic to safely match —
// a future app rename to one of these (or anything under 3 chars) must not risk corrupting a
// genuine UA component instead of just removing our own app-name token.
const RESERVED_UA_COMPONENT_NAMES = new Set([
  'chrome',
  'chromium',
  'safari',
  'mozilla',
  'applewebkit',
  'khtml',
  'gecko',
  'version',
  'mobile',
  'electron',
]);

/** Strip the `Electron/<ver>` and app-name tokens from a raw Electron UA so it presents as the
 *  plain Chromium it actually is. Only removes those tokens — everything else (Chrome version,
 *  OS, WebKit) is preserved verbatim. Idempotent: a UA with no such tokens is returned unchanged
 *  (aside from whitespace normalization). */
export function plainChromiumUa(rawUa: string, appName: string): string {
  if (typeof rawUa !== 'string' || rawUa.length === 0) return typeof rawUa === 'string' ? rawUa : '';

  let ua = rawUa.replace(/Electron\/\S+/gi, '');

  if (typeof appName === 'string' && appName.trim().length > 0) {
    const trimmed = appName.trim();
    const isReserved = trimmed.length < 3 || RESERVED_UA_COMPONENT_NAMES.has(trimmed.toLowerCase());
    if (!isReserved) {
      const escaped = escapeRegExp(trimmed);
      ua = ua.replace(new RegExp(`${escaped}/\\S+`, 'gi'), '');
    }
  }

  // Collapse any resulting run of spaces (including ones left by removed tokens) to a single
  // space, and trim leading/trailing whitespace.
  return ua.replace(/\s+/g, ' ').trim();
}
