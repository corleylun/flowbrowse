import test from 'node:test';
import assert from 'node:assert/strict';
import { TabModel } from './tab-model';

/**
 * Adversarial / edge-case coverage for TabModel — the pure tab bookkeeping that the
 * main process mirrors with real WebContentsViews. These probe the close/active rules,
 * monotonic-id non-reuse (invariant 4 / grant-bleed protection), container reassignment,
 * and the contract the main process relies on (activeId() drives the broker's tab key).
 */

// --- Monotonic ids: never reused, even across heavy churn (invariant 4 / 3c) ---

test('ids are strictly monotonic and never reused after close', () => {
  const m = new TabModel();
  const a = m.create('default'); // t1
  const b = m.create('default'); // t2
  assert.equal(a.id, 't1');
  assert.equal(b.id, 't2');
  m.close(a.id); // free t1's slot
  m.close(b.id); // model now empty
  const c = m.create('default'); // must NOT recycle t1/t2
  assert.equal(c.id, 't3');
  assert.notEqual(c.id, a.id);
  assert.notEqual(c.id, b.id);
});

test('seq keeps climbing across many create/close cycles (no wraparound/reuse)', () => {
  const m = new TabModel();
  const seen = new Set<string>();
  for (let i = 0; i < 50; i++) {
    const t = m.create('default');
    assert.ok(!seen.has(t.id), `id ${t.id} was reused`);
    seen.add(t.id);
    m.close(t.id); // churn: create then immediately close
  }
  assert.equal(seen.size, 50);
  // After 50 create+close cycles the next id reflects the cumulative seq, not the count.
  assert.equal(m.create('default').id, 't51');
});

// --- Close-active neighbour selection: middle / first / last (invariant 4) ---

test('closing active middle tab selects the NEXT tab', () => {
  const m = new TabModel();
  const a = m.create('default');
  const b = m.create('default');
  const c = m.create('default');
  m.activate(b.id); // active is the middle tab
  const r = m.close(b.id);
  assert.equal(r.newActiveId, c.id); // next (same index after splice)
  assert.equal(m.activeId(), c.id);
});

test('closing active FIRST tab selects the next (new first) tab', () => {
  const m = new TabModel();
  const a = m.create('default');
  const b = m.create('default');
  const c = m.create('default');
  m.activate(a.id);
  const r = m.close(a.id);
  assert.equal(r.newActiveId, b.id);
  assert.equal(m.activeId(), b.id);
});

test('closing active LAST tab falls back to the previous tab', () => {
  const m = new TabModel();
  const a = m.create('default');
  const b = m.create('default');
  const c = m.create('default');
  m.activate(c.id); // active is the last tab
  const r = m.close(c.id);
  assert.equal(r.newActiveId, b.id); // no next → previous (idx-1)
  assert.equal(m.activeId(), b.id);
});

// --- Close non-active tabs never disturbs the active id or its routing ---

test('closing a non-active tab BEFORE the active one keeps active stable', () => {
  const m = new TabModel();
  const a = m.create('default');
  const b = m.create('default');
  const c = m.create('default');
  m.activate(c.id);
  m.close(a.id); // remove a tab positioned before the active one
  assert.equal(m.activeId(), c.id);
  assert.equal(m.count(), 2);
  assert.ok(m.get(c.id), 'active tab still present');
});

test('closing a non-active tab AFTER the active one keeps active stable', () => {
  const m = new TabModel();
  const a = m.create('default');
  const b = m.create('default');
  const c = m.create('default');
  m.activate(a.id);
  m.close(c.id);
  assert.equal(m.activeId(), a.id);
});

// --- Unknown / stale id handling: must be inert, never corrupt state ---

test('closing an unknown id is a no-op and returns the current active id', () => {
  const m = new TabModel();
  const a = m.create('default');
  const b = m.create('default'); // active = b
  const r = m.close('t999');
  assert.equal(r.newActiveId, b.id);
  assert.equal(m.count(), 2);
  assert.equal(m.activeId(), b.id);
});

test('double-close of the same id does not remove a second (wrong) tab', () => {
  const m = new TabModel();
  const a = m.create('default');
  const b = m.create('default');
  const c = m.create('default');
  m.activate(b.id);
  m.close(b.id); // removes b, active → c
  const before = m.list().map((t) => t.id);
  const r = m.close(b.id); // b already gone: must be a no-op
  assert.deepEqual(
    m.list().map((t) => t.id),
    before,
    'stale second close must not drop another tab',
  );
  assert.equal(r.newActiveId, m.activeId());
  assert.equal(m.activeId(), c.id);
});

test('closing the last tab on an empty model returns null (idempotent empty)', () => {
  const m = new TabModel();
  const a = m.create('default');
  assert.equal(m.close(a.id).newActiveId, null);
  // A second close on the now-empty model must stay null, not throw or go negative.
  assert.equal(m.close(a.id).newActiveId, null);
  assert.equal(m.count(), 0);
  assert.equal(m.activeId(), '');
  assert.equal(m.active(), null);
});

// --- active() / activeId() coherence: the broker's tab key source of truth ---

test('active() and activeId() agree, and point at a real listed tab', () => {
  const m = new TabModel();
  m.create('default');
  const b = m.create('default');
  assert.equal(m.active()?.id, m.activeId());
  assert.equal(m.activeId(), b.id);
  assert.ok(
    m.list().some((t) => t.id === m.activeId()),
    'activeId must reference a tab that exists in the list',
  );
});

test('after closing the last tab, activeId() is empty and active() is null (no dangling key)', () => {
  const m = new TabModel();
  const a = m.create('default');
  m.close(a.id);
  // The broker would key on this; it must be a falsy/unseen id (→ Blocked by default),
  // never the id of the just-closed tab.
  assert.equal(m.activeId(), '');
  assert.notEqual(m.activeId(), a.id);
});

// --- Container reassignment: identity & active preserved, isolation knob is per-tab ---

test('setContainer changes only the target tab and preserves id + active state', () => {
  const m = new TabModel();
  const a = m.create('default');
  const b = m.create('default');
  m.activate(a.id);
  assert.equal(m.setContainer(b.id, 'client-x'), true);
  assert.equal(m.get(b.id)?.containerId, 'client-x');
  assert.equal(m.get(a.id)?.containerId, 'default', 'sibling container untouched');
  assert.equal(m.activeId(), a.id, 'reassigning a background tab does not steal focus');
  assert.equal(m.count(), 2, 'reassignment does not add/remove tabs');
});

test('setContainer can re-target the active tab without changing which tab is active', () => {
  const m = new TabModel();
  const a = m.create('default'); // active
  assert.equal(m.setContainer(a.id, 'client-y'), true);
  assert.equal(m.activeId(), a.id);
  assert.equal(m.get(a.id)?.containerId, 'client-y');
});

test('setContainer to the same container is a harmless no-op success', () => {
  const m = new TabModel();
  const a = m.create('default');
  assert.equal(m.setContainer(a.id, 'default'), true);
  assert.equal(m.get(a.id)?.containerId, 'default');
});

test('activate on a closed id returns false and leaves active unchanged', () => {
  const m = new TabModel();
  const a = m.create('default');
  const b = m.create('default'); // active = b
  m.close(a.id);
  assert.equal(m.activate(a.id), false, 'cannot activate a closed tab');
  assert.equal(m.activeId(), b.id);
});

// --- list() is a defensive copy: callers cannot mutate internal state ---

test('list() returns a copy; mutating it does not corrupt the model', () => {
  const m = new TabModel();
  m.create('default');
  m.create('default');
  const snapshot = m.list();
  snapshot.pop();
  snapshot.push({ id: 'tHACK', containerId: 'evil' });
  assert.equal(m.count(), 2, 'external mutation of list() must not change the model');
  assert.ok(!m.get('tHACK'), 'injected entry must not appear in the model');
});

// --- get() on unknown/closed id is null (resolver feeds off this indirectly) ---

test('get() returns null for unknown and for closed ids', () => {
  const m = new TabModel();
  const a = m.create('default');
  assert.ok(m.get(a.id));
  m.close(a.id);
  assert.equal(m.get(a.id), null, 'closed tab no longer resolvable');
  assert.equal(m.get('tNope'), null);
});
