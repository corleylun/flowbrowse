import test from 'node:test';
import assert from 'node:assert/strict';
import { originOf, crossesGrantedOrigin, isWebOrigin } from './nav';

test('originOf extracts scheme://host:port, or empty on garbage', () => {
  assert.equal(originOf('https://example.com/path?q=1'), 'https://example.com');
  assert.equal(originOf('https://example.com:8443/x'), 'https://example.com:8443');
  assert.equal(originOf('not a url'), '');
  assert.equal(originOf(''), '');
});

test('same-origin navigation does NOT cross (path/query/hash changes keep the grant)', () => {
  const granted = 'https://example.com';
  assert.equal(crossesGrantedOrigin(granted, 'https://example.com/other'), false);
  assert.equal(crossesGrantedOrigin(granted, 'https://example.com/a?b=c#d'), false);
});

test('cross-origin navigation crosses (host, scheme, port, or subdomain change)', () => {
  const granted = 'https://example.com';
  assert.equal(crossesGrantedOrigin(granted, 'https://evil.com'), true);
  assert.equal(crossesGrantedOrigin(granted, 'http://example.com'), true); // scheme
  assert.equal(crossesGrantedOrigin(granted, 'https://example.com:8443'), true); // port
  assert.equal(crossesGrantedOrigin(granted, 'https://app.example.com'), true); // subdomain
});

test('with no granted origin, nothing crosses (nothing to invalidate)', () => {
  assert.equal(crossesGrantedOrigin('', 'https://anywhere.com'), false);
});

test('only http(s) origins are pinnable (opaque/empty are not)', () => {
  assert.equal(isWebOrigin('https://example.com'), true);
  assert.equal(isWebOrigin('http://localhost:3000'), true);
  assert.equal(isWebOrigin(''), false);
  assert.equal(isWebOrigin('null'), false); // about:blank / data: opaque origin
  assert.equal(isWebOrigin(originOf('about:blank')), false);
  assert.equal(isWebOrigin(originOf('file:///etc/passwd')), false);
});
