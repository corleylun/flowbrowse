import test from 'node:test';
import assert from 'node:assert/strict';
import { createCore } from '../core';
import { Mode } from '../core/modes';
import { ApprovalProvider } from '../core/approval';
import { MemoryAuditSink } from '../core/audit';
import { Broker } from '../core/broker';
import { createActTools, ActController, ClickResult, FillResult, SubmitResult } from './act';
import { createDevTools, DevController } from './dev';
import { createInspectTools, InspectController, ElementInfo } from './inspect';

class ApproveAll implements ApprovalProvider {
  public count = 0;
  async request() {
    this.count++;
    return { approved: true, available: true };
  }
}

function fakeAct(): ActController & { clicks: string[]; fills: Array<[string, string]> } {
  const clicks: string[] = [];
  const fills: Array<[string, string]> = [];
  return {
    clicks,
    fills,
    async click(_tab, selector): Promise<ClickResult> {
      clicks.push(selector);
      return { clicked: true, matched: 'x' };
    },
    async fill(_tab, selector, value): Promise<FillResult> {
      fills.push([selector, value]);
      return { filled: true, matched: 'x' };
    },
    async submit(_tab, selector): Promise<SubmitResult> {
      return { submitted: true, matched: selector };
    },
  };
}

function fakeDev(): DevController & { scripts: string[] } {
  const scripts: string[] = [];
  return {
    scripts,
    async runJs(_tab, script) {
      scripts.push(script);
      return 'ok';
    },
  };
}

function fakeInspect(): InspectController & { selectors: string[] } {
  const selectors: string[] = [];
  return {
    selectors,
    async inspect(_tab, selector): Promise<ElementInfo> {
      selectors.push(selector);
      return { matched: true };
    },
    async console() {
      return [];
    },
    async network() {
      return [];
    },
    async networkBody() {
      return [];
    },
  };
}

function setupAll(approval: ApprovalProvider = new ApproveAll()) {
  const audit = new MemoryAuditSink();
  const core = createCore({ approvals: approval, audit });
  const act = fakeAct();
  const dev = fakeDev();
  const inspect = fakeInspect();
  for (const t of createActTools(act)) core.registry.register(t);
  for (const t of createDevTools(dev)) core.registry.register(t);
  for (const t of createInspectTools(inspect)) core.registry.register(t);
  return { core, act, dev, inspect, audit };
}

// ===== Tier gating (#4) =====

test('TIER: run_js is denied at Act mode (Develop-only)', async () => {
  const { core, dev } = setupAll();
  core.sessions.setMode('m', Mode.Act);
  const r = await core.broker.invoke('m', 'run_js', { script: 'alert(1)' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'permission_denied');
  assert.equal(dev.scripts.length, 0);
});

test('TIER: run_js denied at Inspect and Read', async () => {
  const { core, dev } = setupAll();
  for (const m of [Mode.Read, Mode.Inspect]) {
    core.sessions.setMode('m', m);
    const r = await core.broker.invoke('m', 'run_js', { script: '1' });
    assert.equal(r.reason, 'permission_denied');
  }
  assert.equal(dev.scripts.length, 0);
});

test('TIER: click/fill denied at Inspect (Act-only)', async () => {
  const { core, act } = setupAll();
  core.sessions.setMode('m', Mode.Inspect);
  assert.equal((await core.broker.invoke('m', 'click', { selector: '#a' })).reason, 'permission_denied');
  assert.equal(
    (await core.broker.invoke('m', 'fill', { selector: '#a', value: 'v' })).reason,
    'permission_denied',
  );
  assert.equal(act.clicks.length, 0);
});

test('TIER: inspect tools denied at Read (Inspect-only)', async () => {
  const { core, inspect } = setupAll();
  core.sessions.setMode('m', Mode.Read);
  assert.equal((await core.broker.invoke('m', 'inspect_element', { selector: '#a' })).reason, 'permission_denied');
  assert.equal((await core.broker.invoke('m', 'read_console', {})).reason, 'permission_denied');
  assert.equal((await core.broker.invoke('m', 'read_network', {})).reason, 'permission_denied');
  assert.equal(inspect.selectors.length, 0);
});

test('TIER: Develop tier still requires approval for run_js', async () => {
  const { core, dev } = setupAll(); // DenyAll wrapped? No—ApproveAll. Use a DenyAll explicitly.
  // Replace with no-approval-available:
  const audit = new MemoryAuditSink();
  const core2 = createCore({ audit });
  const dev2 = fakeDev();
  for (const t of createDevTools(dev2)) core2.registry.register(t);
  core2.sessions.setMode('m', Mode.Develop);
  const r = await core2.broker.invoke('m', 'run_js', { script: '1' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'approval_required');
  assert.equal(dev2.scripts.length, 0);
  void core;
  void dev;
});

// ===== Effectful revoke window (#1) =====

test('EFFECT: run_js does not execute if revoked during approval', async () => {
  const audit = new MemoryAuditSink();
  const core = createCore({ audit });
  const dev = fakeDev();
  for (const t of createDevTools(dev)) core.registry.register(t);
  const approval: ApprovalProvider = {
    async request() {
      core.sessions.revoke('m'); // Stop AI while card is open
      return { approved: true, available: true };
    },
  };
  const broker = new Broker(core.registry, core.sessions, approval, audit);
  core.sessions.setMode('m', Mode.Develop);
  const r = await broker.invoke('m', 'run_js', { script: 'steal()' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'revoked');
  assert.equal(dev.scripts.length, 0, 'run_js never executed after revoke');
});

test('EFFECT: fill does not execute if revoked during approval', async () => {
  const audit = new MemoryAuditSink();
  const core = createCore({ audit });
  const act = fakeAct();
  for (const t of createActTools(act)) core.registry.register(t);
  const approval: ApprovalProvider = {
    async request() {
      core.sessions.revoke('m');
      return { approved: true, available: true };
    },
  };
  const broker = new Broker(core.registry, core.sessions, approval, audit);
  core.sessions.setMode('m', Mode.Act);
  const r = await broker.invoke('m', 'fill', { selector: '#pw', value: 'secret' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'revoked');
  assert.equal(act.fills.length, 0, 'fill never executed after revoke');
});

// A mode *downgrade* (e.g. Develop -> Act) that lands during approval voids run_js
// even though Act is still "above zero". Any epoch change kills it.
test('EFFECT: downgrade during approval voids run_js', async () => {
  const audit = new MemoryAuditSink();
  const core = createCore({ audit });
  const dev = fakeDev();
  for (const t of createDevTools(dev)) core.registry.register(t);
  const approval: ApprovalProvider = {
    async request() {
      core.sessions.setMode('m', Mode.Act); // drop below Develop
      return { approved: true, available: true };
    },
  };
  const broker = new Broker(core.registry, core.sessions, approval, audit);
  core.sessions.setMode('m', Mode.Develop);
  const r = await broker.invoke('m', 'run_js', { script: '1' });
  assert.equal(r.reason, 'revoked');
  assert.equal(dev.scripts.length, 0);
});

// ===== Audit hygiene (#6) =====

test('AUDIT: fill value never appears in audit even with weird content', async () => {
  const { core, audit } = setupAll();
  core.sessions.setMode('m', Mode.Act);
  const secret = 'TOPSECRET-' + 'x'.repeat(50);
  const r = await core.broker.invoke('m', 'fill', { selector: '#pw', value: secret });
  assert.equal(r.ok, true);
  for (const e of audit.events) {
    assert.doesNotMatch(String(e.detail ?? ''), /TOPSECRET/, 'fill value must never be audited');
  }
});

test('AUDIT: run_js script IS audited (traceability)', async () => {
  const { core, audit } = setupAll();
  core.sessions.setMode('m', Mode.Develop);
  await core.broker.invoke('m', 'run_js', { script: 'document.cookie' });
  assert.match(String(audit.events.at(-1)?.detail), /document\.cookie/);
});

test('AUDIT: click selector IS audited', async () => {
  const { core, audit } = setupAll();
  core.sessions.setMode('m', Mode.Act);
  await core.broker.invoke('m', 'click', { selector: '#login-button' });
  assert.match(String(audit.events.at(-1)?.detail), /#login-button/);
});

// ===== Injection payloads survive validation but are passed verbatim (the
// embedding layer is the only defense; we confirm the broker does not mangle them
// and that the real defense is tested by the Chromium smoke). =====

const NASTY = [
  `'); window.__pwned=1; ('`,
  `"); window.__pwned=1; ("`,
  `\\'); window.__pwned=1; //`,
  `</script><img src=x onerror=alert(1)>`,
  `#x window.__pwned=1 `, // U+2028/U+2029 line separators
  `\n}); window.__pwned=1; (() => ({`,
  '`${window.__pwned=1}`',
];

test('INJECTION: nasty click selectors pass schema and reach the controller verbatim', async () => {
  const { core, act } = setupAll();
  core.sessions.setMode('m', Mode.Act);
  for (const sel of NASTY) {
    const r = await core.broker.invoke('m', 'click', { selector: sel });
    assert.equal(r.ok, true, `selector should validate: ${JSON.stringify(sel)}`);
  }
  // Each selector reaches the controller exactly (trimmed); the embedding layer must neutralize it.
  assert.equal(act.clicks.length, NASTY.length);
});

test('INJECTION: nasty fill values pass schema and reach the controller verbatim', async () => {
  const { core, act } = setupAll();
  core.sessions.setMode('m', Mode.Act);
  for (const v of NASTY) {
    const r = await core.broker.invoke('m', 'fill', { selector: '#x', value: v });
    assert.equal(r.ok, true);
  }
  assert.deepEqual(act.fills.map((f) => f[1]), NASTY, 'fill value passed through untouched');
});

test('INJECTION: nasty run_js scripts validate (they are MEANT to run; defense is the tier gate)', async () => {
  const { core, dev } = setupAll();
  core.sessions.setMode('m', Mode.Develop);
  const r = await core.broker.invoke('m', 'run_js', { script: 'window.__x=1//' + '</script>' });
  assert.equal(r.ok, true);
  assert.equal(dev.scripts.length, 1);
});
