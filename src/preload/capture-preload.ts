import { ipcRenderer } from 'electron';

/**
 * Capture preload for the page view. Listens for the USER's clicks and input changes and
 * forwards them to main as semantic actions for the recorder.
 *
 * This runs as a SANDBOXED preload (it may only require 'electron'), so the masking +
 * selector logic is inlined rather than imported. The masking MUST happen here, in-page,
 * so a sensitive value never leaves the renderer — main only ever sees `value: null` for
 * masked fields.
 *
 * NOTE: `isSensitiveField` mirrors src/recorder/actions.ts — keep the two in sync.
 */

interface FieldInfo {
  type?: string;
  name?: string;
  id?: string;
  autocomplete?: string;
  ariaLabel?: string;
  placeholder?: string;
}

function isSensitiveField(f: FieldInfo): boolean {
  const type = (f.type || '').toLowerCase();
  if (type === 'password') return true;
  const autocomplete = (f.autocomplete || '').toLowerCase();
  if (
    /(^|\s)(current-password|new-password|cc-number|cc-csc|cc-exp|cc-exp-month|cc-exp-year|one-time-code)(\s|$)/.test(
      autocomplete,
    )
  ) {
    return true;
  }
  // Keep this regex byte-identical to src/recorder/actions.ts.
  const haystack = `${f.name || ''} ${f.id || ''} ${f.ariaLabel || ''} ${f.placeholder || ''}`.toLowerCase();
  return /password|passwd|passcode|passphrase|\bpin\b|cvv\d?|cvc\d?|card.?num|cardno|cc.?num|credit.?card|creditcard|\bpan\b|\bssn\b|social.?security|secret|security.?code|\botp\b|one.?time|digit[\s-]?\d|\bmfa|2fa|two.?factor|verification.?code|auth.?code|sms.?code|account.?number|routing.?number|\biban\b|sort.?code|expir|\bmm\s*\/\s*yy\b|seed.?phrase|private.?key|recovery.?(key|code|phrase)|mnemonic|token|passport|\bdob\b|date.?of.?birth/.test(
    haystack,
  );
}

function cssSelector(start: Element): string {
  const parts: string[] = [];
  let node: Element | null = start;
  while (node && node.nodeType === 1 && parts.length < 6) {
    if (node.id) {
      parts.unshift(`#${CSS.escape(node.id)}`);
      break;
    }
    let part = node.tagName.toLowerCase();
    const parent: Element | null = node.parentElement;
    if (parent) {
      const sameTag = Array.from(parent.children).filter((c) => c.tagName === node!.tagName);
      if (sameTag.length > 1) part += `:nth-of-type(${sameTag.indexOf(node) + 1})`;
    }
    parts.unshift(part);
    node = parent;
  }
  return parts.join(' > ');
}

function labelFor(el: Element): string {
  const aria = el.getAttribute('aria-label');
  if (aria) return aria.trim().slice(0, 100);
  const text = (el.textContent || '').trim();
  if (text) return text.slice(0, 100);
  const input = el as HTMLInputElement;
  return (input.placeholder || input.name || el.tagName.toLowerCase()).slice(0, 100);
}

document.addEventListener(
  'click',
  (e) => {
    const target = e.target;
    if (!(target instanceof Element)) return;
    const clickable =
      target.closest('button, a, [role="button"], input[type="submit"], input[type="button"], label') ?? target;
    ipcRenderer.send('record:action', {
      type: 'click',
      selector: cssSelector(clickable),
      label: labelFor(clickable),
      ts: Date.now(),
    });
  },
  true,
);

type FillEl = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;

function recordFill(el: FillEl): void {
  const type = (el.getAttribute('type') || '').toLowerCase();
  if (type === 'hidden' || type === 'file') return;
  const field: FieldInfo = {
    type,
    name: (el as HTMLInputElement).name,
    id: el.id,
    autocomplete: el.getAttribute('autocomplete') || '',
    ariaLabel: el.getAttribute('aria-label') || '',
    placeholder: (el as HTMLInputElement).placeholder || '',
  };
  const masked = isSensitiveField(field);
  ipcRenderer.send('record:action', {
    type: 'fill',
    selector: cssSelector(el),
    label: labelFor(el),
    value: masked ? null : el.value, // masking happens HERE, in-page, before anything leaves
    masked,
    ts: Date.now(),
  });
}

// When Enter submits a field, the browser ALSO fires a 'change' for it — suppress that one
// duplicate so we don't record the fill twice (keydown already recorded it, in order).
let suppressChangeFor: EventTarget | null = null;

document.addEventListener(
  'change',
  (e) => {
    const el = e.target;
    if (suppressChangeFor === el) {
      suppressChangeFor = null;
      return;
    }
    if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement)) {
      return;
    }
    recordFill(el);
  },
  true,
);

// Pressing Enter in a single-line text field submits a search/form — capture it so replay can
// re-run the search. Record the field's current value (a fill) FIRST, then the submit, so the
// order reads naturally. Skip textarea/contenteditable, where Enter is just a newline.
const SUBMITTABLE_INPUT = /^(text|search|email|url|tel|number|password|)$/;
document.addEventListener(
  'keydown',
  (e) => {
    if (e.key !== 'Enter' || e.isComposing || e.shiftKey) return;
    const el = e.target;
    if (!(el instanceof Element)) return;
    const role = (el.getAttribute('role') || '').toLowerCase();
    const isTextInput = el instanceof HTMLInputElement && SUBMITTABLE_INPUT.test((el.getAttribute('type') || '').toLowerCase());
    const isSearchish = role === 'searchbox' || role === 'combobox';
    if (!isTextInput && !isSearchish) return;

    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
      recordFill(el); // capture what was typed, in order, before the submit
      suppressChangeFor = el;
      // Safety net: clear the suppression if the expected change never fires.
      setTimeout(() => {
        if (suppressChangeFor === el) suppressChangeFor = null;
      }, 200);
    }
    ipcRenderer.send('record:action', {
      type: 'submit',
      selector: cssSelector(el),
      label: labelFor(el),
      ts: Date.now(),
    });
  },
  true,
);

// ---------------------------------------------------------------------------
// Privacy filter: best-effort in-page redaction of user-defined sensitive text.
// Replacing matching text nodes in the live DOM covers ALL surfaces at once — the
// user's screen, a screenshot, and what the agent reads (read_page / inspect) — since
// they all read the rendered DOM. This is convenience masking, NOT a security boundary
// (literal, case-insensitive; won't catch reformatted/split-across-node variants).
// ---------------------------------------------------------------------------
interface PvRule {
  match: string;
  label: string;
}
let pvRules: PvRule[] = [];
let pvEnabled = false;
let pvObserver: MutationObserver | null = null;
let pvScheduled = false;
const pvOriginal = new WeakMap<Text, string>(); // last pre-redaction value (for restore on disable)
let pvLastWrote = new WeakMap<Text, string>(); // what WE last wrote (loop guard); reset on rule change
const pvTouched = new Set<Text>(); // nodes we changed, so we can restore them
const PV_SKIP = new Set(['SCRIPT', 'STYLE', 'TEXTAREA', 'NOSCRIPT', 'TITLE', 'HEAD']);

function pvEsc(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
function pvApply(text: string): string {
  let out = text;
  const active = pvRules.filter((r) => r.match).sort((a, b) => b.match.length - a.match.length);
  for (const r of active) out = out.replace(new RegExp(pvEsc(r.match), 'gi'), r.label || '[Filtered]');
  return out;
}
function pvScan(): void {
  const root = document.body || document.documentElement;
  if (!root) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(n: Node): number {
      const p = n.parentElement;
      if (!p || PV_SKIP.has(p.tagName) || p.isContentEditable) return NodeFilter.FILTER_REJECT;
      if (!n.nodeValue || !n.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  const nodes: Text[] = [];
  for (let cur = walker.nextNode(); cur; cur = walker.nextNode()) nodes.push(cur as Text);
  for (const t of nodes) {
    const cur = t.nodeValue || '';
    if (pvLastWrote.get(t) === cur) continue; // our own output, unchanged — skip (prevents loops)
    const red = pvApply(cur);
    if (red !== cur) {
      pvOriginal.set(t, cur);
      t.nodeValue = red;
      pvLastWrote.set(t, red);
      pvTouched.add(t);
    } else {
      pvLastWrote.set(t, cur); // processed, no match — remember so we don't re-scan it
    }
  }
}
function pvRestore(): void {
  for (const t of pvTouched) {
    if (t.isConnected && pvOriginal.has(t)) {
      t.nodeValue = pvOriginal.get(t)!;
      pvLastWrote.delete(t);
    }
  }
  pvTouched.clear();
}
function pvSchedule(): void {
  if (pvScheduled || !pvEnabled) return;
  pvScheduled = true;
  requestAnimationFrame(() => {
    pvScheduled = false;
    if (!pvEnabled) return;
    pvObserver?.disconnect();
    pvScan();
    pvObserver?.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
  });
}
function pvSetState(state: { enabled?: boolean; rules?: PvRule[] }): void {
  pvRules = Array.isArray(state.rules) ? state.rules : [];
  pvEnabled = !!state.enabled;
  pvObserver?.disconnect();
  if (!pvObserver) pvObserver = new MutationObserver(() => pvSchedule());
  pvRestore(); // clear previous redactions so rule edits / disable take effect from a clean slate
  pvLastWrote = new WeakMap(); // forget per-node processing so changed rules re-evaluate every node
  if (pvEnabled) {
    pvScan();
    pvObserver.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
  }
}
ipcRenderer.on('privacy:state', (_e, state: { enabled?: boolean; rules?: PvRule[] }) =>
  pvSetState(state || { enabled: false, rules: [] }),
);
ipcRenderer.send('privacy:request'); // pull current state on (re)load / navigation
