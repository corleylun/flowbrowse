import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { isSensitiveField, FieldInfo } from './actions';

/**
 * Invariant #2: the capture preload inlines its OWN copy of isSensitiveField (it runs in a
 * sandboxed preload that may only require 'electron'). If the two implementations diverge,
 * a value the canonical matcher would mask could leak in-page (or vice versa). We extract
 * the preload's function from source and assert it agrees with actions.ts on a broad vector
 * set — including the adversarial cases above.
 */

function findPreloadSource(): string {
  // This test may run from src/ (ts) or dist/ (compiled). Walk up from __dirname to the
  // repo root and read the canonical TypeScript source of the capture preload.
  let dir = __dirname;
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, 'src', 'preload', 'capture-preload.ts');
    if (fs.existsSync(candidate)) return candidate;
    dir = path.dirname(dir);
  }
  throw new Error('could not locate src/preload/capture-preload.ts');
}

function loadPreloadMatcher(): (f: FieldInfo) => boolean {
  const src = fs.readFileSync(findPreloadSource(), 'utf8');
  // Pull the body of `function isSensitiveField(f: FieldInfo): boolean { ... }`.
  const start = src.indexOf('function isSensitiveField');
  assert.ok(start >= 0, 'isSensitiveField not found in capture-preload.ts');
  // Find the matching closing brace for the function.
  const braceStart = src.indexOf('{', start);
  let depth = 0;
  let end = -1;
  for (let i = braceStart; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
  }
  assert.ok(end > 0, 'could not bracket isSensitiveField body');
  const fnSrc = src.slice(start, end);
  // Strip TS type annotations so we can eval as plain JS.
  const jsSrc = fnSrc
    .replace(/: FieldInfo/g, '')
    .replace(/: boolean/g, '');
  // eslint-disable-next-line no-new-func
  const factory = new Function(`${jsSrc}; return isSensitiveField;`);
  return factory() as (f: FieldInfo) => boolean;
}

const preloadMatcher = loadPreloadMatcher();

const vectors: FieldInfo[] = [
  {},
  { type: 'password' },
  { type: 'PASSWORD' },
  { type: 'text', name: 'password' },
  { type: 'text', name: 'passwd' },
  { type: 'text', name: 'passcode' },
  { type: 'text', name: 'passphrase' },
  { type: 'text', id: 'cardNumber' },
  { type: 'text', name: 'creditCard' },
  { type: 'text', name: 'ccnum' },
  { type: 'text', name: 'cvv2' },
  { type: 'text', ariaLabel: 'CVV' },
  { type: 'text', placeholder: 'CVC' },
  { type: 'text', name: 'pin' },
  { type: 'text', name: 'zipcode' },
  { type: 'text', name: 'spincode' },
  { type: 'text', name: 'otp-0' },
  { type: 'text', name: 'digit1' },
  { type: 'text', ariaLabel: 'Digit 1 of 6' },
  { type: 'text', name: 'ssn' },
  { type: 'text', name: 'socialSecurity' },
  { type: 'text', name: 'securityCode' },
  { type: 'text', name: 'mfaCode' },
  { type: 'text', name: 'iban' },
  { type: 'text', name: 'email' },
  { type: 'text', name: 'firstName' },
  { type: 'text', autocomplete: 'current-password' },
  { type: 'text', autocomplete: 'new-password' },
  { type: 'text', autocomplete: 'cc-number' },
  { type: 'text', autocomplete: 'cc-csc' },
  { type: 'text', autocomplete: 'cc-exp' },
  { type: 'text', autocomplete: 'cc-exp-month' },
  { type: 'text', autocomplete: 'cc-exp-year' },
  { type: 'text', autocomplete: 'one-time-code' },
  { type: 'text', autocomplete: 'section-x cc-number' },
  { type: 'text', autocomplete: 'name' },
  { type: 'text', name: 'card number' },
  { type: 'text', name: 'security.code' },
  { type: 'text', name: 'one time' },
  { type: 'text', placeholder: 'MM / YY' },
];

test('invariant #2: preload isSensitiveField matches actions.ts on all vectors', () => {
  for (const v of vectors) {
    assert.equal(
      preloadMatcher(v),
      isSensitiveField(v),
      `divergence on ${JSON.stringify(v)}: preload=${preloadMatcher(v)} actions=${isSensitiveField(v)}`,
    );
  }
});
