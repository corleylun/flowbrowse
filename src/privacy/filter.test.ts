import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyRules, sanitizeRules, PrivacyFilter } from './filter';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

test('applyRules: replaces a literal match case-insensitively', () => {
  const out = applyRules('Hello Siu Lun Corley Chan, welcome', [{ match: 'Siu Lun Corley Chan', label: '[Name]' }]);
  assert.equal(out, 'Hello [Name], welcome');
  const out2 = applyRules('contact SIU LUN corley chan', [{ match: 'Siu Lun Corley Chan', label: '[Name]' }]);
  assert.equal(out2, 'contact [Name]');
});

test('applyRules: longest match wins so overlaps do not partially clobber', () => {
  const rules = [
    { match: 'Corley', label: '[First]' },
    { match: 'Siu Lun Corley Chan', label: '[Name]' },
  ];
  assert.equal(applyRules('Siu Lun Corley Chan', rules), '[Name]');
});

test('applyRules: treats the match as a literal, not a regex', () => {
  const out = applyRules('balance a.c (1)', [{ match: 'a.c (1)', label: 'X' }]);
  assert.equal(out, 'balance X');
  // a regex-y match must not match arbitrary chars
  assert.equal(applyRules('abc', [{ match: 'a.c', label: 'X' }]), 'abc');
});

test('applyRules: defaults an empty label and ignores empty matches', () => {
  assert.equal(applyRules('John here', [{ match: 'John', label: '' }]), '[Filtered] here');
  assert.equal(applyRules('untouched', [{ match: '', label: 'X' }]), 'untouched');
});

test('sanitizeRules: trims, drops empties, defaults label, dedupes by match', () => {
  const out = sanitizeRules([
    { match: '  John Smith  ', label: ' [Name] ' },
    { match: 'john smith', label: 'dup' }, // case-insensitive dupe -> dropped
    { match: '   ', label: 'x' }, // empty -> dropped
    { match: '2 Cain Terrace', label: '' }, // empty label -> default
  ]);
  assert.deepEqual(out, [
    { match: 'John Smith', label: '[Name]' },
    { match: '2 Cain Terrace', label: '[Filtered]' },
  ]);
});

test('PrivacyFilter: redact only applies when enabled; persists across instances', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pf-')), 'privacy.json');
  const f = new PrivacyFilter(file);
  f.setRules([{ match: 'Secret', label: '[X]' }]);
  assert.equal(f.redact('a Secret b'), 'a Secret b', 'disabled = no change');
  f.setEnabled(true);
  assert.equal(f.redact('a Secret b'), 'a [X] b');

  const reloaded = new PrivacyFilter(file);
  assert.equal(reloaded.get().enabled, true);
  assert.equal(reloaded.redact('Secret'), '[X]', 'state persisted to disk');
});
