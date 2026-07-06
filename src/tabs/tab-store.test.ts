import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { saveTabs, loadTabs } from './tab-store';

function tmpFile(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'safecobrowser-tabstore-')), 'tabs.json');
}

test('save/load round-trip', () => {
  const f = tmpFile();
  try {
    saveTabs(f, {
      activeIndex: 1,
      tabs: [
        { containerId: 'default', url: 'https://a.test' },
        { containerId: 'client-a', url: 'https://b.test' },
      ],
    });
    const loaded = loadTabs(f);
    assert.equal(loaded?.tabs.length, 2);
    assert.equal(loaded?.activeIndex, 1);
    assert.equal(loaded?.tabs[1].containerId, 'client-a');
    assert.equal(loaded?.tabs[1].url, 'https://b.test');
  } finally {
    fs.rmSync(path.dirname(f), { recursive: true, force: true });
  }
});

test('missing file → null', () => {
  assert.equal(loadTabs('/no/such/safecobrowser-tabs.json'), null);
});

test('corrupt / empty / wrong-shape → null', () => {
  const f = tmpFile();
  try {
    fs.writeFileSync(f, '{ not json');
    assert.equal(loadTabs(f), null);
    fs.writeFileSync(f, JSON.stringify({ tabs: [] }));
    assert.equal(loadTabs(f), null);
    fs.writeFileSync(f, JSON.stringify({ tabs: 'nope' }));
    assert.equal(loadTabs(f), null);
  } finally {
    fs.rmSync(path.dirname(f), { recursive: true, force: true });
  }
});

test('malformed tab entries are filtered; activeIndex clamped', () => {
  const f = tmpFile();
  try {
    saveTabs(f, {
      activeIndex: 99, // out of range → clamped to 0
      tabs: [{ containerId: 'default', url: 'https://a.test' }],
    });
    // hand-inject a junk entry
    const obj = JSON.parse(fs.readFileSync(f, 'utf8'));
    obj.tabs.push({ containerId: 5 }); // missing/invalid
    fs.writeFileSync(f, JSON.stringify(obj));
    const loaded = loadTabs(f);
    assert.equal(loaded?.tabs.length, 1);
    assert.equal(loaded?.activeIndex, 0);
  } finally {
    fs.rmSync(path.dirname(f), { recursive: true, force: true });
  }
});
