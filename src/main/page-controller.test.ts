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
