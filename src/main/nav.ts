/** Origin of a URL (scheme://host:port), or '' if it can't be parsed. */
export function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
}

/**
 * Whether navigating to `newUrl` leaves the origin the AI was granted access on. A
 * cross-origin navigation must invalidate the grant so AI access never carries from one
 * site into another (e.g. example.com → bank.com). Same-origin navigation (path changes,
 * SPA routes) keeps the grant.
 */
export function crossesGrantedOrigin(grantedOrigin: string, newUrl: string): boolean {
  if (!grantedOrigin) return false; // nothing granted yet
  return originOf(newUrl) !== grantedOrigin;
}

/**
 * A real, pinnable web origin. Opaque origins (`about:blank`, `data:`, `file:` → "null")
 * and the empty string are NOT pinnable: a grant can only attach to a committed http(s)
 * origin, otherwise cross-origin invalidation could never fire.
 */
export function isWebOrigin(origin: string): boolean {
  return origin.startsWith('http://') || origin.startsWith('https://');
}

/** Local dev hosts that should default to http:// (Chromium special-cases localhost as secure).
 *  Covers `localhost`, `*.localhost`, and the loopback IPs. */
export function isLocalHost(host: string): boolean {
  const h = host.toLowerCase();
  return (
    h === 'localhost' ||
    h.endsWith('.localhost') ||
    h === '127.0.0.1' ||
    h === '0.0.0.0' ||
    h === '::1' ||
    h === '[::1]'
  );
}

/**
 * Turn address-bar text into a URL to navigate to:
 *  - An explicit `http(s)://` scheme is passed through **untouched** (never rewritten).
 *  - A recognizable host — a dotted domain/IP, a localhost-family name, or anything with an
 *    explicit `:port` — is navigated to. Local dev defaults to **http://** (the localhost family
 *    always, and any `host:port`, since a port almost always means a local dev server); other
 *    hosts default to `https://`.
 *  - Anything else (a bare word, or text with spaces) becomes a web search.
 */
export function normalizeUrl(input: string): string {
  const s = input.trim();
  if (/^https?:\/\//i.test(s)) return s; // explicit scheme wins

  // host[:port][/path] — host is a hostname (dotted or single label) or IPv4.
  const m = !s.includes(' ') ? s.match(/^([\w.-]+)(:\d+)?(\/.*)?$/) : null;
  if (m) {
    const host = m[1];
    const hasPort = !!m[2];
    const local = isLocalHost(host);
    if (host.includes('.') || local || hasPort) {
      const scheme = local || hasPort ? 'http://' : 'https://';
      return scheme + s;
    }
  }
  return 'https://duckduckgo.com/?q=' + encodeURIComponent(s);
}
