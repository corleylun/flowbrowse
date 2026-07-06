import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTabTools, TabInfo, SwitchResult } from './tabs';
import { Mode } from '../core/modes';
import { ToolContext } from '../core/tool';

const ctx = { tabId: 't1', epoch: 1, isLive: () => true, signal: new AbortController().signal } as ToolContext;

function tools(deps: Parameters<typeof createTabTools>[0]) {
  const list = createTabTools(deps);
  return {
    list_tabs: list.find((t) => t.name === 'list_tabs')!,
    switch_tab: list.find((t) => t.name === 'switch_tab')!,
  };
}

test('both tools are off the ladder, no approval', () => {
  const { list_tabs, switch_tab } = tools({ list: () => [], switchTo: () => ({ switched: true }) });
  for (const t of [list_tabs, switch_tab]) {
    assert.equal(t.minMode, Mode.Blocked);
    assert.equal(t.requiresApproval, false);
  }
});

test('list_tabs returns the host-provided (already-redacted) tab list verbatim', async () => {
  const rows: TabInfo[] = [
    { tab: 't1', active: true, mode: Mode.Read, title: 'Threads', url: 'https://threads.net/' },
    { tab: 't2', active: false, mode: Mode.Blocked, title: '[Filtered]', url: 'https://mail.google.com/' },
  ];
  const { list_tabs } = tools({ list: () => rows, switchTo: () => ({ switched: true }) });
  const out = (await list_tabs.handler({}, ctx)) as { tabs: TabInfo[] };
  assert.deepEqual(out.tabs, rows);
});

test('switch_tab passes the requested id to the host and returns its result', async () => {
  let asked = '';
  const result: SwitchResult = { switched: true, tab: 't2' };
  const { switch_tab } = tools({
    list: () => [],
    switchTo: (id) => {
      asked = id;
      return result;
    },
  });
  const out = (await switch_tab.handler({ tab: 't2' }, ctx)) as SwitchResult;
  assert.equal(asked, 't2');
  assert.deepEqual(out, result);
});

test('switch_tab surfaces a denial reason without throwing', async () => {
  const { switch_tab } = tools({
    list: () => [],
    switchTo: () => ({ switched: false, reason: 'tab switching is disabled in Settings' }),
  });
  const out = (await switch_tab.handler({ tab: 't9' }, ctx)) as SwitchResult;
  assert.equal(out.switched, false);
  assert.match(out.reason!, /disabled/);
});

test('switch_tab audits the target id but never anything else', () => {
  const { switch_tab } = tools({ list: () => [], switchTo: () => ({ switched: true }) });
  assert.equal(switch_tab.auditDetail!({ tab: 't3' }), '→ t3');
});

test('switch_tab input schema rejects a missing/empty tab', () => {
  const { switch_tab } = tools({ list: () => [], switchTo: () => ({ switched: true }) });
  assert.throws(() => switch_tab.inputSchema.parse({}));
  assert.throws(() => switch_tab.inputSchema.parse({ tab: '   ' }));
  assert.deepEqual(switch_tab.inputSchema.parse({ tab: ' t2 ' }), { tab: 't2' });
});
