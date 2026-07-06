import test from 'node:test';
import assert from 'node:assert/strict';
import { createCore } from '../core';
import { Mode } from '../core/modes';
import { createReadTools, PageController, PageExtract, Screenshot } from './read';

/**
 * Phase 3 adversarial probes for the read tools, exercised THROUGH the broker.
 *
 * These complement read.test.ts (which covers the happy off-by-default / grant /
 * stop / bad-arg basics). Here we attack the seams an adversarial reviewer worries
 * about: per-mode gating across the whole ladder, the no-retroactive-leak claim,
 * a revoke that lands WHILE a read is in flight, a hostile/hanging controller, and
 * the fact that a tool handler is only ever handed the brokered context (never a
 * raw page/webContents).
 */

interface Probe {
  extractCalls: number;
  screenshotCalls: number;
  lastTabId: string | null;
  /** Resolver for a deferred extract, set when `deferNextExtract` is on. */
  releaseExtract?: () => void;
}

function fakePage(probe: Probe, opts: { defer?: boolean; hang?: boolean } = {}): PageController {
  return {
    async extract(tabId): Promise<PageExtract> {
      probe.extractCalls++;
      probe.lastTabId = tabId;
      if (opts.hang) {
        // Never resolves — simulates a wedged page/executeJavaScript.
        await new Promise<never>(() => {});
      }
      if (opts.defer) {
        await new Promise<void>((resolve) => {
          probe.releaseExtract = resolve;
        });
      }
      return {
        url: 'https://example.com/secret',
        title: 'Secret',
        text: `live text for ${tabId}`,
        links: [],
      };
    },
    async screenshot(tabId): Promise<Screenshot> {
      probe.screenshotCalls++;
      probe.lastTabId = tabId;
      return { mimeType: 'image/png', base64: 'iVBORw0KGgo=' };
    },
  };
}

function makeProbe(): Probe {
  return { extractCalls: 0, screenshotCalls: 0, lastTabId: null };
}

function coreWith(page: PageController) {
  const core = createCore();
  for (const tool of createReadTools(page)) core.registry.register(tool);
  return core;
}

// --- Off-by-default: NOTHING runs while Blocked, and the page is never touched ----

test('Blocked tab: read_page denied AND the PageController is never called (no eager read)', async () => {
  const probe = makeProbe();
  const core = coreWith(fakePage(probe));
  const r = await core.broker.invoke('main', 'read_page', {});
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'permission_denied');
  // The signature claim: while Blocked, nothing about the page is read at all.
  assert.equal(probe.extractCalls, 0, 'extract must NOT run while Blocked');
});

test('Blocked tab: screenshot denied and capturePage never invoked', async () => {
  const probe = makeProbe();
  const core = coreWith(fakePage(probe));
  const r = await core.broker.invoke('main', 'screenshot', {});
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'permission_denied');
  assert.equal(probe.screenshotCalls, 0);
});

// --- No-retroactive-leak: a grant only reads CURRENT state, on demand --------------

test('no-retroactive-leak: granting Read reads live (post-grant) state only', async () => {
  const probe = makeProbe();
  const core = coreWith(fakePage(probe));
  // Simulate a "blind period": several denied attempts before the grant.
  await core.broker.invoke('main', 'read_page', {});
  await core.broker.invoke('main', 'read_page', {});
  assert.equal(probe.extractCalls, 0, 'no buffering of page content while blind');

  core.sessions.setMode('main', Mode.Read);
  const r = await core.broker.invoke<PageExtract>('main', 'read_page', {});
  assert.equal(r.ok, true);
  // Exactly ONE live read happened — the result is produced on demand, not replayed.
  assert.equal(probe.extractCalls, 1);
  assert.equal(r.output?.text, 'live text for main');
});

// --- Instant revoke landing DURING an in-flight read: result discarded -------------

test('revoke during in-flight extract: result is DISCARDED (fails closed as revoked)', async () => {
  const probe = makeProbe();
  const core = coreWith(fakePage(probe, { defer: true }));
  core.sessions.setMode('main', Mode.Read);

  const pending = core.broker.invoke('main', 'read_page', {});
  // Let the handler start and park on the deferred promise.
  await new Promise((r) => setImmediate(r));
  assert.equal(probe.extractCalls, 1, 'handler started');

  // User hits Stop AI mid-flight → epoch bumps.
  core.sessions.revoke('main');

  // Now let the page finish returning its (now stale) content.
  probe.releaseExtract?.();
  const r = await pending;
  assert.equal(r.ok, false, 'a result produced under a revoked grant must not be returned');
  assert.equal(r.reason, 'revoked');
});

test('mode change (Read→Inspect) during in-flight extract also discards the result', async () => {
  const probe = makeProbe();
  const core = coreWith(fakePage(probe, { defer: true }));
  core.sessions.setMode('main', Mode.Read);

  const pending = core.broker.invoke('main', 'read_page', {});
  await new Promise((r) => setImmediate(r));
  core.sessions.setMode('main', Mode.Inspect); // any epoch bump invalidates the call

  probe.releaseExtract?.();
  const r = await pending;
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'revoked');
});

// --- Mode ladder: Read-tier tools are reachable from Read and above, not below -----

test('mode ladder: read_page denied at Blocked, allowed at Read/Inspect/Act/Develop', async () => {
  for (const [mode, expectOk] of [
    [Mode.Blocked, false],
    [Mode.Read, true],
    [Mode.Inspect, true],
    [Mode.Act, true],
    [Mode.Develop, true],
  ] as const) {
    const probe = makeProbe();
    const core = coreWith(fakePage(probe));
    core.sessions.setMode('main', mode);
    const r = await core.broker.invoke('main', 'read_page', {});
    assert.equal(r.ok, expectOk, `mode ${mode} expected ok=${expectOk}`);
    if (!expectOk) assert.equal(r.reason, 'permission_denied');
  }
});

// --- Input validation: no-arg parser must reject scalars but allow object/null/none -

test('read_page rejects scalar args (number/boolean/string) as invalid_input', async () => {
  for (const bad of [42, true, 'x', Symbol.iterator] as unknown[]) {
    const probe = makeProbe();
    const core = coreWith(fakePage(probe));
    core.sessions.setMode('main', Mode.Read);
    const r = await core.broker.invoke('main', 'read_page', bad);
    assert.equal(r.ok, false, `arg ${String(bad)} should be rejected`);
    assert.equal(r.reason, 'invalid_input');
    assert.equal(probe.extractCalls, 0, 'invalid input must fail closed before the handler runs');
  }
});

test('read_page accepts undefined / null / object (and ignores extra keys)', async () => {
  for (const good of [undefined, null, {}, { junk: 1 }] as unknown[]) {
    const probe = makeProbe();
    const core = coreWith(fakePage(probe));
    core.sessions.setMode('main', Mode.Read);
    const r = await core.broker.invoke('main', 'read_page', good);
    assert.equal(r.ok, true, `arg ${JSON.stringify(good)} should be accepted`);
  }
});

// --- Wrong tab id: a tool for a different tab gets that tab's (Blocked) state -------

test('a different (unseen) tab is Blocked even when "main" is granted', async () => {
  const probe = makeProbe();
  const core = coreWith(fakePage(probe));
  core.sessions.setMode('main', Mode.Read);
  const r = await core.broker.invoke('other', 'read_page', {});
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'permission_denied');
  assert.equal(probe.extractCalls, 0);
});

// --- Handler only ever receives the brokered context, never a raw page -------------

test('handler is invoked with only {tabId, epoch, isLive, signal} — no raw page/webContents', async () => {
  let seenCtx: unknown = null;
  const page: PageController = {
    async extract(tabId): Promise<PageExtract> {
      return { url: 'u', title: 't', text: 'x', links: [] };
    },
    async screenshot(): Promise<Screenshot> {
      return { mimeType: 'image/png', base64: '' };
    },
  };
  // Wrap createReadTools' tool to capture the ctx the broker hands the handler.
  const core = createCore();
  const tools = createReadTools(page);
  for (const t of tools) {
    const orig = t.handler.bind(t);
    (t as { handler: typeof t.handler }).handler = (input, ctx) => {
      seenCtx = ctx;
      return orig(input, ctx);
    };
    core.registry.register(t);
  }
  core.sessions.setMode('main', Mode.Read);
  await core.broker.invoke('main', 'read_page', {});
  assert.ok(seenCtx, 'handler ran');
  const keys = Object.keys(seenCtx as object).sort();
  assert.deepEqual(keys, ['epoch', 'isLive', 'signal', 'tabId']);
});

// --- A throwing page controller is reported as a handler error, not a raw leak ------

test('a page controller that throws surfaces as a sanitized handler error', async () => {
  const core = createCore();
  const page: PageController = {
    async extract(): Promise<PageExtract> {
      throw new Error('SECRET internal path /Users/victim/.cookies');
    },
    async screenshot(): Promise<Screenshot> {
      return { mimeType: 'image/png', base64: '' };
    },
  };
  for (const t of createReadTools(page)) core.registry.register(t);
  core.sessions.setMode('main', Mode.Read);
  const r = await core.broker.invoke('main', 'read_page', {});
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'handler_error');
  // The broker must not leak the raw exception text (which could carry secrets/paths).
  assert.ok(!/SECRET internal path/.test(r.message ?? ''), 'raw handler error must be redacted');
});
