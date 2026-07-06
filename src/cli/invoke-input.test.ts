import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveInvokeInput, extractTabFlag, InvokeInputIO } from './invoke-input';

const noIO: InvokeInputIO = {
  readFile: () => {
    throw new Error('readFile should not be called');
  },
  readStdin: async () => {
    throw new Error('readStdin should not be called');
  },
};

test('no arg → {}', async () => {
  assert.deepEqual(await resolveInvokeInput([], noIO), {});
});

test('JSON literal arg is parsed', async () => {
  assert.deepEqual(await resolveInvokeInput(['{"a":1}'], noIO), { a: 1 });
});

test('"-" reads + parses stdin', async () => {
  const io: InvokeInputIO = { ...noIO, readStdin: async () => '{"script":"document.title"}' };
  assert.deepEqual(await resolveInvokeInput(['-'], io), { script: 'document.title' });
});

test('empty stdin → {}', async () => {
  const io: InvokeInputIO = { ...noIO, readStdin: async () => '  \n' };
  assert.deepEqual(await resolveInvokeInput(['-'], io), {});
});

test('--input-file / -f / --input-file= read from the path', async () => {
  const io: InvokeInputIO = { ...noIO, readFile: (p) => (p === 'big.json' ? '{"x":true}' : 'nope') };
  assert.deepEqual(await resolveInvokeInput(['--input-file', 'big.json'], io), { x: true });
  assert.deepEqual(await resolveInvokeInput(['-f', 'big.json'], io), { x: true });
  assert.deepEqual(await resolveInvokeInput(['--input-file=big.json'], io), { x: true });
});

test('--input-file without a path throws', async () => {
  await assert.rejects(() => resolveInvokeInput(['--input-file'], noIO), /requires a path/);
});

test('invalid JSON throws a clear error (no network call)', async () => {
  await assert.rejects(() => resolveInvokeInput(['{bad'], noIO), /valid JSON/);
  const io: InvokeInputIO = { ...noIO, readStdin: async () => 'not json' };
  await assert.rejects(() => resolveInvokeInput(['-'], io), /valid JSON/);
});

test('extractTabFlag: no --tab -> undefined, args unchanged', () => {
  assert.deepEqual(extractTabFlag(['{"a":1}']), { tab: undefined, rest: ['{"a":1}'] });
});

test('extractTabFlag: --tab <id> is pulled out from anywhere in the args', () => {
  assert.deepEqual(extractTabFlag(['--tab', 't2', '{"a":1}']), { tab: 't2', rest: ['{"a":1}'] });
  assert.deepEqual(extractTabFlag(['{"a":1}', '--tab', 't2']), { tab: 't2', rest: ['{"a":1}'] });
});

test('extractTabFlag: --tab=<id> form is also supported', () => {
  assert.deepEqual(extractTabFlag(['--tab=t2', '{"a":1}']), { tab: 't2', rest: ['{"a":1}'] });
});

test('extractTabFlag: leaves stdin/-input-file conventions untouched', () => {
  assert.deepEqual(extractTabFlag(['-', '--tab', 't3']), { tab: 't3', rest: ['-'] });
  assert.deepEqual(extractTabFlag(['--input-file', 'big.json', '--tab', 't3']), {
    tab: 't3',
    rest: ['--input-file', 'big.json'],
  });
});

test('extractTabFlag: --tab without a value throws', () => {
  assert.throws(() => extractTabFlag(['--tab']), /--tab requires a value/);
});
