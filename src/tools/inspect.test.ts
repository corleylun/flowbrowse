import test from 'node:test';
import assert from 'node:assert/strict';
import { createCore } from '../core';
import { Mode } from '../core/modes';
import {
  createInspectTools,
  InspectController,
  ElementInfo,
  ConsoleMessage,
  NetworkEntry,
} from './inspect';

function fakeInspect(): InspectController {
  return {
    async inspect(_tab, selector): Promise<ElementInfo> {
      return { matched: selector === '#known', tagName: 'div' };
    },
    async console(_tab, limit): Promise<ConsoleMessage[]> {
      const all: ConsoleMessage[] = [
        { level: 'info', text: 'a', ts: 1 },
        { level: 'error', text: 'b', ts: 2 },
      ];
      return all.slice(-limit);
    },
    async network(_tab, limit): Promise<NetworkEntry[]> {
      return [{ method: 'GET', url: 'https://x', status: 200, ts: 1 }].slice(-limit);
    },
  };
}

function setup() {
  const core = createCore();
  for (const t of createInspectTools(fakeInspect())) core.registry.register(t);
  return core;
}

test('inspect tools are denied below Inspect mode', async () => {
  const core = setup();
  core.sessions.setMode('main', Mode.Read); // Read < Inspect
  for (const name of ['inspect_element', 'read_console', 'read_network']) {
    const input = name === 'inspect_element' ? { selector: '#x' } : {};
    const r = await core.broker.invoke('main', name, input);
    assert.equal(r.reason, 'permission_denied', name);
  }
});

test('inspect_element returns element info at Inspect mode', async () => {
  const core = setup();
  core.sessions.setMode('main', Mode.Inspect);
  const r = await core.broker.invoke<ElementInfo>('main', 'inspect_element', { selector: '#known' });
  assert.equal(r.ok, true);
  assert.equal(r.output?.matched, true);
});

test('read_console / read_network return buffered entries (no approval needed)', async () => {
  const core = setup();
  core.sessions.setMode('main', Mode.Inspect);
  const c = await core.broker.invoke<ConsoleMessage[]>('main', 'read_console', {});
  assert.equal(c.ok, true);
  assert.equal(c.output?.length, 2);
  const n = await core.broker.invoke<NetworkEntry[]>('main', 'read_network', { limit: 1 });
  assert.equal(n.ok, true);
  assert.equal(n.output?.[0].url, 'https://x');
});

test('inspect_element requires a selector; read_* reject bad limits', async () => {
  const core = setup();
  core.sessions.setMode('main', Mode.Inspect);
  assert.equal((await core.broker.invoke('main', 'inspect_element', {})).reason, 'invalid_input');
  assert.equal(
    (await core.broker.invoke('main', 'read_console', { limit: -5 })).reason,
    'invalid_input',
  );
});

test('inspect tier is also available at higher modes (Act, Develop)', async () => {
  const core = setup();
  for (const m of [Mode.Act, Mode.Develop]) {
    core.sessions.setMode('main', m);
    const r = await core.broker.invoke('main', 'read_console', {});
    assert.equal(r.ok, true, `available at ${m}`);
  }
});
