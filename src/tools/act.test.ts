import test from 'node:test';
import assert from 'node:assert/strict';
import { createCore } from '../core';
import { Mode } from '../core/modes';
import { ApprovalProvider } from '../core/approval';
import { MemoryAuditSink } from '../core/audit';
import { Broker } from '../core/broker';
import { createActTools, ActController, ClickResult, FillResult, SubmitResult } from './act';

class ApproveAll implements ApprovalProvider {
  async request() {
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
      return { clicked: true, matched: 'Submit' };
    },
    async fill(_tab, selector, value): Promise<FillResult> {
      fills.push([selector, value]);
      return { filled: true, matched: 'email' };
    },
    async submit(_tab, selector): Promise<SubmitResult> {
      return { submitted: true, matched: selector };
    },
  };
}

function setup(approval?: ApprovalProvider) {
  const audit = new MemoryAuditSink();
  const core = createCore({ approvals: approval, audit });
  const act = fakeAct();
  for (const t of createActTools(act)) core.registry.register(t);
  return { core, act, audit };
}

test('click/fill denied below Act mode', async () => {
  const { core, act } = setup(new ApproveAll());
  for (const m of [Mode.Read, Mode.Inspect]) {
    core.sessions.setMode('main', m);
    assert.equal((await core.broker.invoke('main', 'click', { selector: '#go' })).reason, 'permission_denied');
  }
  assert.equal(act.clicks.length, 0);
});

test('click at Act is denied without approval', async () => {
  const { core, act } = setup(); // DenyAll
  core.sessions.setMode('main', Mode.Act);
  const r = await core.broker.invoke('main', 'click', { selector: '#go' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'approval_required');
  assert.equal(act.clicks.length, 0);
});

test('click runs once approved and audits the selector', async () => {
  const { core, act, audit } = setup(new ApproveAll());
  core.sessions.setMode('main', Mode.Act);
  const r = await core.broker.invoke<ClickResult>('main', 'click', { selector: '#submit' });
  assert.equal(r.ok, true);
  assert.equal(act.clicks[0], '#submit');
  assert.match(String(audit.events.at(-1)?.detail), /#submit/);
});

test('fill runs once approved but does NOT audit the value', async () => {
  const { core, act, audit } = setup(new ApproveAll());
  core.sessions.setMode('main', Mode.Act);
  const r = await core.broker.invoke<FillResult>('main', 'fill', {
    selector: '#pw',
    value: 'hunter2-secret',
  });
  assert.equal(r.ok, true);
  assert.deepEqual(act.fills[0], ['#pw', 'hunter2-secret']);
  // The sensitive value must not appear in the audit detail.
  assert.doesNotMatch(String(audit.events.at(-1)?.detail ?? ''), /hunter2-secret/);
});

test('click/fill reject malformed input', async () => {
  const { core } = setup(new ApproveAll());
  core.sessions.setMode('main', Mode.Act);
  assert.equal((await core.broker.invoke('main', 'click', { selector: '' })).reason, 'invalid_input');
  assert.equal((await core.broker.invoke('main', 'click', {})).reason, 'invalid_input');
  assert.equal((await core.broker.invoke('main', 'fill', { selector: '#x' })).reason, 'invalid_input');
  assert.equal(
    (await core.broker.invoke('main', 'fill', { selector: '#x', value: 5 })).reason,
    'invalid_input',
  );
});

test('a revoke during approval voids the action (never executes)', async () => {
  const audit = new MemoryAuditSink();
  const core = createCore({ audit });
  const act = fakeAct();
  for (const t of createActTools(act)) core.registry.register(t);
  const approval: ApprovalProvider = {
    async request() {
      core.sessions.revoke('main'); // Stop AI while the card is open
      return { approved: true, available: true };
    },
  };
  const broker = new Broker(core.registry, core.sessions, approval, audit);
  core.sessions.setMode('main', Mode.Act);
  const r = await broker.invoke('main', 'click', { selector: '#go' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'revoked');
  assert.equal(act.clicks.length, 0, 'action never executed after revoke');
});
