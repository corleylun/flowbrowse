import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveTabTarget } from './tab-target';

const knownTabs = new Set(['main', 't2']);
const base = {
  active: () => 'main',
  isKnownTab: (id: string) => knownTabs.has(id),
  allowTargeting: () => true,
};

test('tab-target: absent tab -> active tab (zero-regression default)', () => {
  const r = resolveTabTarget({ ...base, requested: undefined });
  assert.deepEqual(r, { ok: true, tabId: 'main' });
});

test('tab-target: known non-active tab -> that tab', () => {
  const r = resolveTabTarget({ ...base, requested: 't2' });
  assert.deepEqual(r, { ok: true, tabId: 't2' });
});

test('tab-target: explicit target equal to the active tab still resolves fine', () => {
  const r = resolveTabTarget({ ...base, requested: 'main' });
  assert.deepEqual(r, { ok: true, tabId: 'main' });
});

test('tab-target: non-string tab -> invalid_input, no fallback', () => {
  const r = resolveTabTarget({ ...base, requested: 42 });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, 'invalid_input');
});

test('tab-target: empty-string tab -> invalid_input', () => {
  const r = resolveTabTarget({ ...base, requested: '   ' });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, 'invalid_input');
});

test('tab-target: unknown tab id -> invalid_input, never silently falls back to active', () => {
  const r = resolveTabTarget({ ...base, requested: 'ghost' });
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.reason, 'invalid_input');
    assert.match(r.message, /unknown tab/);
  }
});

test('tab-target: targeting disabled + different tab -> permission_denied', () => {
  const r = resolveTabTarget({ ...base, allowTargeting: () => false, requested: 't2' });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, 'permission_denied');
});

test('tab-target: targeting disabled but SAME as active tab -> still allowed', () => {
  const r = resolveTabTarget({ ...base, allowTargeting: () => false, requested: 'main' });
  assert.deepEqual(r, { ok: true, tabId: 'main' });
});

test('tab-target: targeting disabled -> known and unknown ids are INDISTINGUISHABLE (no oracle)', () => {
  // With "Allow agent tab control" off, the error must not reveal whether an id exists —
  // otherwise probing t1, t2, t3… enumerates the very tabs the setting is meant to hide.
  const known = resolveTabTarget({ ...base, allowTargeting: () => false, requested: 't2' });
  const unknown = resolveTabTarget({ ...base, allowTargeting: () => false, requested: 'ghost' });
  assert.deepEqual(known, unknown, 'identical result for known vs unknown id');
  assert.equal(known.ok, false);
  if (!known.ok) assert.equal(known.reason, 'permission_denied');
});
