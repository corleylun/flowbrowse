import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ElectronPageController, CHAR_SETTLE_MS, RealInputHooks } from './page-controller';
import { BrokerError, DenyReason } from '../core/errors';

/**
 * Real-input unit coverage. ElectronPageController imports electron only as `import type`
 * (erased at runtime), so a duck-typed fake WebContents drives the whole real-input path with
 * no Electron present. The fake records sendInputEvent calls and answers executeJavaScript by
 * matching marker substrings in the (fixed) action scripts.
 */

interface InputEvent {
  type: string;
  x?: number;
  y?: number;
  keyCode?: string;
  button?: string;
}

function makeFake(opts?: {
  zoom?: number;
  locate?: { found: boolean; obscured: boolean; matched: string; x: number; y: number };
  landed?: { filled: boolean; matched: string };
}) {
  const events: InputEvent[] = [];
  const locate = opts?.locate ?? { found: true, obscured: false, matched: 'Submit', x: 100, y: 50 };
  const landed = opts?.landed ?? { filled: true, matched: 'q' };
  const wc = {
    isDestroyed: () => false,
    getZoomFactor: () => opts?.zoom ?? 1,
    sendInputEvent: (e: InputEvent) => events.push(e),
    async executeJavaScript(script: string): Promise<unknown> {
      if (script.includes('elementFromPoint')) return locate; // locatePoint
      if (script.includes('execCommand')) return { filled: true, matched: 'jsfill' }; // jsFill
      if (script.includes('activeElement')) return true; // selectAllInFocused
      if (script.includes('readBack')) return landed; // fieldLanded
      if (script.includes('el.click()')) return { clicked: true, matched: 'JS-Btn' }; // jsClick
      return null;
    },
  };
  return { wc, events };
}

function controller(fake: ReturnType<typeof makeFake>, hooks: Partial<RealInputHooks>) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new ElectronPageController(() => fake.wc as any, hooks);
}

const alwaysLive = { isLive: () => true, signal: new AbortController().signal };

test('toggle OFF → JS click path, no real input', async () => {
  const fake = makeFake();
  const pc = controller(fake, { realInputFor: () => false });
  const r = await pc.click('t', '#go');
  assert.equal(r.clicked, true);
  assert.equal(r.realInput, false);
  assert.equal(fake.events.length, 0); // never touched sendInputEvent
});

test('toggle ON + active + visible → real mouse move→down→up at zoom-scaled centre', async () => {
  const fake = makeFake({ zoom: 2, locate: { found: true, obscured: false, matched: 'Submit', x: 100, y: 50 } });
  const pc = controller(fake, { realInputFor: () => true, isActiveTab: () => true });
  const r = await pc.click('t', '#go', undefined, alwaysLive);
  assert.equal(r.clicked, true);
  assert.equal(r.realInput, true);
  assert.equal(r.matched, 'Submit');
  assert.deepEqual(
    fake.events.map((e) => e.type),
    ['mouseMove', 'mouseDown', 'mouseUp'],
  );
  // zoomFactor 2 → CSS (100,50) becomes device (200,100)
  assert.deepEqual(fake.events.map((e) => [e.x, e.y]), [
    [200, 100],
    [200, 100],
    [200, 100],
  ]);
});

test('obscured target → no click dispatched, honest note', async () => {
  const fake = makeFake({ locate: { found: true, obscured: true, matched: 'Submit', x: 100, y: 50 } });
  const pc = controller(fake, { realInputFor: () => true, isActiveTab: () => true });
  const r = await pc.click('t', '#go', undefined, alwaysLive);
  assert.equal(r.clicked, false);
  assert.equal(r.realInput, true);
  assert.match(r.note ?? '', /obscured/);
  assert.equal(fake.events.length, 0); // never fired a trusted click at the overlay
});

test('not the active tab → honest JS fallback, realInput:false', async () => {
  const fake = makeFake();
  const pc = controller(fake, { realInputFor: () => true, isActiveTab: () => false });
  const r = await pc.click('t', '#go', undefined, alwaysLive);
  assert.equal(r.clicked, true);
  assert.equal(r.realInput, false);
  assert.match(r.note ?? '', /active tab/);
  assert.equal(fake.events.length, 0);
});

test('real fill → focus click then per-char keyDown→char→keyUp, value lands', async () => {
  const fake = makeFake({ landed: { filled: true, matched: 'q' } });
  const pc = controller(fake, { realInputFor: () => true, isActiveTab: () => true });
  const r = await pc.fill('t', '#q', 'hi', undefined, alwaysLive);
  assert.equal(r.filled, true);
  assert.equal(r.realInput, true);
  const types = fake.events.map((e) => e.type);
  // one focus click, then h/i each as keyDown,char,keyUp
  assert.deepEqual(types, [
    'mouseMove', 'mouseDown', 'mouseUp',
    'keyDown', 'char', 'keyUp',
    'keyDown', 'char', 'keyUp',
  ]);
  const chars = fake.events.filter((e) => e.type === 'char').map((e) => e.keyCode);
  assert.deepEqual(chars, ['h', 'i']);
});

test('revoke mid-fill stops typing (instant revoke is real)', async () => {
  const fake = makeFake();
  let calls = 0;
  const live = {
    signal: new AbortController().signal,
    isLive: () => {
      calls += 1;
      return calls <= 2; // live for the focus check + first char, dead after
    },
  };
  const pc = controller(fake, { realInputFor: () => true, isActiveTab: () => true });
  await assert.rejects(
    () => pc.fill('t', '#q', 'abcdef', undefined, live),
    (e: unknown) => e instanceof BrokerError && (e as BrokerError).reason === DenyReason.Revoked,
  );
  // typing stopped early: far fewer than 6 chars were sent
  const chars = fake.events.filter((e) => e.type === 'char').length;
  assert.ok(chars < 6, `expected typing to stop early, got ${chars} chars`);
});

test('CHAR_SETTLE_MS is a fixed constant (scope-line guard)', () => {
  // Guards the evasion boundary: the inter-char delay must stay a single fixed value, never
  // variable/jittered/content-dependent. If this changes, it must be a deliberate constant change.
  assert.equal(typeof CHAR_SETTLE_MS, 'number');
  assert.equal(CHAR_SETTLE_MS, 12);
});

// --- No-retroactive-leak: clearInspectBuffers ---

/**
 * A fake WebContents that models what `attach()` actually wires up: `on('console-message', …)`,
 * `session.webRequest.onCompleted(…)`, and `on('dom-ready', …)`. `fireConsole`/`fireNetwork`
 * invoke the captured listeners directly, simulating page activity — exactly what a page does
 * while the tab is Blocked, before any grant.
 */
function makeInspectFake() {
  const handlers: Record<string, Array<(...args: unknown[]) => void>> = {};
  const completedHandlers: Array<(details: { method: string; url: string; statusCode: number }) => void> = [];
  const wc = {
    isDestroyed: () => false,
    on(event: string, cb: (...args: unknown[]) => void) {
      (handlers[event] ??= []).push(cb);
    },
    session: {
      webRequest: {
        onCompleted(cb: (details: { method: string; url: string; statusCode: number }) => void) {
          completedHandlers.push(cb);
        },
      },
    },
    async executeJavaScript() {
      return null;
    },
  };
  return {
    wc,
    fireConsole: (level: string, message: string) =>
      handlers['console-message']?.forEach((cb) => cb({ level, message })),
    fireNetwork: (method: string, url: string, statusCode: number) =>
      completedHandlers.forEach((cb) => cb({ method, url, statusCode })),
  };
}

test('clearInspectBuffers: no retroactive leak of console/network from the blind period', async () => {
  const fake = makeInspectFake();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pc = new ElectronPageController(() => fake.wc as any);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  pc.attach('t1', fake.wc as any);

  // Blind period: the tab is Blocked, but the page still logs to console and fires requests
  // (this is normal page behavior — the block is about AI visibility, not the page itself).
  fake.fireConsole('log', 'leaked-token-during-blind-period');
  fake.fireNetwork('GET', 'https://example.com/session?token=leaked-during-blind-period', 200);

  // Sanity: the buffers really did capture the blind-period activity.
  assert.equal((await pc.console('t1', 100)).length, 1);
  assert.equal((await pc.network('t1', 100)).length, 1);

  // The AI is now granted Inspect (or any mode) — this is the no-retroactive-leak hook that
  // must run on every grant (and on revoke) so nothing from before it is visible after.
  pc.clearInspectBuffers('t1');

  const consoleAfterGrant = await pc.console('t1', 100);
  const networkAfterGrant = await pc.network('t1', 100);
  assert.deepEqual(consoleAfterGrant, [], 'read_console must not return blind-period entries after a grant');
  assert.deepEqual(networkAfterGrant, [], 'read_network must not return blind-period entries after a grant');

  // Activity captured AFTER the grant must still show up — this isn't a "buffers are broken"
  // regression, only the blind-period content must be gone.
  fake.fireConsole('log', 'after-grant');
  fake.fireNetwork('GET', 'https://example.com/after-grant', 200);
  assert.equal((await pc.console('t1', 100)).length, 1);
  assert.equal((await pc.network('t1', 100)).length, 1);
});
