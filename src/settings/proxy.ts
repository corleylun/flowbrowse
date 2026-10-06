import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Global network proxy (HTTP / HTTPS / SOCKS5) for every container session. HUMAN-ONLY: no agent
 * tool reads or sets it. The password is stored encrypted (Electron `safeStorage`, via the
 * injected `SecretCodec`) and is never written in clear text; if the OS cannot encrypt, the
 * password is refused rather than stored plain.
 */
export type ProxyKind = 'http' | 'https' | 'socks5';

export interface ProxyConfig {
  enabled: boolean;
  kind: ProxyKind;
  host: string;
  port: number;
  username: string;
}

export const DEFAULT_PROXY: ProxyConfig = { enabled: false, kind: 'http', host: '', port: 0, username: '' };

const KINDS: ProxyKind[] = ['http', 'https', 'socks5'];
const MAX_HOST = 253;
const MAX_CRED = 256;

/** Hostname or IP literal only — a scheme, path, whitespace or control char makes it ''. */
export function sanitizeProxyHost(v: unknown): string {
  if (typeof v !== 'string') return '';
  const t = v.trim();
  if (!t || t.length > MAX_HOST) return '';
  return /^[A-Za-z0-9._:-]+$/.test(t) ? t : '';
}

export function sanitizeProxy(v: unknown): ProxyConfig {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  const host = sanitizeProxyHost(o.host);
  const port = typeof o.port === 'number' && Number.isInteger(o.port) && o.port >= 1 && o.port <= 65535 ? o.port : 0;
  const kind = KINDS.includes(o.kind as ProxyKind) ? (o.kind as ProxyKind) : 'http';
  const username =
    typeof o.username === 'string' ? o.username.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, MAX_CRED) : '';
  return { enabled: o.enabled === true && host !== '' && port >= 1, kind, host, port, username };
}

export function proxyIsActive(c: ProxyConfig): boolean {
  return c.enabled && c.host !== '' && c.port >= 1;
}

/** Chromium refuses to authenticate to a SOCKS5 proxy, so a SOCKS5 login can never work here.
 *  Returned (instead of silently dropping the credentials) so the UI can say so. */
export function proxyProblem(c: ProxyConfig, hasPassword: boolean): string | null {
  if (c.kind === 'socks5' && (c.username !== '' || hasPassword)) {
    return 'SOCKS5 proxies with a username/password are not supported on this build (Chromium cannot authenticate to SOCKS5). Use an HTTP or HTTPS proxy, or an unauthenticated SOCKS5 proxy.';
  }
  return null;
}

/** The Electron `session.setProxy` config for this proxy. Inactive → system proxy settings. */
export function toElectronProxy(c: ProxyConfig): { mode: 'system' } | { mode: 'fixed_servers'; proxyRules: string; proxyBypassRules: string } {
  if (!proxyIsActive(c)) return { mode: 'system' };
  const host = c.host.includes(':') ? `[${c.host}]` : c.host;
  // socks5h-style: Chromium sends the hostname to a SOCKS5 proxy (remote DNS) by default.
  const scheme = c.kind === 'socks5' ? 'socks5' : c.kind;
  return {
    mode: 'fixed_servers',
    proxyRules: `${scheme}://${host}:${c.port}`,
    proxyBypassRules: 'localhost,127.0.0.1,[::1],<local>',
  };
}

export interface SecretCodec {
  available(): boolean;
  encrypt(plain: string): string; // base64 ciphertext
  decrypt(blob: string): string | null;
}

interface Persisted extends ProxyConfig {
  passwordEnc?: string;
}

export class ProxyStore {
  private state: ProxyConfig = { ...DEFAULT_PROXY };
  private passwordEnc = '';

  constructor(
    private readonly file: string,
    private readonly codec: SecretCodec,
  ) {
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Persisted;
      this.state = sanitizeProxy(raw);
      if (typeof raw.passwordEnc === 'string') this.passwordEnc = raw.passwordEnc;
    } catch {
      /* missing/corrupt → proxy off */
    }
  }

  get(): ProxyConfig {
    return { ...this.state };
  }

  hasPassword(): boolean {
    return this.passwordEnc !== '';
  }

  password(): string | undefined {
    if (!this.passwordEnc) return undefined;
    return this.codec.decrypt(this.passwordEnc) ?? undefined;
  }

  /**
   * Persist. `password`: undefined keeps the stored one, '' clears it, else replaces it.
   * Returns an error string (and saves nothing) when the combination can't work.
   */
  set(config: unknown, password?: string): { ok: true } | { ok: false; error: string } {
    const next = sanitizeProxy(config);
    let enc = this.passwordEnc;
    if (password !== undefined) {
      if (password === '') enc = '';
      else if (!this.codec.available()) return { ok: false, error: 'This system cannot encrypt a stored password; leave the password empty.' };
      else enc = this.codec.encrypt(password.slice(0, MAX_CRED));
    }
    const problem = next.enabled ? proxyProblem(next, enc !== '') : null;
    if (problem) return { ok: false, error: problem };
    this.state = next;
    this.passwordEnc = enc;
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const out: Persisted = { ...next, ...(enc ? { passwordEnc: enc } : {}) };
    fs.writeFileSync(this.file, JSON.stringify(out), { mode: 0o600 });
    return { ok: true };
  }
}
