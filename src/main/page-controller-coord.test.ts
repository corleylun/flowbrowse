import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ElectronPageController } from './page-controller';
import { BrokerError, DenyReason } from '../core/errors';

/** Coordinate-tier real-input coverage against a duck-typed fake WebContents (electron is erased). */
interface InputEvent { type: string; x?: number; y?: number; keyCode?: string; button?: string; deltaX?: number; deltaY?: number }

function makeFake(opts?: {
  zoom?: number;
  vw?: number;
  vh?: number;
  imgW?: number;
  imgH?: number;
  emptyCapture?: boolean;
}) {
  const events: InputEvent[] = [];
  const wc = {
    isDestroyed: () => false,
    getZoomFactor: () => opts?.zoom ?? 1,
    sendInputEvent: (e: InputEvent) => events.push(e),
    async executeJavaScript(script: string): Promise<unknown> {
      if (script.includes('innerWidth')) return { vw: opts?.vw ?? 1000, vh: opts?.vh ?? 800 };
      return null;
    },
    capturePage: async () => ({
      getSize: () => ({ width: opts?.imgW ?? 2000, height: opts?.imgH ?? 1600 }),
      toPNG: () => Buffer.from('PNGDATA'),
      isEmpty: () => opts?.emptyCapture ?? false,
    }),
  };
  return { wc, events };
}

function pc(fake: ReturnType<typeof makeFake>, isActiveTab = true) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new ElectronPageController(() => fake.wc as any, { isActiveTab: () => isActiveTab });
}
const live = { isLive: () => true, signal: new AbortController().signal };

test('clickAt: move→down→up at the point, scaled by zoom', async () => {
  const fake = makeFake({ zoom: 2 });
  const r = await pc(fake).clickAt('t', 500, 400, 'left', live);
  assert.equal(r.done, true);
  assert.equal(r.realInput, true);
  assert.deepEqual(fake.events.map((e) => e.type), ['mouseMove', 'mouseDown', 'mouseUp']);
  assert.deepEqual(fake.events.map((e) => [e.x, e.y]), [[1000, 800], [1000, 800], [1000, 800]]);
  assert.equal(fake.events[1].button, 'left');
});

test('clickAt clamps a point outside the viewport (honest note)', async () => {
  const fake = makeFake({ vw: 1000, vh: 800 });
  const r = await pc(fake).clickAt('t', 5000, 400, 'left', live);
  assert.match(r.note ?? '', /clamped/);
  assert.equal(fake.events[0].x, 999); // clamped to vw-1
});

test('moveTo emits one mouseMove', async () => {
  const fake = makeFake();
  await pc(fake).moveTo('t', 10, 20, live);
  assert.deepEqual(fake.events.map((e) => e.type), ['mouseMove']);
});

test('scrollAt emits a mouseWheel with INVERTED deltas (positive dy = scroll down)', async () => {
  const fake = makeFake();
  await pc(fake).scrollAt('t', 100, 100, 240, 0, live);
  const w = fake.events.find((e) => e.type === 'mouseWheel')!;
  // Electron's wheel deltaY is inverted vs DOM/scrollBy, so the agent's +dy becomes -240.
  assert.equal(w.deltaY, -240);
  assert.equal(w.deltaX, -0);
});

test('pressKey emits keyDown+keyUp with the key', async () => {
  const fake = makeFake();
  await pc(fake).pressKey('t', 'Enter', live);
  assert.deepEqual(fake.events.map((e) => [e.type, e.keyCode]), [['keyDown', 'Enter'], ['keyUp', 'Enter']]);
});

test('typeText emits keyDown→char→keyUp per char', async () => {
  const fake = makeFake();
  await pc(fake).typeText('t', 'hi', live);
  assert.deepEqual(fake.events.map((e) => e.type), ['keyDown', 'char', 'keyUp', 'keyDown', 'char', 'keyUp']);
  assert.deepEqual(fake.events.filter((e) => e.type === 'char').map((e) => e.keyCode), ['h', 'i']);
});

test('background tab: no real input, honest note', async () => {
  const fake = makeFake();
  const r = await pc(fake, false).clickAt('t', 10, 10, 'left', live);
  assert.equal(r.done, false);
  assert.match(r.note ?? '', /active tab/);
  assert.equal(fake.events.length, 0);
});

test('revoke mid type_text stops the keystrokes', async () => {
  const fake = makeFake();
  let n = 0;
  const dying = { signal: new AbortController().signal, isLive: () => (++n <= 2) };
  await assert.rejects(
    () => pc(fake).typeText('t', 'abcdef', dying),
    (e: unknown) => e instanceof BrokerError && (e as BrokerError).reason === DenyReason.Revoked,
  );
  assert.ok(fake.events.filter((e) => e.type === 'char').length < 6);
});

test('previewAt: screenshot + crosshair mapped CSS→image pixels', async () => {
  const fake = makeFake({ vw: 1000, vh: 800, imgW: 2000, imgH: 1600 });
  const p = await pc(fake).previewAt('t', 500, 400);
  assert.ok(p);
  assert.equal(p!.w, 2000);
  assert.equal(p!.h, 1600);
  assert.equal(p!.x, 1000); // 500 * (2000/1000)
  assert.equal(p!.y, 800); // 400 * (1600/800)
  assert.equal(p!.image, Buffer.from('PNGDATA').toString('base64'));
});

test('previewAt without a point: image, no marker', async () => {
  const fake = makeFake();
  const p = await pc(fake).previewAt('t');
  assert.ok(p);
  assert.equal(p!.x, undefined);
  assert.equal(p!.y, undefined);
});

test('screenshot: a normal capture returns the PNG unaffected', async () => {
  const fake = makeFake();
  const s = await pc(fake).screenshot('t');
  assert.equal(s.base64, Buffer.from('PNGDATA').toString('base64'));
  assert.equal(s.note, undefined);
});

test('screenshot: an EMPTY capture (e.g. a hidden background tab) is reported honestly', async () => {
  const fake = makeFake({ emptyCapture: true });
  const s = await pc(fake).screenshot('t');
  assert.equal(s.base64, '');
  assert.match(s.note ?? '', /hidden|backgrounded/);
});
