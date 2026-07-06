import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLocateTool, LocateController, LocateResult } from './locate';
import { Mode } from '../core/modes';

const emptyResult = (query: { text?: string; selector?: string }): LocateResult => ({ query, count: 0, matches: [] });

function fakeCtrl(spy?: (q: { text?: string; selector?: string }) => void): LocateController {
  return {
    async locate(_tabId, query) {
      spy?.(query);
      return emptyResult(query);
    },
  };
}

test('locate tool: Read-tier, low-risk, no approval, audited input', () => {
  const t = createLocateTool(fakeCtrl());
  assert.equal(t.name, 'locate');
  assert.equal(t.minMode, Mode.Read);
  assert.equal(t.requiresApproval, false);
  assert.equal(t.auditInput, true);
});

test('schema: requires a non-empty text or selector', () => {
  const t = createLocateTool(fakeCtrl());
  assert.throws(() => t.inputSchema.parse({}), /non-empty/);
  assert.throws(() => t.inputSchema.parse({ text: '   ' }), /non-empty/);
  assert.throws(() => t.inputSchema.parse({ text: '', selector: '' }), /non-empty/);
});

test('schema: trims and passes through text / selector', () => {
  const t = createLocateTool(fakeCtrl());
  assert.deepEqual(t.inputSchema.parse({ text: '  MacBook Pro ' }), { text: 'MacBook Pro', selector: undefined });
  assert.deepEqual(t.inputSchema.parse({ selector: ' a.btn ' }), { text: undefined, selector: 'a.btn' });
});

test('schema: caps overlong inputs (no unbounded strings into the page)', () => {
  const t = createLocateTool(fakeCtrl());
  const parsed = t.inputSchema.parse({ text: 'x'.repeat(500) });
  assert.equal(parsed.text!.length, 200);
});

test('handler forwards the parsed query to the controller with the tab id', async () => {
  let seen: { text?: string; selector?: string } | undefined;
  const t = createLocateTool(fakeCtrl((q) => (seen = q)));
  const ctx = { tabId: 't9', epoch: 0, isLive: () => true, signal: new AbortController().signal };
  const out = await t.handler({ text: 'Buy' }, ctx);
  assert.deepEqual(seen, { text: 'Buy' });
  assert.equal(out.query.text, 'Buy');
});
