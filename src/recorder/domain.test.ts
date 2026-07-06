import test from 'node:test';
import assert from 'node:assert/strict';
import { domainForUrl, domainSlug } from './domain';

test('domainForUrl reduces subdomains to the registrable domain', () => {
  assert.equal(domainForUrl('https://x.com/home'), 'x.com');
  assert.equal(domainForUrl('https://www.x.com/home'), 'x.com');
  assert.equal(domainForUrl('https://mobile.x.com/i/flow'), 'x.com');
  assert.equal(domainForUrl('https://a.b.c.example.com/p?q=1'), 'example.com');
});

test('domainForUrl keeps three labels for known multi-part TLDs', () => {
  assert.equal(domainForUrl('https://shop.foo.co.uk/'), 'foo.co.uk');
  assert.equal(domainForUrl('https://www.foo.com.au/'), 'foo.com.au');
});

test('domainForUrl keeps localhost and bare IPs as-is', () => {
  assert.equal(domainForUrl('http://localhost:3000/x'), 'localhost');
  assert.equal(domainForUrl('http://127.0.0.1:8080/'), '127.0.0.1');
});

test('domainForUrl returns "" for non-web or malformed URLs', () => {
  assert.equal(domainForUrl('about:blank'), '');
  assert.equal(domainForUrl('file:///Users/x/page.html'), '');
  assert.equal(domainForUrl('chrome://settings'), '');
  assert.equal(domainForUrl('data:text/html,hi'), '');
  assert.equal(domainForUrl('not a url'), '');
  assert.equal(domainForUrl(''), '');
});

test('domainForUrl is case-insensitive on host', () => {
  assert.equal(domainForUrl('https://WWW.X.COM/'), 'x.com');
});

test('domainSlug sanitizes to a safe directory name', () => {
  assert.equal(domainSlug('x.com'), 'x.com'); // dots are filesystem-safe and kept
  assert.equal(domainSlug('foo.co.uk'), 'foo.co.uk');
  assert.equal(domainSlug('../../evil'), 'evil'); // no traversal
  assert.equal(domainSlug('a/b'), 'a-b');
  assert.equal(domainSlug(''), 'unknown');
});
