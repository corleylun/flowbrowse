import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ProxyStore, proxyIsActive, sanitizeProxy, sanitizeProxyHost, toElectronProxy, type SecretCodec } from './proxy';

const codec = (available = true): SecretCodec => ({
  available: () => available,
  encrypt: (p) => Buffer.from('enc:' + p).toString('base64'),
  decrypt: (b) => Buffer.from(b, 'base64').toString().replace(/^enc:/, ''),
});
const tmp = (): string => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-')), 'proxy.json');

test('defaults off; incomplete configs are never active', () => {
  const s = new ProxyStore(tmp(), codec());
  assert.equal(proxyIsActive(s.get()), false);
  assert.equal(sanitizeProxy({ enabled: true, kind: 'http', host: '', port: 80 }).enabled, false);
  assert.equal(sanitizeProxy({ enabled: true, kind: 'http', host: 'p', port: 0 }).enabled, false);
  assert.equal(sanitizeProxy({ enabled: true, kind: 'http', host: 'p', port: 70000 }).enabled, false);
});

test('a host with a scheme, path or control characters is rejected', () => {
  for (const bad of ['http://proxy', 'proxy/path', 'a b', 'p\nq', 'proxy;rm']) assert.equal(sanitizeProxyHost(bad), '', bad);
  assert.equal(sanitizeProxyHost(' proxy.example.com '), 'proxy.example.com');
  assert.equal(sanitizeProxyHost('::1'), '::1');
});

test('persists across restart; the password is encrypted, never in clear', () => {
  const f = tmp();
  const c = { enabled: true, kind: 'https', host: '10.0.0.5', port: 3128, username: 'bob' };
  assert.deepEqual(new ProxyStore(f, codec()).set(c, 's3cret'), { ok: true });
  const again = new ProxyStore(f, codec());
  assert.deepEqual(again.get(), c);
  assert.equal(again.password(), 's3cret');
  assert.ok(!fs.readFileSync(f, 'utf8').includes('s3cret'));
});

test('password: undefined keeps, empty clears; no encryption available refuses a password', () => {
  const s = new ProxyStore(tmp(), codec());
  const c = { enabled: true, kind: 'http', host: 'h', port: 8080, username: 'u' };
  s.set(c, 'a');
  s.set(c);
  assert.equal(s.password(), 'a');
  s.set(c, '');
  assert.equal(s.password(), undefined);
  const r = new ProxyStore(tmp(), codec(false)).set(c, 'x');
  assert.equal(r.ok, false);
});

test('SOCKS5 with credentials is refused (Chromium cannot authenticate to SOCKS5)', () => {
  const s = new ProxyStore(tmp(), codec());
  const r = s.set({ enabled: true, kind: 'socks5', host: 'h', port: 1080, username: 'u' }, 'p');
  assert.equal(r.ok, false);
  assert.equal(s.get().enabled, false, 'nothing saved');
  assert.deepEqual(s.set({ enabled: true, kind: 'socks5', host: 'h', port: 1080, username: '' }), { ok: true });
});

test('electron proxy rules per kind; loopback always bypassed; off → system', () => {
  assert.deepEqual(toElectronProxy(sanitizeProxy({})), { mode: 'system' });
  for (const k of ['http', 'https', 'socks5'] as const) {
    const r = toElectronProxy({ enabled: true, kind: k, host: 'p.example', port: 9, username: '' });
    assert.equal(r.mode, 'fixed_servers');
    if (r.mode === 'fixed_servers') {
      assert.equal(r.proxyRules, `${k}://p.example:9`);
      assert.match(r.proxyBypassRules, /localhost.*127\.0\.0\.1/);
    }
  }
  const v6 = toElectronProxy({ enabled: true, kind: 'http', host: '::1', port: 9, username: '' });
  assert.equal(v6.mode === 'fixed_servers' && v6.proxyRules, 'http://[::1]:9');
});

test('a corrupt file falls back to off', () => {
  const f = tmp();
  fs.writeFileSync(f, '{nope');
  assert.equal(new ProxyStore(f, codec()).get().enabled, false);
});
