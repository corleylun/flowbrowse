import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ContainerManager, DEFAULT_CONTAINER, containerSlug } from './containers';

function tmpFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'safecobrowser-containers-'));
  return path.join(dir, 'containers.json');
}

test('the Default container always exists', () => {
  const file = tmpFile();
  try {
    const m = new ContainerManager(file);
    assert.ok(m.has(DEFAULT_CONTAINER));
    assert.equal(m.get(DEFAULT_CONTAINER)?.name, 'Default');
  } finally {
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  }
});

test('partitions isolate containers (default keeps the base partition)', () => {
  const file = tmpFile();
  try {
    const m = new ContainerManager(file);
    assert.equal(m.partitionFor(DEFAULT_CONTAINER), 'persist:safecobrowser');
    const a = m.create('Client A');
    assert.equal(m.partitionFor(a.id), `persist:safecobrowser-${a.id}`);
    const b = m.create('Client B');
    assert.notEqual(m.partitionFor(a.id), m.partitionFor(b.id)); // fully separate
  } finally {
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  }
});

test('create slugs the name and de-duplicates ids', () => {
  const file = tmpFile();
  try {
    const m = new ContainerManager(file);
    const a = m.create('My Client!');
    assert.equal(a.id, 'my-client');
    const b = m.create('My Client!'); // same name → unique id
    assert.equal(b.id, 'my-client-2');
  } finally {
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  }
});

test('containers persist across reloads', () => {
  const file = tmpFile();
  try {
    new ContainerManager(file).create('Work');
    const m2 = new ContainerManager(file);
    assert.ok(m2.has('work'));
    assert.equal(m2.list().length, 2); // default + work
  } finally {
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  }
});

test('rename changes the display name but keeps id/partition (session preserved)', () => {
  const file = tmpFile();
  try {
    const m = new ContainerManager(file);
    const a = m.create('Work');
    const before = m.partitionFor(a.id);
    const renamed = m.rename(a.id, 'Day Job');
    assert.equal(renamed?.name, 'Day Job');
    assert.equal(renamed?.id, a.id); // id unchanged
    assert.equal(m.partitionFor(a.id), before); // partition unchanged → cookies preserved
    assert.equal(new ContainerManager(file).get(a.id)?.name, 'Day Job'); // persisted
  } finally {
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  }
});

test('rename is rejected for Default, unknown ids, and empty names', () => {
  const file = tmpFile();
  try {
    const m = new ContainerManager(file);
    const a = m.create('Work');
    assert.equal(m.rename(DEFAULT_CONTAINER, 'Nope'), null); // reserved
    assert.equal(m.rename('does-not-exist', 'X'), null);
    assert.equal(m.rename(a.id, '   '), null); // empty after trim
    assert.equal(m.get(a.id)?.name, 'Work'); // unchanged
  } finally {
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  }
});

test('remove deletes a container but never Default', () => {
  const file = tmpFile();
  try {
    const m = new ContainerManager(file);
    const a = m.create('Throwaway');
    assert.equal(m.remove(a.id), true);
    assert.equal(m.has(a.id), false);
    assert.equal(new ContainerManager(file).has(a.id), false); // persisted
    assert.equal(m.remove(DEFAULT_CONTAINER), false); // reserved
    assert.equal(m.remove('does-not-exist'), false);
    assert.ok(m.has(DEFAULT_CONTAINER));
  } finally {
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  }
});

test('containerSlug handles junk', () => {
  assert.equal(containerSlug('***'), 'container');
  assert.equal(containerSlug('  A  B  '), 'a-b');
});
