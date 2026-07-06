import test from 'node:test';
import assert from 'node:assert/strict';
import { isSensitiveField } from './actions';

test('password inputs are sensitive', () => {
  assert.equal(isSensitiveField({ type: 'password' }), true);
  assert.equal(isSensitiveField({ type: 'PASSWORD' }), true);
});

test('sensitive autocomplete tokens are masked', () => {
  for (const ac of ['current-password', 'new-password', 'cc-number', 'cc-csc', 'one-time-code']) {
    assert.equal(isSensitiveField({ type: 'text', autocomplete: ac }), true, ac);
  }
});

test('sensitive names/ids/labels are masked', () => {
  assert.equal(isSensitiveField({ type: 'text', name: 'user_password' }), true);
  assert.equal(isSensitiveField({ type: 'text', id: 'cardNumber' }), true);
  assert.equal(isSensitiveField({ type: 'text', ariaLabel: 'CVV' }), true);
  assert.equal(isSensitiveField({ type: 'text', placeholder: 'Enter your PIN' }), true);
  assert.equal(isSensitiveField({ type: 'text', name: 'ssn' }), true);
  assert.equal(isSensitiveField({ type: 'text', id: 'otp-code' }), true);
});

test('ordinary fields are NOT masked', () => {
  assert.equal(isSensitiveField({ type: 'text', name: 'email' }), false);
  assert.equal(isSensitiveField({ type: 'text', name: 'first_name' }), false);
  assert.equal(isSensitiveField({ type: 'search', name: 'q' }), false);
  assert.equal(isSensitiveField({}), false);
});
