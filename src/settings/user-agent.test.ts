import { test } from 'node:test';
import assert from 'node:assert/strict';
import { plainChromiumUa } from './user-agent';

const MAC_ELECTRON_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'SafeCoBrowser/1.0.0 Chrome/128.0.6613.36 Electron/32.0.1 Safari/537.36';

test('plainChromiumUa: strips Electron + app-name tokens, preserves the rest verbatim', () => {
  const out = plainChromiumUa(MAC_ELECTRON_UA, 'SafeCoBrowser');
  assert.ok(out.includes('Chrome/128.0.6613.36'), 'exact Chrome version substring preserved');
  assert.ok(out.includes('Safari/537.36'));
  assert.ok(out.includes('Macintosh; Intel Mac OS X 10_15_7'));
  assert.ok(!/electron/i.test(out), 'Electron token removed');
  assert.ok(!/safecobrowser/i.test(out), 'app-name token removed');
});

test('plainChromiumUa: idempotent on an already-clean Chrome UA', () => {
  const clean =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) ' +
    'Chrome/128.0.6613.36 Safari/537.36';
  assert.equal(plainChromiumUa(clean, 'SafeCoBrowser'), clean);
});

test('plainChromiumUa: app-name token stripped case-insensitively', () => {
  const ua = 'Mozilla/5.0 SafeCoBrowser/1.0.0 Chrome/128.0.6613.36 Safari/537.36';
  const out = plainChromiumUa(ua, 'safecobrowser');
  assert.ok(!/safecobrowser/i.test(out));
  assert.ok(out.includes('Chrome/128.0.6613.36'));
});

test('plainChromiumUa: no double spaces, no leading/trailing space', () => {
  const out = plainChromiumUa(MAC_ELECTRON_UA, 'SafeCoBrowser');
  assert.ok(!out.includes('  '), 'no double spaces');
  assert.equal(out, out.trim(), 'no leading/trailing whitespace');
});

test('plainChromiumUa: empty/garbage input handled without throwing', () => {
  assert.equal(plainChromiumUa('', 'SafeCoBrowser'), '');
  assert.equal(plainChromiumUa(undefined as unknown as string, 'SafeCoBrowser'), '');
  assert.equal(plainChromiumUa(null as unknown as string, 'SafeCoBrowser'), '');
  assert.doesNotThrow(() => plainChromiumUa(MAC_ELECTRON_UA, ''));
  assert.doesNotThrow(() => plainChromiumUa(MAC_ELECTRON_UA, undefined as unknown as string));
});

test('plainChromiumUa: exact-equality on the full sample UA (catches any mangled middle section)', () => {
  const expected =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) ' +
    'Chrome/128.0.6613.36 Safari/537.36';
  assert.equal(plainChromiumUa(MAC_ELECTRON_UA, 'SafeCoBrowser'), expected);
});

test('plainChromiumUa: escapeRegExp is exercised — regex metachars in appName are treated literally', () => {
  // A literal dot must not act as "any char": 'a.b/1.0' should be stripped, but the
  // similarly-shaped 'aXb/9.9' (which an unescaped `a.b` regex would also match) must survive.
  const dotUa = 'Mozilla/5.0 a.b/1.0 aXb/9.9 Chrome/128.0.6613.36 Safari/537.36';
  const dotOut = plainChromiumUa(dotUa, 'a.b');
  assert.ok(!dotOut.includes('a.b/1.0'), 'literal dot token stripped');
  assert.ok(dotOut.includes('aXb/9.9'), 'unrelated token surviving proves the dot was NOT a wildcard');

  // Unescaped parentheses form a capture group, so an unescaped `foo(bar)/\S+` would also match
  // 'foobar/9.9' (no literal parens needed). Escaping must keep that decoy token intact.
  const parenUa = 'Mozilla/5.0 foo(bar)/1.0 foobar/9.9 Chrome/128.0.6613.36 Safari/537.36';
  const parenOut = plainChromiumUa(parenUa, 'foo(bar)');
  assert.ok(!parenOut.includes('foo(bar)/1.0'), 'literal paren token stripped');
  assert.ok(parenOut.includes('foobar/9.9'), 'decoy token surviving proves parens were NOT a capture group');
});

test('plainChromiumUa: empty/undefined appName strips Electron only, leaves the app-name token intact', () => {
  const outEmpty = plainChromiumUa(MAC_ELECTRON_UA, '');
  assert.ok(!/electron/i.test(outEmpty), 'Electron token still stripped');
  assert.ok(outEmpty.includes('SafeCoBrowser/1.0.0'), 'app-name token left alone when appName is empty');
  assert.ok(outEmpty.includes('Chrome/128.0.6613.36'), 'unrelated "/ver" tokens untouched, not swept up as garbage');

  const outUndefined = plainChromiumUa(MAC_ELECTRON_UA, undefined as unknown as string);
  assert.ok(!/electron/i.test(outUndefined));
  assert.ok(outUndefined.includes('SafeCoBrowser/1.0.0'));
});

test('plainChromiumUa: L2 guard — a reserved/generic app name never strips a real UA component', () => {
  const out = plainChromiumUa(MAC_ELECTRON_UA, 'Chrome');
  assert.ok(out.includes('Chrome/128.0.6613.36'), 'Chrome/<ver> component survives even when appName is "Chrome"');
  assert.ok(!/electron/i.test(out), 'Electron/<ver> is still stripped regardless of the app-name guard');
});

test('plainChromiumUa: appName containing the literal substring "Electron" still yields a valid Chrome UA', () => {
  const ua =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) ' +
    'MyElectronApp/2.0 Chrome/128.0.6613.36 Electron/32.0.1 Safari/537.36';
  const out = plainChromiumUa(ua, 'MyElectronApp');
  assert.ok(!out.includes('MyElectronApp/2.0'), 'app-name token stripped ("MyElectronApp" is not the reserved word "electron")');
  assert.ok(!/electron\/\S+/i.test(out), 'Electron/<ver> version token stripped');
  assert.ok(out.includes('Chrome/128.0.6613.36'));
  assert.ok(out.includes('Safari/537.36'));
});
