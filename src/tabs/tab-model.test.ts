import test from 'node:test';
import assert from 'node:assert/strict';
import { TabModel } from './tab-model';

test('create adds a tab and makes it active; ids are unique', () => {
  const m = new TabModel();
  const a = m.create('default');
  const b = m.create('default');
  assert.notEqual(a.id, b.id);
  assert.equal(m.activeId(), b.id);
  assert.equal(m.count(), 2);
});

test('tabs can belong to different containers', () => {
  const m = new TabModel();
  const a = m.create('default');
  const b = m.create('client-a');
  assert.equal(m.get(a.id)?.containerId, 'default');
  assert.equal(m.get(b.id)?.containerId, 'client-a');
});

test('closing the active tab activates the neighbour (next, else previous)', () => {
  const m = new TabModel();
  const a = m.create('default');
  const b = m.create('default');
  const c = m.create('default');
  m.activate(b.id);
  m.close(b.id); // active was b → next is c
  assert.equal(m.activeId(), c.id);
  m.close(c.id); // active was c (last) → previous is a
  assert.equal(m.activeId(), a.id);
});

test('closing a non-active tab keeps the active one', () => {
  const m = new TabModel();
  const a = m.create('default');
  const b = m.create('default');
  m.activate(b.id);
  m.close(a.id);
  assert.equal(m.activeId(), b.id);
});

test('closing the last tab leaves no active id (caller must create one)', () => {
  const m = new TabModel();
  const a = m.create('default');
  const r = m.close(a.id);
  assert.equal(r.newActiveId, null);
  assert.equal(m.count(), 0);
});

test('activate / setContainer reject unknown ids', () => {
  const m = new TabModel();
  m.create('default');
  assert.equal(m.activate('nope'), false);
  assert.equal(m.setContainer('nope', 'x'), false);
});

test('setContainer reassigns a tab', () => {
  const m = new TabModel();
  const a = m.create('default');
  assert.equal(m.setContainer(a.id, 'client-b'), true);
  assert.equal(m.get(a.id)?.containerId, 'client-b');
});
