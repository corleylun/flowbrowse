import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { RecipeStore, slug, RecipeStep } from './recipes';
import { RecordedAction } from './actions';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'safecobrowser-recipes-'));
}

const D = 'x.com';
const actions: RecordedAction[] = [
  { type: 'click', selector: '#login', label: 'Log in', ts: 1 },
  { type: 'fill', selector: '#email', label: 'Email', value: 'a@b.c', masked: false, ts: 2 },
  { type: 'fill', selector: '#pw', label: 'Password', value: null, masked: true, ts: 3 },
];
const steps = (): RecipeStep[] => actions.map((action) => ({ action }));

test('slug sanitizes names to safe filenames', () => {
  assert.equal(slug('My Login Flow!'), 'my-login-flow');
  assert.equal(slug('  weird///name  '), 'weird-name');
  assert.equal(slug('***'), 'recipe');
});

test('save / get / list / delete round-trip (domain-keyed)', () => {
  const dir = tmpDir();
  try {
    const store = new RecipeStore(dir);
    assert.deepEqual(store.list(D), []);

    store.save(D, { name: 'Login Flow', steps: steps() });
    const got = store.get(D, 'Login Flow');
    assert.ok(got);
    assert.equal(got?.name, 'Login Flow');
    assert.equal(got?.domain, D);
    assert.equal(got?.steps.length, 3);
    // The masked fill persisted without a value.
    const masked = got?.steps.find((s) => s.action.type === 'fill' && s.action.masked);
    assert.equal((masked?.action as { value: unknown }).value, null);

    const list = store.list(D);
    assert.equal(list.length, 1);
    assert.equal(list[0].steps, 3);

    assert.equal(store.delete(D, 'Login Flow'), true);
    assert.equal(store.get(D, 'Login Flow'), null);
    assert.deepEqual(store.list(D), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('recipes are isolated per domain (memory follows the domain)', () => {
  const dir = tmpDir();
  try {
    const store = new RecipeStore(dir);
    store.save('x.com', { name: 'A', steps: steps() });
    store.save('example.com', { name: 'B', steps: steps() });
    assert.deepEqual(
      store.list('x.com').map((r) => r.name),
      ['A'],
    );
    assert.deepEqual(
      store.list('example.com').map((r) => r.name),
      ['B'],
    );
    assert.equal(store.get('example.com', 'A'), null); // not visible on the other domain
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('listAll returns recipes across every domain (newest first)', () => {
  const dir = tmpDir();
  try {
    const store = new RecipeStore(dir);
    store.save('x.com', { name: 'A', steps: steps() });
    store.save('example.com', { name: 'B', steps: steps() });
    store.save('example.com', { name: 'C', steps: steps() });
    const all = store.listAll();
    assert.equal(all.length, 3);
    assert.deepEqual(new Set(all.map((r) => `${r.domain}/${r.name}`)), new Set(['x.com/A', 'example.com/B', 'example.com/C']));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('per-step name + description round-trip', () => {
  const dir = tmpDir();
  try {
    const store = new RecipeStore(dir);
    const annotated: RecipeStep[] = [
      { action: actions[0], name: 'Open login', description: 'Click the log-in button' },
      { action: actions[1], description: 'Type the email' },
    ];
    store.save(D, { name: 'Annotated', description: 'How to log in', steps: annotated });
    const got = store.get(D, 'Annotated');
    assert.equal(got?.description, 'How to log in');
    assert.equal(got?.steps[0].name, 'Open login');
    assert.equal(got?.steps[0].description, 'Click the log-in button');
    assert.equal(got?.steps[1].name, undefined);
    assert.equal(got?.steps[1].description, 'Type the email');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('update edits annotations and renames (moves the file, preserves createdAt)', () => {
  const dir = tmpDir();
  try {
    const store = new RecipeStore(dir);
    const orig = store.save(D, { name: 'Old Name', steps: steps() });
    const updated = store.update(D, 'Old Name', {
      name: 'New Name',
      description: 'updated',
      steps: steps().map((s, i) => (i === 0 ? { ...s, name: 'first' } : s)),
    });
    assert.equal(updated?.name, 'New Name');
    assert.equal(updated?.createdAt, orig.createdAt); // createdAt preserved across rename
    assert.equal(store.get(D, 'Old Name'), null); // old file removed
    const got = store.get(D, 'New Name');
    assert.equal(got?.description, 'updated');
    assert.equal(got?.steps[0].name, 'first');
    assert.equal(store.list(D).length, 1); // not duplicated
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('update returns null for a missing recipe', () => {
  const dir = tmpDir();
  try {
    assert.equal(new RecipeStore(dir).update(D, 'nope', { name: 'x', steps: [] }), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('back-compat: reads the legacy flat { name, actions } shape', () => {
  const dir = tmpDir();
  try {
    const store = new RecipeStore(dir);
    const domainDir = path.join(dir, 'x.com');
    fs.mkdirSync(domainDir, { recursive: true });
    fs.writeFileSync(path.join(domainDir, 'legacy.json'), JSON.stringify({ name: 'Legacy', createdAt: 5, actions }));
    const got = store.get('x.com', 'Legacy');
    assert.equal(got?.name, 'Legacy');
    assert.equal(got?.steps.length, 3);
    assert.equal(got?.domain, 'x.com'); // domain inferred from the folder
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('get returns null for unknown recipe', () => {
  const dir = tmpDir();
  try {
    assert.equal(new RecipeStore(dir).get(D, 'nope'), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
