import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFeedbackTool, FeedbackToolInput } from './feedback';
import { Mode } from '../core/modes';
import { RiskLevel, ToolContext } from '../core/tool';
import { FeedbackResult } from '../feedback/feedback';
import { createCore } from '../core';
import { ApprovalProvider, ApprovalDecision } from '../core/approval';

class AutoApprove implements ApprovalProvider {
  async request(): Promise<ApprovalDecision> {
    return { approved: true, available: true };
  }
}

function ctx(live = true): ToolContext {
  return { tabId: 'main', epoch: 1, isLive: () => live, signal: new AbortController().signal };
}

test('submit_feedback: mode-independent (minMode Blocked) but always requires approval', () => {
  const tool = createFeedbackTool(async () => ({ ok: true }));
  assert.equal(tool.name, 'submit_feedback');
  assert.equal(tool.minMode, Mode.Blocked, 'callable at any tab mode — not on the page ladder');
  assert.equal(tool.risk, RiskLevel.Medium);
  assert.equal(tool.requiresApproval, true, 'the approval card is the guard, not the tier');
});

test('submit_feedback: schema rejects empty / non-object input', () => {
  const tool = createFeedbackTool(async () => ({ ok: true }));
  assert.throws(() => tool.inputSchema.parse({ message: ' ' }));
  assert.throws(() => tool.inputSchema.parse({}));
  assert.throws(() => tool.inputSchema.parse('hi'));
  assert.deepEqual(tool.inputSchema.parse({ message: '  good  ' }), { message: 'good', email: undefined });
});

test('submit_feedback: auditDetail logs size, not the body', () => {
  const tool = createFeedbackTool(async () => ({ ok: true }));
  assert.equal(tool.auditDetail!({ message: 'hello' }), 'feedback submitted (5 chars)');
});

test('submit_feedback: handler calls send and returns { sent: true }', async () => {
  let got: FeedbackToolInput | null = null;
  const send = async (i: FeedbackToolInput): Promise<FeedbackResult> => {
    got = i;
    return { ok: true };
  };
  const tool = createFeedbackTool(send);
  const out = await tool.handler({ message: 'nice' }, ctx());
  assert.deepEqual(out, { sent: true });
  assert.deepEqual(got, { message: 'nice' });
});

test('submit_feedback: handler throws if the grant was revoked', async () => {
  const tool = createFeedbackTool(async () => ({ ok: true }));
  await assert.rejects(() => tool.handler({ message: 'nice' }, ctx(false)), /revoked/);
});

test('submit_feedback: handler surfaces a failed send as an error', async () => {
  const tool = createFeedbackTool(async () => ({ ok: false, error: 'server returned 503' }));
  await assert.rejects(() => tool.handler({ message: 'nice' }, ctx()), /503/);
});

test('submit_feedback: broker ALLOWS it through while the tab is Off (Blocked)', async () => {
  let sent: FeedbackToolInput | null = null;
  const core = createCore({ approvals: new AutoApprove() });
  core.registry.register(
    createFeedbackTool(async (i) => {
      sent = i;
      return { ok: true };
    }),
  );
  // Tab is Blocked (the default) — every PAGE tool would be permission_denied here.
  const res = await core.broker.invoke('main', 'submit_feedback', { message: 'works while off' });
  assert.equal(res.ok, true, 'feedback is allowed even with the tab Off');
  assert.equal(sent!.message, 'works while off');
});
