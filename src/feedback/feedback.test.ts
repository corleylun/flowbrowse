import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeFeedback, submitFeedback, FetchLike } from './feedback';

test('normalizeFeedback: trims, requires a message, defaults source to user', () => {
  const n = normalizeFeedback({ message: '  great tool  ' });
  assert.equal(n.message, 'great tool');
  assert.equal(n.source, 'user');
  assert.equal(n.email, undefined);
});

test('normalizeFeedback: keeps agent source + email + context, caps length', () => {
  const n = normalizeFeedback({
    message: 'x'.repeat(9000),
    email: '  a@b.com ',
    source: 'agent',
    context: 'SafeCoBrowser 0.0.1 / darwin',
  });
  assert.equal(n.source, 'agent');
  assert.equal(n.email, 'a@b.com');
  assert.equal(n.message.length, 5000);
  assert.equal(n.context, 'SafeCoBrowser 0.0.1 / darwin');
});

test('normalizeFeedback: throws on empty / too-short message', () => {
  assert.throws(() => normalizeFeedback({ message: ' ' }));
  assert.throws(() => normalizeFeedback({ message: 123 as unknown }));
});

test('submitFeedback: posts normalised JSON to the endpoint and reports ok', async () => {
  let captured: { url: string; body: unknown } | null = null;
  const fake: FetchLike = async (url, init) => {
    captured = { url, body: JSON.parse(init.body) };
    return { ok: true, status: 200 };
  };
  const res = await submitFeedback(
    { message: 'hello', source: 'agent' },
    { endpoint: 'https://example.test/api/feedback', fetchFn: fake },
  );
  assert.equal(res.ok, true);
  assert.equal(res.status, 200);
  assert.equal(captured!.url, 'https://example.test/api/feedback');
  assert.deepEqual(captured!.body, { message: 'hello', source: 'agent' });
});

test('submitFeedback: invalid input never reaches the network', async () => {
  let called = false;
  const fake: FetchLike = async () => {
    called = true;
    return { ok: true, status: 200 };
  };
  const res = await submitFeedback({ message: '' }, { fetchFn: fake });
  assert.equal(res.ok, false);
  assert.equal(called, false, 'no network call for invalid input');
});

test('submitFeedback: non-200 + network errors are returned, not thrown', async () => {
  const bad: FetchLike = async () => ({ ok: false, status: 503 });
  const r1 = await submitFeedback({ message: 'hi' }, { fetchFn: bad });
  assert.equal(r1.ok, false);
  assert.equal(r1.status, 503);

  const boom: FetchLike = async () => {
    throw new Error('offline');
  };
  const r2 = await submitFeedback({ message: 'hi' }, { fetchFn: boom });
  assert.equal(r2.ok, false);
  assert.match(r2.error ?? '', /offline/);
});
