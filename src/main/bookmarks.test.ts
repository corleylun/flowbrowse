import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { BookmarkStore, isBookmarkableUrl } from './bookmarks';

const NOW = 1_000_000_000_000;
function tmpFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scb-bm-'));
  return path.join(dir, 'bookmarks.json');
}

test('isBookmarkableUrl accepts only http(s), bounded length', () => {
  assert.equal(isBookmarkableUrl('https://example.com'), true);
  assert.equal(isBookmarkableUrl('http://example.com'), true);
  assert.equal(isBookmarkableUrl('about:blank'), false);
  assert.equal(isBookmarkableUrl('data:text/html,x'), false);
  assert.equal(isBookmarkableUrl(''), false);
  assert.equal(isBookmarkableUrl(123), false);
  assert.equal(isBookmarkableUrl('https://x.com/' + 'a'.repeat(3000)), false);
});

test('add + has, deduped by URL', () => {
  const s = new BookmarkStore(tmpFile(), () => NOW);
  assert.equal(s.has('https://a.com'), false);
  assert.equal(s.add('https://a.com', 'A'), true);
  assert.equal(s.has('https://a.com'), true);
  assert.equal(s.list().length, 1);
  // Re-adding the same URL is a no-op (still one entry) but can refresh the title.
  assert.equal(s.add('https://a.com', 'A better title'), true);
  assert.equal(s.list().length, 1);
  assert.equal(s.list()[0].title, 'A better title');
  // A non-http URL is not bookmarkable.
  assert.equal(s.add('about:blank', 'blank'), false);
  assert.equal(s.list().length, 1);
});

test('toggle adds then removes, returning the new state', () => {
  const s = new BookmarkStore(tmpFile(), () => NOW);
  assert.equal(s.toggle('https://t.com', 'T'), true); // now bookmarked
  assert.equal(s.has('https://t.com'), true);
  assert.equal(s.toggle('https://t.com', 'T'), false); // now removed
  assert.equal(s.has('https://t.com'), false);
});

test('remove + rename by URL', () => {
  const s = new BookmarkStore(tmpFile(), () => NOW);
  s.add('https://r.com', 'R');
  assert.equal(s.rename('https://r.com', 'Renamed'), true);
  assert.equal(s.list()[0].title, 'Renamed');
  assert.equal(s.rename('https://missing.com', 'x'), false);
  assert.equal(s.remove('https://r.com'), true);
  assert.equal(s.remove('https://r.com'), false); // already gone
  assert.equal(s.list().length, 0);
});

test('list is newest-first', () => {
  let t = NOW;
  const s = new BookmarkStore(tmpFile(), () => t);
  t = NOW + 1;
  s.add('https://first.com', 'first');
  t = NOW + 2;
  s.add('https://second.com', 'second');
  t = NOW + 3;
  s.add('https://third.com', 'third');
  assert.deepEqual(
    s.list().map((b) => b.url),
    ['https://third.com', 'https://second.com', 'https://first.com'],
  );
});

test('persists across reload, file mode 0o600', () => {
  const file = tmpFile();
  const a = new BookmarkStore(file, () => NOW);
  a.add('https://keep.com', 'Keep');
  const mode = fs.statSync(file).mode & 0o777;
  assert.equal(mode, 0o600);
  const b = new BookmarkStore(file, () => NOW);
  assert.equal(b.has('https://keep.com'), true);
  assert.equal(b.list()[0].title, 'Keep');
});
