import test from 'node:test';
import assert from 'node:assert/strict';
import { createCore } from '../core';
import { Mode } from '../core/modes';
import { createReadTools, PageController, PageExtract, Screenshot } from './read';

function fakePage(): PageController {
  return {
    async extract(tabId): Promise<PageExtract> {
      return {
        url: 'https://example.com',
        title: 'Example',
        text: `hello from ${tabId}`,
        links: [{ href: 'https://a.test', text: 'A' }],
      };
    },
    async screenshot(): Promise<Screenshot> {
      return { mimeType: 'image/png', base64: 'iVBORw0KGgo=' };
    },
  };
}

function coreWithReadTools() {
  const core = createCore();
  for (const tool of createReadTools(fakePage())) core.registry.register(tool);
  return core;
}

test('read_page is DENIED while the tab is Blocked (off by default)', async () => {
  const core = coreWithReadTools();
  const r = await core.broker.invoke('main', 'read_page', {});
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'permission_denied');
});

test('read_page SUCCEEDS once the tab is granted Read', async () => {
  const core = coreWithReadTools();
  core.sessions.setMode('main', Mode.Read);
  const r = await core.broker.invoke<PageExtract>('main', 'read_page', {});
  assert.equal(r.ok, true);
  assert.equal(r.output?.title, 'Example');
  assert.equal(r.output?.text, 'hello from main');
  assert.equal(r.output?.links.length, 1);
});

test('screenshot is Read-tier and returns a PNG', async () => {
  const core = coreWithReadTools();
  core.sessions.setMode('main', Mode.Read);
  const r = await core.broker.invoke<Screenshot>('main', 'screenshot', {});
  assert.equal(r.ok, true);
  assert.equal(r.output?.mimeType, 'image/png');
});

test('read tools are revoked instantly by Stop AI (epoch check)', async () => {
  const core = coreWithReadTools();
  core.sessions.setMode('main', Mode.Read);
  core.sessions.revoke('main'); // Stop AI
  const r = await core.broker.invoke('main', 'read_page', {});
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'permission_denied'); // back to Blocked
});

test('read tools reject non-object arguments (fail closed)', async () => {
  const core = coreWithReadTools();
  core.sessions.setMode('main', Mode.Read);
  const r = await core.broker.invoke('main', 'read_page', 'garbage');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'invalid_input');
});
