import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ElectronPageController } from './page-controller';
import { BrokerError, DenyReason } from '../core/errors';

/** `locate` wrapper coverage against a duck-typed fake WebContents (the DOM match runs in-page). */
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

test('locate: passes through the in-page matches and echoes the query', async () => {
  const matches = [
    { matched: 'MacBook Pro', tag: 'a[link]', x: 190, y: 60, rect: { x: 100, y: 40, width: 180, height: 40 }, inViewport: true, obscured: false },
  ];
  const fake = makeFake({ count: 1, matches });
  const out = await pc(fake).locate('t1', { text: 'MacBook Pro' });
  assert.equal(out.count, 1);
  assert.deepEqual(out.matches, matches);
  assert.deepEqual(out.query, { text: 'MacBook Pro' });
});

test('locate: injects the query text/selector into the page script', async () => {
  const fake = makeFake({ count: 0, matches: [] });
  await pc(fake).locate('t1', { selector: 'a.buy' });
  assert.match(fake.scripts[0], /a\.buy/);
});

test('locate: an invalid selector (in-page error) maps to InvalidInput, not a crash', async () => {
  const fake = makeFake({ error: 'bad selector' });
  await assert.rejects(
    () => pc(fake).locate('t1', { selector: 'a[' }),
    (e: unknown) => e instanceof BrokerError && e.reason === DenyReason.InvalidInput,
  );
});

test('locate: reports off-viewport matches (inViewport:false) without scrolling', async () => {
  const matches = [
    { matched: 'Footer link', tag: 'a[link]', x: 500, y: 3000, rect: { x: 480, y: 2980, width: 60, height: 20 }, inViewport: false, obscured: false },
  ];
  const fake = makeFake({ count: 1, matches });
  const out = await pc(fake).locate('t1', { text: 'Footer link' });
  assert.equal(out.matches[0].inViewport, false);
});
