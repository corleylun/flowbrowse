/**
 * A user action captured while recording. Actions are SEMANTIC (resolved selector +
 * accessible label), not raw coordinates, so they replay robustly and read clearly.
 */
export type RecordedAction =
  | { type: 'click'; selector: string; label: string; ts: number }
  | { type: 'fill'; selector: string; label: string; value: string | null; masked: boolean; ts: number }
  // Pressing Enter in a text field — submits the search/form. No value is captured (the
  // preceding 'fill' holds it); this only records the act of submitting.
  | { type: 'submit'; selector: string; label: string; ts: number }
  | { type: 'navigate'; url: string; ts: number };

/** Fields describing an input, used to decide whether its value is sensitive. */
export interface FieldInfo {
  type?: string;
  name?: string;
  id?: string;
  autocomplete?: string;
  ariaLabel?: string;
  placeholder?: string;
}

/**
 * Decide whether an input's value must be MASKED at capture time. This is the heart of
 * the "recording is not a keylogger" guarantee (#5.2): if this returns true, the value is
 * never captured — only the fact that *a* sensitive field was filled. Runs in the page
 * (in the capture preload) so a sensitive value never leaves the page, even into our own
 * main process.
 *
 * Conservative by design: when in doubt, mask.
 */
export function isSensitiveField(f: FieldInfo): boolean {
  const type = (f.type || '').toLowerCase();
  if (type === 'password') return true;
  // Non-text inputs (hidden/file/etc.) aren't recorded as fills anyway, but be safe.

  const autocomplete = (f.autocomplete || '').toLowerCase();
  if (/(^|\s)(current-password|new-password|cc-number|cc-csc|cc-exp|cc-exp-month|cc-exp-year|one-time-code)(\s|$)/.test(autocomplete)) {
    return true;
  }

  // Keep this regex byte-identical to the inlined copy in capture-preload.ts.
  const haystack = `${f.name || ''} ${f.id || ''} ${f.ariaLabel || ''} ${f.placeholder || ''}`.toLowerCase();
  return /password|passwd|passcode|passphrase|\bpin\b|cvv\d?|cvc\d?|card.?num|cardno|cc.?num|credit.?card|creditcard|\bpan\b|\bssn\b|social.?security|secret|security.?code|\botp\b|one.?time|digit[\s-]?\d|\bmfa|2fa|two.?factor|verification.?code|auth.?code|sms.?code|account.?number|routing.?number|\biban\b|sort.?code|expir|\bmm\s*\/\s*yy\b|seed.?phrase|private.?key|recovery.?(key|code|phrase)|mnemonic|token|passport|\bdob\b|date.?of.?birth/.test(
    haystack,
  );
}
