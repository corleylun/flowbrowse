import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createScrollToTool, ScrollToController, ScrollToResult } from './scroll-to';
import { Mode } from '../core/modes';

function fakeCtrl(spy?: (q: { text?: string; selector?: string }) => void): ScrollToController {
  return {
    async scrollTo(_tabId, query) {
      spy?.(query);
      return { found: true, matched: 'Add to Bag', x: 100, y: 200, inViewport: true, obscured: false } as ScrollToResult;
    },
  };
}

test('scroll_to tool: Act-tier, low-risk, approval-gated, audited', () => {
  const t = createScrollToTool(fakeCtrl());
  assert.equal(t.name, 'scroll_to');
  assert.equal(t.minMode, Mode.Act);
  assert.equal(t.requiresApproval, true);
  // Audit shows the human-legible query, not a raw delta.
  assert.equal(t.auditDetail!({ text: 'Add to Bag' }), 'text: Add to Bag');
  assert.equal(t.auditDetail!({ selector: 'button.buy' }), 'selector: button.buy');
});

test('schema: requires a non-empty text or selector', () => {
  const t = createScrollToTool(fakeCtrl());
  assert.throws(() => t.inputSchema.parse({}), /non-empty/);
  assert.throws(() => t.inputSchema.parse({ text: '  ' }), /non-empty/);
});

test('schema: trims + caps inputs', () => {
  const t = createScrollToTool(fakeCtrl());
  assert.deepEqual(t.inputSchema.parse({ text: '  Add to Bag ' }), { text: 'Add to Bag', selector: undefined });
  assert.equal(t.inputSchema.parse({ text: 'x'.repeat(400) }).text!.length, 200);
});

test('handler forwards the query and returns the settled coordinates', async () => {
  let seen: { text?: string; selector?: string } | undefined;
  const t = createScrollToTool(fakeCtrl((q) => (seen = q)));
  const ctx = { tabId: 't3', epoch: 0, isLive: () => true, signal: new AbortController().signal };
  const out = await t.handler({ text: 'Add to Bag' }, ctx);
  assert.deepEqual(seen, { text: 'Add to Bag' });
  assert.equal(out.found, true);
  assert.equal(out.x, 100);
  assert.equal(out.y, 200);
});
