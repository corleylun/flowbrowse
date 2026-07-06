import test from 'node:test';
import assert from 'node:assert/strict';
import { checkAuth, localhostAuthConfig, controlAuthConfig, Headers } from './auth';

const PORT = 8676;
const TOKEN = 'a'.repeat(64);
const cfg = localhostAuthConfig(TOKEN, PORT);

function h(overrides: Headers = {}): Headers {
  return { host: `127.0.0.1:${PORT}`, authorization: `Bearer ${TOKEN}`, ...overrides };
}

test('valid token + allowed host, no origin → ok', () => {
  assert.deepEqual(checkAuth(h(), cfg), { ok: true });
});

test('valid token + allowed origin → ok', () => {
  assert.deepEqual(checkAuth(h({ origin: `http://localhost:${PORT}` }), cfg), { ok: true });
});

test('localhost and [::1] hosts are allowed', () => {
  assert.equal(checkAuth(h({ host: `localhost:${PORT}` }), cfg).ok, true);
  assert.equal(checkAuth(h({ host: `[::1]:${PORT}` }), cfg).ok, true);
});

test('missing token → 401', () => {
  const r = checkAuth(h({ authorization: undefined }), cfg);
  assert.equal(r.ok, false);
  assert.equal((r as { status: number }).status, 401);
});

test('wrong token (same length) → 401', () => {
  const r = checkAuth(h({ authorization: `Bearer ${'b'.repeat(64)}` }), cfg);
  assert.equal(r.ok, false);
  assert.equal((r as { status: number }).status, 401);
});

test('wrong token (different length) → 401', () => {
  const r = checkAuth(h({ authorization: 'Bearer short' }), cfg);
  assert.equal(r.ok, false);
  assert.equal((r as { status: number }).status, 401);
});

test('token without Bearer prefix → 401', () => {
  const r = checkAuth(h({ authorization: TOKEN }), cfg);
  assert.equal(r.ok, false);
  assert.equal((r as { status: number }).status, 401);
});

test('disallowed host → 403 (DNS-rebinding guard)', () => {
  const r = checkAuth(h({ host: 'evil.example.com' }), cfg);
  assert.equal(r.ok, false);
  assert.equal((r as { status: number }).status, 403);
});

test('missing host → 403', () => {
  const r = checkAuth(h({ host: undefined }), cfg);
  assert.equal(r.ok, false);
  assert.equal((r as { status: number }).status, 403);
});

test('disallowed origin → 403', () => {
  const r = checkAuth(h({ origin: 'http://evil.example.com' }), cfg);
  assert.equal(r.ok, false);
  assert.equal((r as { status: number }).status, 403);
});

test('host is checked before token (bad host + bad token → 403, not 401)', () => {
  const r = checkAuth(h({ host: 'evil.example.com', authorization: 'Bearer nope' }), cfg);
  assert.equal(r.ok, false);
  assert.equal((r as { status: number }).status, 403);
});

test('array-valued headers are handled (first value used)', () => {
  const r = checkAuth(
    { host: [`127.0.0.1:${PORT}`], authorization: [`Bearer ${TOKEN}`] },
    cfg,
  );
  assert.equal(r.ok, true);
});

// --- LAN access (controlAuthConfig with extra hosts) ---

const lanCfg = controlAuthConfig(TOKEN, PORT, ['192.168.1.50']);

test('LAN config still allows loopback', () => {
  assert.equal(checkAuth(h(), lanCfg).ok, true);
  assert.equal(checkAuth(h({ host: `localhost:${PORT}` }), lanCfg).ok, true);
});

test('LAN config allows the explicit LAN host + origin', () => {
  assert.equal(checkAuth(h({ host: `192.168.1.50:${PORT}` }), lanCfg).ok, true);
  assert.equal(
    checkAuth(h({ host: `192.168.1.50:${PORT}`, origin: `http://192.168.1.50:${PORT}` }), lanCfg).ok,
    true,
  );
});

test('LAN config still rejects an unlisted host (DNS-rebinding guard holds when bound wide)', () => {
  // A different LAN IP that happens to reach us is NOT auto-trusted.
  const r = checkAuth(h({ host: `192.168.1.99:${PORT}` }), lanCfg);
  assert.equal(r.ok, false);
  assert.equal((r as { status: number }).status, 403);
});

test('LAN host on the wrong port is rejected', () => {
  const r = checkAuth(h({ host: `192.168.1.50:${PORT + 1}` }), lanCfg);
  assert.equal(r.ok, false);
  assert.equal((r as { status: number }).status, 403);
});

test('with no extra hosts, controlAuthConfig is loopback-only (equals localhostAuthConfig)', () => {
  const plain = controlAuthConfig(TOKEN, PORT);
  assert.equal(checkAuth(h({ host: `192.168.1.50:${PORT}` }), plain).ok, false);
  assert.equal(checkAuth(h(), plain).ok, true);
});
