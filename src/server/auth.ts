import { timingSafeEqual } from 'node:crypto';

/** Header bag as delivered by node's `http.IncomingMessage`. */
export type Headers = Record<string, string | string[] | undefined>;

export interface AuthConfig {
  readonly token: string;
  /** Allowed `Host` header values (host:port), lowercased. Anti DNS-rebinding. */
  readonly allowedHosts: ReadonlySet<string>;
  /** Allowed `Origin` values, lowercased. A present-but-unlisted Origin is rejected. */
  readonly allowedOrigins: ReadonlySet<string>;
}

export type AuthResult = { ok: true } | { ok: false; status: number; reason: string };

function headerValue(raw: string | string[] | undefined): string | undefined {
  return Array.isArray(raw) ? raw[0] : raw;
}

function constantTimeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  // Length is not secret; bail before timingSafeEqual (which requires equal length).
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/**
 * The gate for EVERY request to the control surface (MCP + CLI/api). Checks, in order:
 *   1. Host header is present and an allowed localhost value (blocks DNS-rebinding).
 *   2. If an Origin is present, it is on the allowlist (blocks a malicious web page
 *      from driving the local server cross-origin).
 *   3. A valid bearer token (constant-time compare).
 *
 * Fails closed — any failure denies. Host is checked first so a hostile remote/origin
 * is rejected before we even look at the token.
 */
export function checkAuth(headers: Headers, cfg: AuthConfig): AuthResult {
  const host = headerValue(headers['host'])?.toLowerCase();
  if (!host || !cfg.allowedHosts.has(host)) {
    return { ok: false, status: 403, reason: 'host not allowed' };
  }

  const origin = headerValue(headers['origin']);
  if (origin !== undefined && !cfg.allowedOrigins.has(origin.toLowerCase())) {
    return { ok: false, status: 403, reason: 'origin not allowed' };
  }

  const authz = headerValue(headers['authorization']) ?? '';
  const prefix = 'Bearer ';
  const token = authz.startsWith(prefix) ? authz.slice(prefix.length) : '';
  if (token.length === 0 || !constantTimeEqual(token, cfg.token)) {
    return { ok: false, status: 401, reason: 'invalid token' };
  }

  return { ok: true };
}

/**
 * Build the allowed Host/Origin sets for the control server on `port`. Loopback names are always
 * allowed; `extraHosts` (bare host/IP strings, no port) are added for LAN access. Only these exact
 * hosts are accepted — the Host allowlist is the DNS-rebinding guard, so an unlisted name/IP that
 * happens to resolve to us is still rejected. Passing no extras yields loopback-only (the default).
 */
export function controlAuthConfig(token: string, port: number, extraHosts: readonly string[] = []): AuthConfig {
  const hosts = ['127.0.0.1', 'localhost', '[::1]', ...extraHosts];
  const allowedHosts = new Set<string>();
  const allowedOrigins = new Set<string>();
  for (const h of hosts) {
    const lower = h.toLowerCase();
    allowedHosts.add(`${lower}:${port}`);
    allowedOrigins.add(`http://${lower}:${port}`);
  }
  return { token, allowedHosts, allowedOrigins };
}

/** Loopback-only config (no LAN). Thin wrapper kept for existing callers/tests. */
export function localhostAuthConfig(token: string, port: number): AuthConfig {
  return controlAuthConfig(token, port);
}
