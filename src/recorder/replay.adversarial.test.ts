import test from 'node:test';
import assert from 'node:assert/strict';
import { replayActions } from './replay';
import { Recorder } from './recorder';
import { RecordedAction } from './actions';

/**
 * Invariant #5: replay never replays a masked value, and is purely data-driven (it acts on
 * whatever the recipe holds). These tests prove masked fills are always skipped — even if a
 * tampered recipe sets masked:false but leaves value:null, or sets a value with masked:true.
 */

function fakeAct() {
  const fills: Array<{ selector: string; value: string }> = [];
  const clicks: string[] = [];
  return {
    ctrl: {
      async click(_tab: string, selector: string) {
        clicks.push(selector);
        return { clicked: true, matched: selector } as never;
      },
      async fill(_tab: string, selector: string, value: string) {
        fills.push({ selector, value });
        return { filled: true, matched: selector } as never;
      },
      async submit(_tab: string, selector: string) {
        return { submitted: true, matched: selector } as never;
      },
    },
    fills,
    clicks,
  };
}

test('invariant #5: a masked fill is skipped and its (null) value is never passed to fill()', async () => {
  const { ctrl, fills } = fakeAct();
  const actions: RecordedAction[] = [
    { type: 'fill', selector: '#pw', label: 'Password', value: null, masked: true, ts: 1 },
  ];
  const res = await replayActions(actions, { act: ctrl as never });
  assert.equal(res.skipped, 1);
  assert.equal(res.performed, 0);
  assert.deepEqual(fills, []);
  assert.equal(res.steps[0].status, 'skipped');
});

test('invariant #5: a tampered recipe with masked:true but a NON-null value is STILL skipped', async () => {
  // Defense in depth: even if something forged a value into a masked fill, replay must not
  // type it. The guard is `action.masked || action.value === null`.
  const { ctrl, fills } = fakeAct();
  const actions: RecordedAction[] = [
    { type: 'fill', selector: '#pw', label: 'pw', value: 'leaked-secret', masked: true, ts: 1 },
  ];
  const res = await replayActions(actions, { act: ctrl as never });
  assert.equal(res.skipped, 1);
  assert.deepEqual(fills, [], 'masked fill must never reach fill() even with a value present');
});

test('invariant #5: a fill with value:null but masked:false is also skipped (null guard)', async () => {
  const { ctrl, fills } = fakeAct();
  const actions: RecordedAction[] = [
    { type: 'fill', selector: '#x', label: 'x', value: null, masked: false, ts: 1 },
  ];
  const res = await replayActions(actions, { act: ctrl as never });
  assert.equal(res.skipped, 1);
  assert.deepEqual(fills, []);
});

test('invariant #5: non-masked fills replay literally; clicks replay', async () => {
  const { ctrl, fills, clicks } = fakeAct();
  const actions: RecordedAction[] = [
    { type: 'click', selector: '#login', label: 'Login', ts: 1 },
    { type: 'fill', selector: '#email', label: 'Email', value: 'a@b.c', masked: false, ts: 2 },
  ];
  const res = await replayActions(actions, { act: ctrl as never });
  assert.equal(res.performed, 2);
  assert.deepEqual(clicks, ['#login']);
  assert.deepEqual(fills, [{ selector: '#email', value: 'a@b.c' }]);
});

test('invariant #5: replay honors shouldContinue() (user Stop aborts mid-run)', async () => {
  const { ctrl, clicks } = fakeAct();
  const actions: RecordedAction[] = [
    { type: 'click', selector: '#a', label: 'A', ts: 1 },
    { type: 'click', selector: '#b', label: 'B', ts: 2 },
  ];
  let calls = 0;
  const res = await replayActions(actions, {
    act: ctrl as never,
    shouldContinue: () => calls++ < 1, // allow first, abort before second
  });
  assert.equal(res.performed, 1);
  assert.deepEqual(clicks, ['#a']);
});

test('invariant #5: navigate without a navigator is skipped, not silently executed elsewhere', async () => {
  const { ctrl } = fakeAct();
  const actions: RecordedAction[] = [{ type: 'navigate', url: 'https://evil.test', ts: 1 }];
  const res = await replayActions(actions, { act: ctrl as never });
  assert.equal(res.skipped, 1);
  assert.equal(res.performed, 0);
});

/**
 * Invariant #4: the recorder buffer only grows while recording is ON. main.ts additionally
 * gates record:action to the page view's webContents and validates the shape — but the
 * Recorder itself must also refuse appends when stopped.
 */

test('invariant #4: Recorder.add is a no-op when not recording', () => {
  const r = new Recorder();
  r.add({ type: 'click', selector: '#x', label: 'x', ts: 1 });
  assert.equal(r.count(), 0, 'append while stopped must be ignored');
  r.start();
  r.add({ type: 'click', selector: '#x', label: 'x', ts: 1 });
  assert.equal(r.count(), 1);
  r.stop();
  r.add({ type: 'click', selector: '#y', label: 'y', ts: 2 });
  assert.equal(r.count(), 1, 'append after stop must be ignored');
  r.clear();
  assert.equal(r.count(), 0);
});
