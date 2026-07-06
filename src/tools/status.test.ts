import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStatusTools } from './status';
import { Mode } from '../core/modes';
import { RiskLevel } from '../core/tool';
import { createCore } from '../core';

test('get_mode: off the ladder, read-only, no approval', () => {
  const [tool] = createStatusTools(() => Mode.Blocked);
  assert.equal(tool.name, 'get_mode');
  assert.equal(tool.minMode, Mode.Blocked, 'callable at any mode');
  assert.equal(tool.risk, RiskLevel.Low);
  assert.equal(tool.requiresApproval, false);
});

test('get_mode: reports the live mode through the broker, even while the tab is Off', async () => {
  const core = createCore();
  for (const t of createStatusTools((id) => core.sessions.get(id).mode)) core.registry.register(t);

  // Tab defaults to Blocked — get_mode must still be ALLOWED (where page tools would be denied).
  const off = await core.broker.invoke<{ tab: string; mode: string }>('main', 'get_mode', {});
  assert.equal(off.ok, true);
  assert.equal(off.output!.mode, Mode.Blocked);
  assert.equal(off.output!.tab, 'main');

  // After the user raises the mode, get_mode reflects it live.
  core.sessions.setMode('main', Mode.Inspect);
  const insp = await core.broker.invoke<{ tab: string; mode: string }>('main', 'get_mode', {});
  assert.equal(insp.output!.mode, Mode.Inspect);
});

test('get_mode: schema accepts {}/undefined, rejects non-object', () => {
  const [tool] = createStatusTools(() => Mode.Read);
  assert.deepEqual(tool.inputSchema.parse({}), {});
  assert.deepEqual(tool.inputSchema.parse(undefined), {});
  assert.throws(() => tool.inputSchema.parse('nope'));
});
