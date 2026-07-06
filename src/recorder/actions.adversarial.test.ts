import test from 'node:test';
import assert from 'node:assert/strict';
import { isSensitiveField } from './actions';

/**
 * Adversarial review of the masking decision (`isSensitiveField`) — the privacy-critical
 * core of Phase 5. A field that slips through here has its plaintext value captured and
 * sent to main: a real leak (invariant #1/#3). These tests document BOTH what is caught
 * and, explicitly, what currently LEAKS, so the gaps are visible and tracked.
 */

// ---------------------------------------------------------------------------
// Things that MUST be masked — and are (regression guards).
// ---------------------------------------------------------------------------

test('adversarial: password rendered as type=text with a show-password toggle is masked', () => {
  // A "show password" toggle flips type=password → type=text. As long as the field still
  // has a password-y name/id/aria/placeholder, masking still fires off the haystack.
  assert.equal(isSensitiveField({ type: 'text', name: 'password' }), true);
  assert.equal(isSensitiveField({ type: 'text', id: 'loginPassword' }), true);
  assert.equal(isSensitiveField({ type: 'text', ariaLabel: 'Password' }), true);
  assert.equal(isSensitiveField({ type: 'text', placeholder: 'Your password' }), true);
});

test('adversarial: passcode / passwd spelling variants are masked', () => {
  assert.equal(isSensitiveField({ type: 'text', name: 'passwd' }), true);
  assert.equal(isSensitiveField({ type: 'text', name: 'passcode' }), true);
});

test('adversarial: cc autocomplete tokens (incl. exp variants) are masked', () => {
  for (const ac of ['cc-number', 'cc-csc', 'cc-exp', 'cc-exp-month', 'cc-exp-year', 'one-time-code']) {
    assert.equal(isSensitiveField({ type: 'text', autocomplete: ac }), true, ac);
  }
});

test('adversarial: autocomplete with extra whitespace tokens still matches (token boundary)', () => {
  assert.equal(isSensitiveField({ type: 'text', autocomplete: 'section-x cc-number' }), true);
  assert.equal(isSensitiveField({ type: 'text', autocomplete: '  new-password  ' }), true);
});

test('adversarial: cvc / security code / card number (spaced) are masked', () => {
  assert.equal(isSensitiveField({ type: 'text', placeholder: 'CVC' }), true);
  assert.equal(isSensitiveField({ type: 'text', name: 'securityCode' }), true);
  assert.equal(isSensitiveField({ type: 'text', name: 'card number' }), true);
  assert.equal(isSensitiveField({ type: 'text', name: 'cardnumber' }), true);
  assert.equal(isSensitiveField({ type: 'text', name: 'card-number' }), true);
});

test('adversarial: standalone pin/otp tokens are masked', () => {
  assert.equal(isSensitiveField({ type: 'text', name: 'pin' }), true);
  assert.equal(isSensitiveField({ type: 'text', id: 'otp-code' }), true);
  assert.equal(isSensitiveField({ type: 'text', name: 'one-time-code' }), true);
});

test('adversarial: ordinary fields are NOT over-masked (no false positives that would harm UX)', () => {
  assert.equal(isSensitiveField({ type: 'text', name: 'email' }), false);
  assert.equal(isSensitiveField({ type: 'text', name: 'firstName' }), false);
  assert.equal(isSensitiveField({ type: 'text', name: 'address' }), false);
  // "zipcode" must not be caught by a loose \bpin\b — confirm word boundaries hold.
  assert.equal(isSensitiveField({ type: 'text', name: 'zipcode' }), false);
});

// ---------------------------------------------------------------------------
// Previously-leaking fields — now MASKED after broadening the matcher (Aidan's
// Phase 5 bugs 1-4). These assert the gaps are closed.
// ---------------------------------------------------------------------------

test('masked: credit-card field named "creditCard"/"ccnum"/"cardNo"/"pan"', () => {
  assert.equal(isSensitiveField({ type: 'text', name: 'creditCard' }), true);
  assert.equal(isSensitiveField({ type: 'text', name: 'ccnum' }), true);
  assert.equal(isSensitiveField({ type: 'text', name: 'cardNo' }), true);
  assert.equal(isSensitiveField({ type: 'text', name: 'pan' }), true);
});

test('masked: "cvv2" (Visa naming)', () => {
  assert.equal(isSensitiveField({ type: 'text', name: 'cvv2' }), true);
});

test('masked: card expiry fields (named + MM/YY placeholder)', () => {
  assert.equal(isSensitiveField({ type: 'text', placeholder: 'MM / YY' }), true);
  assert.equal(isSensitiveField({ type: 'text', name: 'expiryDate' }), true);
  assert.equal(isSensitiveField({ type: 'text', name: 'cardExpiry' }), true);
});

test('masked: split-OTP / 2FA inputs with digit-style names or aria', () => {
  assert.equal(isSensitiveField({ type: 'text', name: 'digit1' }), true);
  assert.equal(isSensitiveField({ type: 'text', ariaLabel: 'Digit 1 of 6' }), true);
  assert.equal(isSensitiveField({ type: 'text', name: 'otp-0' }), true);
});

test('masked: 2FA/MFA/verification/auth code fields', () => {
  for (const name of ['mfaCode', 'twoFactorCode', 'verificationCode', 'authCode', 'smsCode']) {
    assert.equal(isSensitiveField({ type: 'text', name }), true, name);
  }
});

test('masked: bank/financial identifiers (account/routing/IBAN/sortCode)', () => {
  for (const name of ['accountNumber', 'routingNumber', 'iban', 'sortCode']) {
    assert.equal(isSensitiveField({ type: 'text', name }), true, name);
  }
});

test('masked: crypto/secret material (passphrase, seed, private key, recovery, token)', () => {
  for (const name of ['passphrase', 'seedPhrase', 'privateKey', 'recoveryKey', 'apiToken']) {
    assert.equal(isSensitiveField({ type: 'text', name }), true, name);
  }
});

test('masked: DOB/passport (PII); ssn/social security still caught', () => {
  assert.equal(isSensitiveField({ type: 'text', name: 'dateOfBirth' }), true);
  assert.equal(isSensitiveField({ type: 'text', name: 'passportNumber' }), true);
  assert.equal(isSensitiveField({ type: 'text', name: 'ssn' }), true);
  assert.equal(isSensitiveField({ type: 'text', name: 'socialSecurity' }), true);
});

test('still no over-masking after broadening (common benign fields stay unmasked)', () => {
  for (const name of ['email', 'firstName', 'lastName', 'address', 'city', 'zipcode', 'phone', 'company', 'subject']) {
    assert.equal(isSensitiveField({ type: 'text', name }), false, name);
  }
});

// ---------------------------------------------------------------------------
// Defensive: undefined / mixed-case / null-ish inputs don't throw.
// ---------------------------------------------------------------------------

test('adversarial: matcher is case-insensitive and tolerates missing fields', () => {
  assert.equal(isSensitiveField({}), false);
  assert.equal(isSensitiveField({ type: 'PASSWORD' }), true);
  assert.equal(isSensitiveField({ name: 'PASSWORD' }), true);
  assert.equal(isSensitiveField({ autocomplete: 'CURRENT-PASSWORD' }), true);
});
