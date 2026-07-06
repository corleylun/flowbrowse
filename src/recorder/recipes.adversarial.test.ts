import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { RecipeStore, slug, RecipeStep } from './recipes';
import { domainSlug } from './domain';
import { RecordedAction } from './actions';

/**
 * Invariant #6: a malicious recipe NAME or DOMAIN must not escape the recipes directory.
 * Recipes live at <dir>/<domainSlug(domain)>/<slug(name)>.json — both segments are sanitized
 * so path separators, '..', drive letters, and NUL all dissolve. No traversal, no NUL injection.
 */

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'safecobrowser-recipes-adv-'));
}

const TRAVERSAL_NAMES = [
  '../../evil',
  '../../../etc/passwd',
  '..\\..\\evil',
  '/etc/passwd',
  'C:\\Windows\\system32\\config',
  '....//....//evil',
  'foo/../../bar',
  '..',
  '.',
  './../../x',
  '~/.ssh/authorized_keys',
  'a/b/c/d',
  'x y', // NUL injection attempt
  '   ../  ',
];

const oneStep: RecipeStep[] = [{ action: { type: 'navigate', url: 'https://x', ts: 1 } as RecordedAction }];

test('invariant #6: slug never yields a path separator, dot-segment, or NUL', () => {
  for (const name of TRAVERSAL_NAMES) {
    const s = slug(name);
    assert.doesNotMatch(s, /[/\\]/, `slug(${JSON.stringify(name)}) contains a separator: ${s}`);
    assert.doesNotMatch(s, /\.\./, `slug(${JSON.stringify(name)}) contains ..: ${s}`);
    assert.doesNotMatch(s, / /, `slug(${JSON.stringify(name)}) contains NUL`);
    assert.ok(s.length > 0);
  }
});

test('invariant #6: domainSlug never yields a separator or dot-segment', () => {
  for (const name of [...TRAVERSAL_NAMES, '../../evil.com', 'a/../b']) {
    const s = domainSlug(name);
    assert.doesNotMatch(s, /[/\\]/, `domainSlug(${JSON.stringify(name)}) contains a separator: ${s}`);
    assert.doesNotMatch(s, /\.\./, `domainSlug(${JSON.stringify(name)}) contains ..: ${s}`);
    assert.ok(s.length > 0);
  }
});

test('invariant #6: a saved recipe with a traversal name stays inside the domain dir', () => {
  const dir = tmpDir();
  try {
    const store = new RecipeStore(dir);
    for (const name of TRAVERSAL_NAMES) {
      store.save('x.com', { name, steps: oneStep });
    }
    const realDir = fs.realpathSync(dir);
    const domainDir = path.join(realDir, domainSlug('x.com'));
    // Recipe files are direct children of the domain dir (no escape, no nested subdirs).
    for (const e of fs.readdirSync(domainDir, { withFileTypes: true })) {
      assert.ok(e.isFile(), `unexpected non-file entry: ${e.name}`);
      assert.doesNotMatch(e.name, /[/\\]/);
      assert.ok(path.join(domainDir, e.name).startsWith(domainDir + path.sep));
    }
    // Nothing leaked above the recipes dir.
    const parent = path.dirname(realDir);
    const leaked = fs.readdirSync(parent).filter((f) => f === 'evil.json' || f === 'passwd.json' || f === 'bar.json');
    assert.deepEqual(leaked, [], `files leaked into parent dir: ${leaked.join(', ')}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('invariant #6: a traversal DOMAIN stays inside the recipes dir', () => {
  const dir = tmpDir();
  try {
    const store = new RecipeStore(dir);
    store.save('../../evil', { name: 'r', steps: oneStep });
    const realDir = fs.realpathSync(dir);
    // Only one subdir, and it is a direct child of the recipes dir.
    for (const e of fs.readdirSync(realDir, { withFileTypes: true })) {
      assert.ok(e.isDirectory());
      assert.doesNotMatch(e.name, /[/\\]/);
      assert.doesNotMatch(e.name, /\.\./);
    }
    const parent = path.dirname(realDir);
    assert.equal(
      fs.readdirSync(parent).filter((f) => f === 'evil').length,
      0,
      'domain dir leaked into parent',
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('invariant #6: distinct traversal names can COLLIDE to one slug (known caveat, not a leak)', () => {
  assert.equal(slug('../../evil'), 'evil');
  assert.equal(slug('....//....//evil'), 'evil');
});

test('robustness: a very long name is truncated by slug (stays under NAME_MAX)', () => {
  const longName = 'a'.repeat(300);
  assert.equal(slug(longName).length, 100);
});

test('get/delete with a traversal name resolve to the same in-dir slug (cannot read arbitrary files)', () => {
  const dir = tmpDir();
  try {
    const store = new RecipeStore(dir);
    store.save('x.com', { name: 'evil', steps: [{ action: { type: 'click', selector: '#a', label: 'A', ts: 1 } }] });
    const viaTraversal = store.get('x.com', '../../evil');
    assert.ok(viaTraversal);
    assert.equal(viaTraversal?.steps.length, 1);
    assert.equal(store.get('x.com', '/etc/passwd'), null); // no arbitrary read
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('get rejects a recipe whose JSON is malformed or has wrong shape', () => {
  const dir = tmpDir();
  try {
    const store = new RecipeStore(dir);
    const domainDir = path.join(dir, domainSlug('x.com'));
    fs.mkdirSync(domainDir, { recursive: true });
    fs.writeFileSync(path.join(domainDir, 'broken.json'), '{ not json');
    fs.writeFileSync(path.join(domainDir, 'wrongshape.json'), JSON.stringify({ name: 'x' })); // no steps/actions
    assert.equal(store.get('x.com', 'broken'), null);
    assert.equal(store.get('x.com', 'wrongshape'), null);
    assert.doesNotThrow(() => store.list('x.com')); // skips the broken one
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
