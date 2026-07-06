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
