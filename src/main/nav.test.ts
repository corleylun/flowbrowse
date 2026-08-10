import test from 'node:test';
import assert from 'node:assert/strict';
import { originOf, crossesGrantedOrigin, isWebOrigin, isLocalHost, normalizeUrl } from './nav';

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

test('isLocalHost recognizes the localhost family + loopback', () => {
  assert.equal(isLocalHost('localhost'), true);
  assert.equal(isLocalHost('app.localhost'), true);
  assert.equal(isLocalHost('127.0.0.1'), true);
  assert.equal(isLocalHost('0.0.0.0'), true);
  assert.equal(isLocalHost('::1'), true);
  assert.equal(isLocalHost('example.com'), false);
  assert.equal(isLocalHost('notlocalhost.com'), false);
});

test('normalizeUrl passes an explicit scheme through untouched', () => {
  assert.equal(normalizeUrl('http://localhost:3000'), 'http://localhost:3000');
  assert.equal(normalizeUrl('https://example.com/x'), 'https://example.com/x');
  assert.equal(normalizeUrl('  http://127.0.0.1:8080/api  '), 'http://127.0.0.1:8080/api'); // trimmed
});

test('normalizeUrl defaults local dev to http:// (the debugging fix)', () => {
  assert.equal(normalizeUrl('localhost:3000'), 'http://localhost:3000'); // was a search before
  assert.equal(normalizeUrl('localhost'), 'http://localhost');
  assert.equal(normalizeUrl('127.0.0.1:3000'), 'http://127.0.0.1:3000'); // was a search before
  assert.equal(normalizeUrl('app.localhost:5173'), 'http://app.localhost:5173');
  assert.equal(normalizeUrl('localhost:3000/api/health'), 'http://localhost:3000/api/health');
});

test('normalizeUrl: any host:port defaults to http (ports mean dev servers)', () => {
  assert.equal(normalizeUrl('myapp.test:8080'), 'http://myapp.test:8080');
  assert.equal(normalizeUrl('192.168.1.5:5173'), 'http://192.168.1.5:5173');
});

test('normalizeUrl keeps https for bare domains without a port', () => {
  assert.equal(normalizeUrl('example.com'), 'https://example.com');
  assert.equal(normalizeUrl('example.com/path'), 'https://example.com/path');
  assert.equal(normalizeUrl('sub.example.co.uk'), 'https://sub.example.co.uk');
});

test('normalizeUrl searches bare words and phrases', () => {
  assert.equal(normalizeUrl('recipes'), 'https://duckduckgo.com/?q=recipes');
  assert.equal(normalizeUrl('how to debug http'), 'https://duckduckgo.com/?q=how%20to%20debug%20http');
});
