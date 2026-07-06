import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ElectronPageController } from './page-controller';
import { BrokerError, DenyReason } from '../core/errors';

/** `scroll_to` wrapper coverage against a duck-typed fake WebContents (the scroll runs in-page). */
function makeFake(jsResult: unknown) {
  const scripts: string[] = [];
  const wc = {
    isDestroyed: () => false,
    getZoomFactor: () => 1,
    async executeJavaScript(script: string): Promise<unknown> {
      scripts.push(script);
      return jsResult;
    },
  };
  return { wc, scripts };
}

function pc(fake: ReturnType<typeof makeFake>) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new ElectronPageController(() => fake.wc as any, { isActiveTab: () => true });
}

test('scrollTo: returns the settled centre for a found element', async () => {
  const fake = makeFake({ found: true, matched: 'Add to Bag', x: 640, y: 350, inViewport: true, obscured: false });
  const out = await pc(fake).scrollTo('t1', { text: 'Add to Bag' });
  assert.equal(out.found, true);
  assert.equal(out.inViewport, true);
  assert.deepEqual([out.x, out.y], [640, 350]);
});

test('scrollTo: no match returns found:false with a note (no throw)', async () => {
  const fake = makeFake({ found: false });
  const out = await pc(fake).scrollTo('t1', { text: 'Nonexistent' });
  assert.equal(out.found, false);
  assert.match(out.note ?? '', /no match/);
});

test('scrollTo: uses a user-gesture script (scrollIntoView needs it) and injects the query', async () => {
  const fake = makeFake({ found: true, matched: 'x', x: 0, y: 0, inViewport: true, obscured: false });
  await pc(fake).scrollTo('t1', { selector: 'button.buy' });
  assert.match(fake.scripts[0], /scrollIntoView/);
  assert.match(fake.scripts[0], /button\.buy/);
});

test('scrollTo: invalid selector maps to InvalidInput', async () => {
  const fake = makeFake({ error: 'bad selector' });
  await assert.rejects(
    () => pc(fake).scrollTo('t1', { selector: 'a[' }),
    (e: unknown) => e instanceof BrokerError && e.reason === DenyReason.InvalidInput,
  );
});
