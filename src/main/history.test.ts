import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { HistoryStore, scoreEntry, stripForMatch, recencyWeight, type HistoryEntry } from './history';

const DAY = 86_400_000;

function tmpFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scb-history-'));
  return path.join(dir, 'history.json');
}

// A fixed "now" so frecency is deterministic across runs.
const NOW = 1_000_000_000_000;
const clock = (): number => NOW;

test('stripForMatch: drops protocol and leading www', () => {
  assert.equal(stripForMatch('https://www.github.com/foo'), 'github.com/foo');
  assert.equal(stripForMatch('http://example.org'), 'example.org');
  assert.equal(stripForMatch('https://sub.example.org'), 'sub.example.org'); // only a leading www. is stripped
});

test('recencyWeight: recent beats old, monotonic across buckets', () => {
  assert.ok(recencyWeight(0) > recencyWeight(2 * DAY));
  assert.ok(recencyWeight(2 * DAY) > recencyWeight(10 * DAY));
  assert.ok(recencyWeight(10 * DAY) > recencyWeight(100 * DAY));
});

test('scoreEntry: host-prefix ranks above mid-URL ranks above title-only ranks above no-match', () => {
  const base: Omit<HistoryEntry, 'url' | 'title'> = { visitCount: 1, lastVisit: NOW };
  const hostPrefix = scoreEntry({ url: 'https://github.com', title: 'x', ...base }, 'git', NOW);
  const midUrl = scoreEntry({ url: 'https://example.com/git', title: 'x', ...base }, 'git', NOW);
  const titleOnly = scoreEntry({ url: 'https://example.com', title: 'my git repo', ...base }, 'git', NOW);
  const noMatch = scoreEntry({ url: 'https://example.com', title: 'nothing', ...base }, 'git', NOW);
  assert.ok(hostPrefix > midUrl, 'host-prefix > mid-URL');
  assert.ok(midUrl > titleOnly, 'mid-URL > title-only');
  assert.equal(noMatch, -1, 'no match returns -1');
});

test('scoreEntry: within a tier, more/recenter visits win (frecency tie-break)', () => {
  const many = scoreEntry({ url: 'https://github.com', title: '', visitCount: 20, lastVisit: NOW }, 'git', NOW);
  const few = scoreEntry({ url: 'https://github.com', title: '', visitCount: 1, lastVisit: NOW }, 'git', NOW);
  assert.ok(many > few);
  const recent = scoreEntry({ url: 'https://github.com', title: '', visitCount: 5, lastVisit: NOW }, 'git', NOW);
  const stale = scoreEntry({ url: 'https://github.com', title: '', visitCount: 5, lastVisit: NOW - 100 * DAY }, 'git', NOW);
  assert.ok(recent > stale);
});

test('record + suggest: matches by host prefix, best-frecency first', () => {
  const store = new HistoryStore(tmpFile(), clock);
  store.record('https://github.com/explore', 'Explore');
  store.record('https://gitlab.com', 'GitLab');
  store.record('https://github.com/explore', 'Explore'); // second visit → higher count
  const out = store.suggest('git');
  assert.equal(out.length, 2);
  assert.equal(out[0].url, 'https://github.com/explore', 'the twice-visited page ranks first');
});

test('suggest: empty / non-string / whitespace query returns nothing', () => {
  const store = new HistoryStore(tmpFile(), clock);
  store.record('https://github.com', 'GitHub');
  assert.deepEqual(store.suggest(''), []);
  assert.deepEqual(store.suggest('   '), []);
  assert.deepEqual(store.suggest(undefined), []);
  assert.deepEqual(store.suggest(42), []);
});

test('suggest: honors the limit', () => {
  const store = new HistoryStore(tmpFile(), clock);
  for (let i = 0; i < 10; i++) store.record(`https://example.com/page${i}`, `Page ${i}`);
  assert.equal(store.suggest('example', 3).length, 3);
});

test('record: ignores non-http(s) and about:blank; never records them', () => {
  const store = new HistoryStore(tmpFile(), clock);
  store.record('about:blank', 'blank');
  store.record('data:text/html,hi', 'data');
  store.record('file:///etc/passwd', 'file');
  store.record(null, 'null');
  assert.deepEqual(store.suggest('blank'), []);
  assert.deepEqual(store.suggest('passwd'), []);
});

test('touchTitle: updates a title without bumping the visit count', () => {
  const store = new HistoryStore(tmpFile(), clock);
  store.record('https://example.com', ''); // navigate before the title arrives
  store.touchTitle('https://example.com', 'Now Titled');
  const byTitle = store.suggest('now titled');
  assert.equal(byTitle.length, 1);
  assert.equal(byTitle[0].title, 'Now Titled');
  // touchTitle on an unknown URL is a no-op (never creates an entry)
  store.touchTitle('https://never-seen.com', 'Ghost');
  assert.deepEqual(store.suggest('never-seen'), []);
});

test('count + clear: clear empties the store and persists the wipe', () => {
  const file = tmpFile();
  const a = new HistoryStore(file, clock);
  a.record('https://github.com', 'GitHub');
  a.record('https://example.com', 'Example');
  assert.equal(a.count(), 2);
  a.clear();
  assert.equal(a.count(), 0);
  assert.deepEqual(a.suggest('git'), []);
  // the wipe is durable — a reopened store sees nothing
  const b = new HistoryStore(file, clock);
  assert.equal(b.count(), 0);
});

test('persistence: a reopened store reads its entries back from disk', () => {
  const file = tmpFile();
  const a = new HistoryStore(file, clock);
  a.record('https://github.com', 'GitHub');
  const b = new HistoryStore(file, clock);
  const out = b.suggest('git');
  assert.equal(out.length, 1);
  assert.equal(out[0].url, 'https://github.com');
});
