import test from 'node:test';
import assert from 'node:assert/strict';
import { originOf, crossesGrantedOrigin } from './nav';

/**
 * Phase 6 ADVERSARIAL review (Aidan) — cross-origin invalidation edge cases.
 *
 * The intent: a navigation LEAVING the granted origin must revoke AI (fail to Blocked),
 * while same-origin nav (path/query/hash/SPA) keeps the grant. These probe the schemes
 * Chromium actually emits on `did-navigate` (about:blank, data:, file:, blob:) and the
 * "granted before the page had a URL" hole.
 */

test('special schemes parse to origin "null" (string), not "" — so they DO trigger a cross', () => {
  // Node's URL gives the opaque-origin string "null" for these; only unparseable URLs give "".
  assert.equal(originOf('about:blank'), 'null');
  assert.equal(originOf('data:text/html,<h1>x'), 'null');
  assert.equal(originOf('javascript:alert(1)'), 'null');
  assert.equal(originOf('file:///etc/passwd'), 'null');
  assert.equal(originOf('chrome://settings'), 'null');
  // Truly unparseable → '' (the "nothing granted" sentinel).
  assert.equal(originOf('not a url'), '');
  assert.equal(originOf(''), '');
});

test('FAIL-SAFE: navigating from a real origin to about:blank / data: / file: crosses → revokes', () => {
  const granted = 'https://example.com';
  assert.equal(crossesGrantedOrigin(granted, 'about:blank'), true);
  assert.equal(crossesGrantedOrigin(granted, 'data:text/html,<h1>x'), true);
  assert.equal(crossesGrantedOrigin(granted, 'file:///etc/passwd'), true);
  assert.equal(crossesGrantedOrigin(granted, 'javascript:fetch("/x")'), true);
});

test('blob: inherits its parent origin — same-origin blob keeps the grant, cross-origin blob crosses', () => {
  assert.equal(originOf('blob:https://example.com/abc-123'), 'https://example.com');
  assert.equal(crossesGrantedOrigin('https://example.com', 'blob:https://example.com/abc-123'), false);
  assert.equal(crossesGrantedOrigin('https://example.com', 'blob:https://evil.com/abc-123'), true);
});

test('opaque-origin → opaque-origin nav does NOT cross (data: → data: both "null")', () => {
  // If a grant were ever pinned while the page was on an opaque-origin URL, two different
  // opaque pages compare equal ("null"==="null") and would NOT revoke. Surfaced for review:
  // grants should never be pinned on opaque origins in the first place (see main.ts note).
  const granted = originOf('data:text/html,<h1>a'); // "null"
  assert.equal(granted, 'null');
  assert.equal(crossesGrantedOrigin(granted, 'data:text/html,<h1>DIFFERENT'), false);
  assert.equal(crossesGrantedOrigin(granted, 'about:blank'), false); // both opaque "null"
});

test('EDGE: grant pinned before the page has a URL (grantedOrigin === "") never invalidates', () => {
  // main.ts: grantedOrigin = originOf(pageView.getURL()). Before first commit getURL() is "",
  // so grantedOrigin becomes "" and crossesGrantedOrigin short-circuits to false FOREVER for
  // that grant — a subsequent nav to ANY site will NOT revoke. Documents the hole.
  const grantedBeforeUrl = originOf(''); // ''
  assert.equal(grantedBeforeUrl, '');
  assert.equal(crossesGrantedOrigin(grantedBeforeUrl, 'https://bank.com'), false);
  assert.equal(crossesGrantedOrigin(grantedBeforeUrl, 'https://evil.com'), false);
});

test('port and scheme upgrades are treated as cross-origin (no implicit trust)', () => {
  assert.equal(crossesGrantedOrigin('https://example.com', 'https://example.com:8443'), true);
  assert.equal(crossesGrantedOrigin('http://example.com', 'https://example.com'), true);
  assert.equal(crossesGrantedOrigin('https://example.com', 'https://sub.example.com'), true);
});

test('same-origin path/query/hash navigation keeps the grant (SPA routes are safe)', () => {
  const g = 'https://app.example.com';
  assert.equal(crossesGrantedOrigin(g, 'https://app.example.com/dashboard'), false);
  assert.equal(crossesGrantedOrigin(g, 'https://app.example.com/x?y=1#z'), false);
  assert.equal(crossesGrantedOrigin(g, 'https://app.example.com:443/'), false); // default port normalizes
});
