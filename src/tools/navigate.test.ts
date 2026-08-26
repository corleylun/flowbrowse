import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createNavigateTool, parseNavigationUrl, NavigateController, NavigateResult } from './navigate';
import { Mode } from '../core/modes';
import { RiskLevel } from '../core/tool';
import { DenyReason } from '../core/errors';

function fakeCtrl(spy?: (url: string) => void): NavigateController {
  return {
    async navigate(_tabId, url) {
      spy?.(url);
      return { ok: true, url, title: 'Example Domain' } as NavigateResult;
    },
  };
}

const liveCtx = { tabId: 't1', epoch: 1, isLive: () => true, signal: new AbortController().signal };

test('navigate tool: Act-tier, approval-gated, audits the destination', () => {
  const t = createNavigateTool(fakeCtrl());
  assert.equal(t.name, 'navigate');
  assert.equal(t.minMode, Mode.Act);
  assert.equal(t.risk, RiskLevel.Medium);
  assert.equal(t.requiresApproval, true);
  assert.equal(t.auditDetail!({ url: 'https://example.com/pricing' }), 'https://example.com/pricing');
  // The url is the agent's own input, never page content — no output-derived audit suffix.
  assert.equal(t.auditResult, undefined);
});

// --- The security boundary: only http(s) may leave the parser ---

test('rejects file: — a Read grant must never become a filesystem read', () => {
  assert.throws(() => parseNavigationUrl('file:///etc/passwd'), /only http and https/);
  assert.throws(() => parseNavigationUrl('file://localhost/Users/me/.safecobrowser/'), /only http and https/);
});

test('rejects javascript: — that would be run_js without the Develop grant', () => {
  assert.throws(() => parseNavigationUrl('javascript:alert(document.cookie)'), /only http and https/);
  assert.throws(() => parseNavigationUrl('JavaScript:void(0)'), /only http and https/);
});

test('rejects every other scheme, naming it rather than silently coercing', () => {
  for (const u of ['data:text/html,<h1>x', 'chrome://settings', 'devtools://devtools/x', 'about:blank', 'ftp://h/f']) {
    assert.throws(() => parseNavigationUrl(u), /only http and https/, u);
  }
  // The refusal names the scheme so the agent can correct itself.
  assert.throws(() => parseNavigationUrl('data:text/html,x'), /got "data:"/);
});

test('rejects embedded credentials — an approval card the human misreads is not consent', () => {
  assert.throws(() => parseNavigationUrl('https://bank.com@evil.com/'), /credentials/);
  assert.throws(() => parseNavigationUrl('https://user:pw@example.com/'), /credentials/);
});

test('rejects control characters, empty input, over-long urls, and hostless urls', () => {
  assert.throws(() => parseNavigationUrl('https://example.com/\nHost: evil'), /control characters/);
  assert.throws(() => parseNavigationUrl('https://exa\u0000mple.com'), /control characters/);
  assert.throws(() => parseNavigationUrl('   '), /must not be empty/);
  assert.throws(() => parseNavigationUrl('https://example.com/' + 'a'.repeat(2100)), /at most 2048/);
  assert.throws(() => parseNavigationUrl('https://'), /not a valid url|must have a host/);
});

// --- Normalization ---

test('passes an explicit http(s) url through, normalized', () => {
  assert.equal(parseNavigationUrl('https://example.com/pricing'), 'https://example.com/pricing');
  assert.equal(parseNavigationUrl('  http://example.com/a?b=1#c  '), 'http://example.com/a?b=1#c');
});

test('scheme-less input defaults to https', () => {
  assert.equal(parseNavigationUrl('example.com'), 'https://example.com/');
  assert.equal(parseNavigationUrl('example.com/pricing?plan=pro'), 'https://example.com/pricing?plan=pro');
});

test('a host:port is a port, NOT a scheme — and local dev defaults to http', () => {
  assert.equal(parseNavigationUrl('localhost:3000'), 'http://localhost:3000/');
  assert.equal(parseNavigationUrl('127.0.0.1:8080/api'), 'http://127.0.0.1:8080/api');
  assert.equal(parseNavigationUrl('example.com:8443/x'), 'http://example.com:8443/x');
  assert.equal(parseNavigationUrl('localhost'), 'http://localhost/');
});

test('schema rejects a non-string / missing url and validates through the same parser', () => {
  const t = createNavigateTool(fakeCtrl());
  assert.throws(() => t.inputSchema.parse({}), /url must be a string/);
  assert.throws(() => t.inputSchema.parse({ url: 42 }), /url must be a string/);
  assert.throws(() => t.inputSchema.parse('https://example.com'), /expected \{ url/);
  assert.throws(() => t.inputSchema.parse({ url: 'file:///etc/passwd' }), /only http and https/);
  assert.deepEqual(t.inputSchema.parse({ url: 'example.com' }), { url: 'https://example.com/' });
});

// --- Handler ---

test('handler forwards the validated url and returns the committed result', async () => {
  let seen: string | undefined;
  const t = createNavigateTool(fakeCtrl((u) => (seen = u)));
  const out = await t.handler({ url: 'https://example.com/' }, liveCtx);
  assert.equal(seen, 'https://example.com/');
  assert.equal(out.ok, true);
  assert.equal(out.url, 'https://example.com/');
});

test('handler fails closed if the grant was pulled between approval and execution', async () => {
  let called = false;
  const t = createNavigateTool(fakeCtrl(() => (called = true)));
  const dead = { tabId: 't1', epoch: 1, isLive: () => false, signal: new AbortController().signal };
  await assert.rejects(() => t.handler({ url: 'https://example.com/' }, dead), (e: unknown) => {
    assert.equal((e as { reason?: DenyReason }).reason, DenyReason.Revoked);
    return true;
  });
  assert.equal(called, false, 'the navigation must not start after a revoke');
});

test('handler fails closed on an already-aborted signal', async () => {
  let called = false;
  const t = createNavigateTool(fakeCtrl(() => (called = true)));
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(() => t.handler({ url: 'https://example.com/' }, { ...liveCtx, signal: ac.signal }));
  assert.equal(called, false);
});
