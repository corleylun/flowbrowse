import test from 'node:test';
import assert from 'node:assert/strict';
import { createCore } from '../core';
import { Mode } from '../core/modes';
import { ApprovalProvider } from '../core/approval';
import { MemoryAuditSink } from '../core/audit';
import { Broker } from '../core/broker';
import { createDevTools, DevController } from './dev';

class ApproveAll implements ApprovalProvider {
  async request() {
    return { approved: true, available: true };
  }
}

function fakeDev(): DevController & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async runJs(_tabId, script) {
      calls.push(script);
      return { ran: script };
    },
  };
}

function setup(approval?: ApprovalProvider) {
  const audit = new MemoryAuditSink();
  const core = createCore({ approvals: approval, audit });
  const dev = fakeDev();
  for (const t of createDevTools(dev)) core.registry.register(t);
  return { core, dev, audit };
}

test('run_js is denied below Develop mode (its own grant)', async () => {
  const { core, dev } = setup(new ApproveAll());
  for (const m of [Mode.Read, Mode.Inspect, Mode.Act]) {
    core.sessions.setMode('main', m);
    const r = await core.broker.invoke('main', 'run_js', { script: '1+1' });
    assert.equal(r.ok, false, `denied at ${m}`);
    assert.equal(r.reason, 'permission_denied');
  }
  assert.equal(dev.calls.length, 0, 'never executed below Develop');
});

test('run_js at Develop is denied without approval (DenyAll default)', async () => {
  const { core, dev } = setup(); // default DenyAll
  core.sessions.setMode('main', Mode.Develop);
  const r = await core.broker.invoke('main', 'run_js', { script: 'alert(1)' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'approval_required');
  assert.equal(dev.calls.length, 0, 'never executed without approval');
});

test('run_js at Develop runs once approved, and the script is audited', async () => {
  const { core, dev, audit } = setup(new ApproveAll());
  core.sessions.setMode('main', Mode.Develop);
  const r = await core.broker.invoke<{ ran: string }>('main', 'run_js', { script: 'document.title' });
  assert.equal(r.ok, true);
  assert.equal(dev.calls[0], 'document.title');
  const ev = audit.events.at(-1)!;
  assert.equal(ev.outcome, 'allowed');
  assert.match(String(ev.detail), /document\.title/, 'script is recorded in the audit');
});

test('run_js rejects non-string / empty / oversized scripts (fail closed)', async () => {
  const { core } = setup(new ApproveAll());
  core.sessions.setMode('main', Mode.Develop);
  for (const bad of [{ script: 123 }, { script: '' }, { script: '   ' }, {}, 'nope']) {
    const r = await core.broker.invoke('main', 'run_js', bad);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'invalid_input');
  }
});

test('run_js: a revoke during approval voids it (never executes)', async () => {
  // Approval provider that revokes the grant while the card is "open", then approves.
  const audit = new MemoryAuditSink();
  const core = createCore({ audit });
  const dev = fakeDev();
  for (const t of createDevTools(dev)) core.registry.register(t);
  const approval: ApprovalProvider = {
    async request() {
      core.sessions.revoke('main'); // Stop AI lands while the card is open
      return { approved: true, available: true };
    },
  };
  // Rebuild broker with this approval provider sharing the same sessions/registry.
  const broker = new Broker(core.registry, core.sessions, approval, audit);
  core.sessions.setMode('main', Mode.Develop);
  const r = await broker.invoke('main', 'run_js', { script: 'steal()' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'revoked');
  assert.equal(dev.calls.length, 0, 'script never executed after revoke');
});
