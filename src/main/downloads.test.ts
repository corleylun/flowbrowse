import { test } from 'node:test';
import assert from 'node:assert/strict';
import { uniqueSavePath } from './downloads';

test('uniqueSavePath: returns the plain path when nothing collides', () => {
  assert.equal(uniqueSavePath('/d', 'statement.pdf', () => false), '/d/statement.pdf');
});

test('uniqueSavePath: appends " (n)" before the extension on collision', () => {
  const taken = new Set(['/d/statement.pdf', '/d/statement (1).pdf']);
  assert.equal(uniqueSavePath('/d', 'statement.pdf', (p) => taken.has(p)), '/d/statement (2).pdf');
});

test('uniqueSavePath: handles names with no extension', () => {
  const taken = new Set(['/d/report']);
  assert.equal(uniqueSavePath('/d', 'report', (p) => taken.has(p)), '/d/report (1)');
});

test('uniqueSavePath: strips any path components from the filename (no folder escape)', () => {
  // A malicious Content-Disposition filename must not let the file land outside the folder.
  assert.equal(uniqueSavePath('/d', '../../etc/passwd', () => false), '/d/passwd');
  assert.equal(uniqueSavePath('/d', '/abs/evil.bin', () => false), '/d/evil.bin');
});

test('uniqueSavePath: falls back to "download" for an empty name', () => {
  assert.equal(uniqueSavePath('/d', '', () => false), '/d/download');
});
