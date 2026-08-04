import type { WebContents } from 'electron';
import { PageController, PageExtract, Screenshot } from '../tools/read';
import { DevController } from '../tools/dev';
import { ActController, ClickResult, FillResult, SubmitResult, Liveness } from '../tools/act';
import { InspectController, ElementInfo, ConsoleMessage, NetworkEntry, NetworkBodyEntry } from '../tools/inspect';
import { LocateController, LocateResult, LocateMatch } from '../tools/locate';
import { ScrollToController, ScrollToResult } from '../tools/scroll-to';
import { CoordinateController, CoordPreviewer, CoordResult } from '../tools/coordinate';
import { ApprovalPreview } from '../core/approval';
import { BrokerError, DenyReason } from '../core/errors';

/** Resolves a tabId to its live WebContents (or null). Phase 3 is single-tab. */
export type WebContentsResolver = (tabId: string) => WebContents | null;

/**
 * Fixed inter-character delay for real-input typing. A RELIABILITY constant only — debounced
 * inputs / autocomplete / IME drop characters when flooded. It is deliberately a single fixed
 * value: it must NEVER be made variable, jittered, or content-dependent (that would cross from
 * "make the input land" into "disguise the typist", i.e. detection evasion). The scope-line test
 * asserts this stays a constant.
 */
export const CHAR_SETTLE_MS = 12;

/** Optional hooks for the real-input path. Both default to a no-op (JS path / always-active). */
export interface RealInputHooks {
  /** Whether the per-tab "real input" toggle is on for this tab. */
  realInputFor(tabId: string): boolean;
  /** Whether this tab is the active (foreground/attached) tab — NOT OS window focus. */
  isActiveTab(tabId: string): boolean;
}

const coord = (cssPx: number, zoom: number): number => Math.round(cssPx * zoom);
const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Fail-closed liveness gate for the real-input path. Effectful real input is multi-step (a fill
 * types char by char), so this is re-checked before every irreversible step: a Stop AI / revoke
 * mid-action throws here and stops further input — it doesn't merely discard the result.
 */
function ensureLive(live?: Liveness): void {
  if (live && (live.signal.aborted || !live.isLive())) {
    throw new BrokerError(DenyReason.Revoked, 'revoked during real input');
  }
}

/**
 * A fixed, READ-ONLY introspection script. It serializes the visible text + links and
 * never mutates the DOM or touches the network. This is the "introspection JS allowed,
 * mutation JS not" boundary; the deeper CDP-based inspect/console/network and run_js
 * tiers arrive in Phase 4.
 *
 * LIMITATION: this runs in the page's MAIN world, so a hostile page can shadow the
 * globals it reads (title / location / link hrefs) and feed misleading data. That is a
 * data-integrity caveat of *any* DOM read — NOT a leak or escalation (this is read-only)
 * — and is no different from the human looking at the same page. Phase 4 moves extraction
 * to a CDP isolated world / accessibility snapshot so page JS can't shadow the read.
 */
const EXTRACT_JS = `(() => {
  const text = document.body ? document.body.innerText : '';
  const links = Array.from(document.querySelectorAll('a[href]')).slice(0, 500).map((a) => ({
    href: a.href,
    text: (a.textContent || '').trim().slice(0, 200),
  }));
  return { url: location.href, title: document.title, text: text.slice(0, 200000), links };
})()`;

// Injected into the page's MAIN world at each load to record XHR/fetch response BODIES (text/JSON
// only, capped) into a per-document ring buffer that `read_network_body` pulls. Idempotent per
// document. Runs page-side because only the main world sees the page's real fetch/XHR; it captures
// continuously, but the broker still gates reads by mode/epoch and main.ts clears this buffer on
// every AI grant so the agent never sees blind-period bodies (no retroactive leak).
const NET_CAPTURE_JS = `(() => {
  if (window.__scbNetInstalled) return; window.__scbNetInstalled = true;
  window.__scbNet = window.__scbNet || [];
  var MAX_BODY = 64 * 1024, MAX_ENTRIES = 50;
  var TEXTUAL = /json|text|javascript|xml|x-www-form-urlencoded/i;
  function push(method, url, status, ct, body) {
    try {
      if (typeof body !== 'string') return;
      var truncated = body.length > MAX_BODY;
      window.__scbNet.push({
        method: String(method || 'GET').toUpperCase(), url: String(url || ''),
        status: status || 0, contentType: String(ct || '').slice(0, 120),
        body: body.slice(0, MAX_BODY), truncated: truncated, ts: Date.now(),
      });
      if (window.__scbNet.length > MAX_ENTRIES) window.__scbNet.splice(0, window.__scbNet.length - MAX_ENTRIES);
    } catch (e) {}
  }
  var of = window.fetch;
  if (typeof of === 'function') {
    window.fetch = function () {
      var args = arguments;
      var req = args[0], init = args[1] || {};
      var url = (req && typeof req === 'object' && 'url' in req) ? req.url : String(req || '');
      var method = (init && init.method) || (req && typeof req === 'object' && req.method) || 'GET';
      var p = of.apply(this, args);
      try {
        p.then(function (res) {
          try {
            var ct = res.headers && res.headers.get ? (res.headers.get('content-type') || '') : '';
            if (TEXTUAL.test(ct)) res.clone().text().then(function (b) { push(method, url, res.status, ct, b); }).catch(function () {});
          } catch (e) {}
        }).catch(function () {});
      } catch (e) {}
      return p;
    };
  }
  var oopen = XMLHttpRequest.prototype.open, osend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (m, u) { this.__scbM = m; this.__scbU = u; return oopen.apply(this, arguments); };
  XMLHttpRequest.prototype.send = function () {
    var xhr = this;
    try {
      xhr.addEventListener('load', function () {
        try {
          var ct = xhr.getResponseHeader ? (xhr.getResponseHeader('content-type') || '') : '';
          var rt = xhr.responseType;
          if (rt === '' || rt === 'text') { if (TEXTUAL.test(ct)) push(xhr.__scbM, xhr.__scbU, xhr.status, ct, xhr.responseText); }
          else if (rt === 'json') { push(xhr.__scbM, xhr.__scbU, xhr.status, ct || 'application/json', JSON.stringify(xhr.response)); }
        } catch (e) {}
      });
    } catch (e) {}
    return osend.apply(this, arguments);
  };
})()`;

/** Electron implementation of all brokered page controllers (Read/Inspect/Act/Develop). */
export class ElectronPageController
  implements
    PageController,
    DevController,
    ActController,
    InspectController,
    CoordinateController,
    CoordPreviewer,
    LocateController,
    ScrollToController
{
  private readonly consoleBuf = new Map<string, ConsoleMessage[]>();
  private readonly networkBuf = new Map<string, NetworkEntry[]>();
  private readonly bufCap = 200;
  private readonly hooks: RealInputHooks;

  constructor(
    private readonly resolve: WebContentsResolver,
    hooks?: Partial<RealInputHooks>,
  ) {
    // Default: never use real input, treat every tab as active. Keeps existing callers/tests
    // on the JS path unless real-input hooks are explicitly wired in (main.ts).
    this.hooks = {
      realInputFor: hooks?.realInputFor ?? (() => false),
      isActiveTab: hooks?.isActiveTab ?? (() => true),
    };
  }

  /**
   * Begin buffering console + network events for a tab (call once when its page exists).
   * `read_console` / `read_network` serve from these capped ring buffers.
   */
  attach(tabId: string, wc: WebContents): void {
    // Re-initialised on each call (a container switch creates a fresh page) — the new
    // page's buffers start empty and bind to the new webContents.
    this.consoleBuf.set(tabId, []);
    this.networkBuf.set(tabId, []);

    // The 'console-message' signature has varied across Electron versions — accept both.
    const on = wc.on.bind(wc) as (ev: string, cb: (...args: unknown[]) => void) => void;
    on('console-message', (...args: unknown[]) => {
      let level = 'log';
      let text = '';
      const first = args[0] as { message?: unknown; level?: unknown } | undefined;
      if (first && typeof first === 'object' && typeof first.message === 'string') {
        level = String(first.level ?? 'log');
        text = first.message;
      } else {
        const lvl = args[1];
        level =
          typeof lvl === 'number' ? (['log', 'warning', 'error', 'info'][lvl] ?? String(lvl)) : String(lvl ?? 'log');
        text = String(args[2] ?? '');
      }
      this.push(this.consoleBuf, tabId, { level, text, ts: Date.now() });
    });

    wc.session.webRequest.onCompleted((details) => {
      this.push(this.networkBuf, tabId, {
        method: details.method,
        url: details.url,
        status: details.statusCode,
        ts: Date.now(),
      });
    });

    // Install the main-world XHR/fetch body recorder on every document load (idempotent per doc).
    const install = (): void => {
      if (!wc.isDestroyed()) void wc.executeJavaScript(NET_CAPTURE_JS, false).catch(() => {});
    };
    wc.on('dom-ready', install);
  }

  /** Drop a tab's buffers when it's closed (no live listeners remain on a destroyed wc). */
  detach(tabId: string): void {
    this.consoleBuf.delete(tabId);
    this.networkBuf.delete(tabId);
  }

  private push<T>(buf: Map<string, T[]>, tabId: string, item: T): void {
    const arr = buf.get(tabId) ?? [];
    arr.push(item);
    if (arr.length > this.bufCap) arr.splice(0, arr.length - this.bufCap);
    buf.set(tabId, arr);
  }

  private wc(tabId: string): WebContents {
    const wc = this.resolve(tabId);
    if (!wc || wc.isDestroyed()) throw new Error(`no live page for tab ${tabId}`);
    return wc;
  }

  async extract(tabId: string): Promise<PageExtract> {
    // Fixed read-only script; userGesture = false.
    const result = await this.wc(tabId).executeJavaScript(EXTRACT_JS, false);
    return result as PageExtract;
  }

  async screenshot(tabId: string): Promise<Screenshot> {
    const image = await this.wc(tabId).capturePage();
    // A hidden/backgrounded WebContentsView (e.g. a `tab` target that isn't the foreground tab)
    // can legitimately capture empty. Detect the cheap way (NativeImage#isEmpty) and say so
    // rather than silently returning a 0-byte "PNG" or engineering a visibility hack.
    if (image.isEmpty()) {
      return {
        mimeType: 'image/png',
        base64: '',
        note: 'empty capture — the tab is likely hidden/backgrounded; switch_tab to it first',
      };
    }
    return { mimeType: 'image/png', base64: image.toPNG().toString('base64') };
  }

  // --- Act tier (selectors embedded via JSON.stringify; fixed action scripts) ---
  //
  // Each effectful action has two paths: the JS-synthesized path (`jsClick`/`jsFill`, isTrusted:
  // false) and a real-input path (`sendInputEvent`, isTrusted: true) used only when the tab's
  // user-set "real input" toggle is on AND the tab is active. Real input only changes event
  // TRUST — never the permission ceiling (the broker, mode gate, and approval are unchanged).
  // There is NO humanization: a real click is a straight move→down→up at the element's centre,
  // typing is per-char with a fixed settle delay. The mode actually used is reported as
  // `realInput` on the result so the audit can be honest.

  async click(tabId: string, selector: string, label?: string, live?: Liveness): Promise<ClickResult> {
    if (!this.hooks.realInputFor(tabId)) return { ...(await this.jsClick(tabId, selector, label)), realInput: false };
    if (!this.hooks.isActiveTab(tabId)) {
      return { ...(await this.jsClick(tabId, selector, label)), realInput: false, note: 'real input needs the active tab; used JS' };
    }
    const wc = this.wc(tabId);
    const pt = await this.locatePoint(tabId, selector, label, 'clickable');
    if (!pt.found) return { clicked: false, matched: '', realInput: true };
    if (pt.obscured) {
      // A trusted click at this point would activate whatever overlay covers it — refuse and be
      // honest rather than click the wrong thing while the audit says we clicked the target.
      return { clicked: false, matched: pt.matched, realInput: true, note: 'target obscured by another element; not clicked' };
    }
    ensureLive(live);
    this.mouseClick(wc, pt.x, pt.y);
    return { clicked: true, matched: pt.matched, realInput: true };
  }

  /**
   * Resolve a selector/label to a viewport point for real input. Runs in the page: finds the
   * element (same label-fallback as jsClick), scrolls it into view with `behavior:'instant'`,
   * waits a frame so layout settles (no stale/pre-scroll rect), then returns the centre in CSS px
   * plus an OCCLUSION check (elementFromPoint must be the element or a descendant). The caller
   * scales by zoomFactor for sendInputEvent's device-independent coords.
   */
  private async locatePoint(
    tabId: string,
    selector: string,
    label: string | undefined,
    kind: 'clickable' | 'field',
  ): Promise<{ found: boolean; obscured: boolean; matched: string; x: number; y: number }> {
    const candSel =
      kind === 'field'
        ? 'input, textarea, select, [contenteditable="true"]'
        : 'button, a, [role="button"], [role="link"], [role="tab"], [role="menuitem"], input[type="submit"], input[type="button"]';
    const js = `(async () => {
      const norm = (s) => (s || '').toString().replace(/\\s+/g, ' ').trim();
      const want = norm(${JSON.stringify(label ?? '')}).toLowerCase();
      const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      const nameOf = (e) => norm(e.innerText || e.value || e.getAttribute('aria-label') || e.getAttribute('title') || e.getAttribute('placeholder')).toLowerCase();
      let el = document.querySelector(${JSON.stringify(selector)});
      if (!el && want) {
        const cands = Array.from(document.querySelectorAll(${JSON.stringify(candSel)})).filter(vis);
        el = cands.find((e) => nameOf(e) === want) || cands.find((e) => nameOf(e).includes(want)) || null;
      }
      if (!el) return { found: false, obscured: false, matched: '', x: 0, y: 0 };
      const matched = norm(el.innerText || el.value || el.getAttribute('aria-label') || el.tagName).slice(0, 100);
      el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
      await new Promise((r) => requestAnimationFrame(() => r(null))); // let the instant scroll apply
      const r = el.getBoundingClientRect();
      const x = r.left + r.width / 2, y = r.top + r.height / 2;
      // Occlusion: the point must resolve to our element (or a child), else something covers it.
      const hit = document.elementFromPoint(x, y);
      const obscured = !(hit && (hit === el || el.contains(hit) || (hit.contains && hit.contains(el))));
      return { found: true, obscured, matched, x, y };
    })()`;
    const raw = (await this.wc(tabId).executeJavaScript(js, true)) as {
      found: boolean;
      obscured: boolean;
      matched: string;
      x: number;
      y: number;
    };
    const zoom = this.wc(tabId).getZoomFactor();
    return { ...raw, x: coord(raw.x, zoom), y: coord(raw.y, zoom) };
  }

  /** A real left click: move the cursor to the point, then press and release. No humanization. */
  private mouseClick(wc: WebContents, x: number, y: number): void {
    wc.sendInputEvent({ type: 'mouseMove', x, y });
    wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
    wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
  }

  private async jsClick(tabId: string, selector: string, label?: string): Promise<ClickResult> {
    const js = `(() => {
      const norm = (s) => (s || '').toString().replace(/\\s+/g, ' ').trim();
      const want = norm(${JSON.stringify(label ?? '')}).toLowerCase();
      const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      const nameOf = (e) => norm(e.innerText || e.value || e.getAttribute('aria-label') || e.getAttribute('title')).toLowerCase();
      let el = document.querySelector(${JSON.stringify(selector)});
      if (!el && want) {
        // Selector missed (DOM changed) — re-find by the recorded accessible label.
        const cands = Array.from(document.querySelectorAll(
          'button, a, [role="button"], [role="link"], [role="tab"], [role="menuitem"], input[type="submit"], input[type="button"]'
        )).filter(vis);
        el = cands.find((e) => nameOf(e) === want) || cands.find((e) => nameOf(e).includes(want)) || null;
      }
      if (!el) return { clicked: false, matched: '' };
      const label = norm(el.innerText || el.value || el.getAttribute('aria-label') || el.tagName).slice(0, 100);
      el.scrollIntoView({ block: 'center', inline: 'center' });
      el.click();
      return { clicked: true, matched: label };
    })()`;
    return (await this.wc(tabId).executeJavaScript(js, true)) as ClickResult;
  }

  async fill(tabId: string, selector: string, value: string, label?: string, live?: Liveness): Promise<FillResult> {
    if (!this.hooks.realInputFor(tabId)) return { ...(await this.jsFill(tabId, selector, value, label)), realInput: false };
    if (!this.hooks.isActiveTab(tabId)) {
      return { ...(await this.jsFill(tabId, selector, value, label)), realInput: false, note: 'real input needs the active tab; used JS' };
    }
    const wc = this.wc(tabId);
    const pt = await this.locatePoint(tabId, selector, label, 'field');
    if (!pt.found) return { filled: false, matched: '', realInput: true };
    if (pt.obscured) {
      // Can't reliably real-click an obscured field to focus it — fall back honestly to the JS path.
      return { ...(await this.jsFill(tabId, selector, value, label)), realInput: false, note: 'field obscured; used JS' };
    }
    ensureLive(live);
    this.mouseClick(wc, pt.x, pt.y); // real click to focus the field
    await this.selectAllInFocused(tabId); // clear via programmatic selection — NOT a Cmd/Ctrl+A chord
    await this.typeChars(wc, value, live); // per-char real keystrokes, re-checking liveness each char
    const landed = await this.fieldLanded(tabId, selector, value, label);
    if (landed.filled) return { filled: true, matched: landed.matched, realInput: true };
    // Real typing didn't land (rich-text editor etc.) — fall back to the editor-aware JS insert,
    // but still report realInput:true since real-input mode drove the action.
    return { ...(await this.jsFill(tabId, selector, value, label)), realInput: true };
  }

  /** Select all content of the focused element so the next keystroke overwrites it. */
  private async selectAllInFocused(tabId: string): Promise<void> {
    const js = `(() => {
      const e = document.activeElement;
      if (!e) return false;
      if (e.isContentEditable) {
        const r = document.createRange(); r.selectNodeContents(e);
        const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
        return true;
      }
      if (typeof e.select === 'function') { e.select(); return true; }
      return false;
    })()`;
    await this.wc(tabId).executeJavaScript(js, true);
  }

  /** Type text as real keystrokes (keyDown→char→keyUp per char) with a fixed settle delay,
   *  re-checking liveness before every character so a mid-fill revoke stops the typing. */
  private async typeChars(wc: WebContents, value: string, live?: Liveness): Promise<void> {
    for (const ch of value) {
      ensureLive(live);
      wc.sendInputEvent({ type: 'keyDown', keyCode: ch });
      wc.sendInputEvent({ type: 'char', keyCode: ch });
      wc.sendInputEvent({ type: 'keyUp', keyCode: ch });
      await delay(CHAR_SETTLE_MS);
    }
  }

  /** Read-only check: did the real-typed value actually land in the field? Never writes. */
  private async fieldLanded(
    tabId: string,
    selector: string,
    value: string,
    label?: string,
  ): Promise<{ filled: boolean; matched: string }> {
    const js = `(() => {
      const norm = (s) => (s || '').toString().replace(/\\s+/g, ' ').trim();
      const want = norm(${JSON.stringify(label ?? '')}).toLowerCase();
      const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      const idOf = (e) => norm(
        e.getAttribute('aria-label') || e.getAttribute('name') || e.getAttribute('placeholder') ||
        (e.labels && e.labels[0] && e.labels[0].textContent) || ''
      ).toLowerCase();
      let el = document.querySelector(${JSON.stringify(selector)});
      if (!el && want) {
        const inputs = Array.from(document.querySelectorAll('input, textarea, select, [contenteditable="true"]')).filter(vis);
        el = inputs.find((e) => idOf(e) === want) || inputs.find((e) => idOf(e).includes(want)) || null;
      }
      if (!el) return { filled: false, matched: '' };
      const readBack = (e) => e.isContentEditable ? (e.innerText || e.textContent || '') : (e.value || '');
      const nl = norm(readBack(el)), nw = norm(${JSON.stringify(value)});
      const filled = nl === nw || (nw.length > 0 && nl.includes(nw));
      return { filled, matched: (el.name || el.id || el.tagName || '').toString() };
    })()`;
    return (await this.wc(tabId).executeJavaScript(js, true)) as { filled: boolean; matched: string };
  }

  private async jsFill(tabId: string, selector: string, value: string, label?: string): Promise<FillResult> {
    // Layered, honest fill. Pass 1 is a plain write (works for normal inputs). If the value didn't
    // land (rich-text editors like Lexical/Draft/ProseMirror keep their own model and discard a raw
    // write; React-controlled inputs override the value setter), pass 2 does an editor-aware insert:
    // a real paste event (preserves newlines/emoji) + execCommand fallback for contenteditable, and
    // the native value setter for inputs. After each pass we wait a tick (editors reconcile async)
    // and read the field back — only reporting filled:true if the value is actually there.
    const js = `(async () => {
      const norm = (s) => (s || '').toString().replace(/\\s+/g, ' ').trim();
      const want = norm(${JSON.stringify(label ?? '')}).toLowerCase();
      const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      const idOf = (e) => norm(
        e.getAttribute('aria-label') || e.getAttribute('name') || e.getAttribute('placeholder') ||
        (e.labels && e.labels[0] && e.labels[0].textContent) || ''
      ).toLowerCase();
      const target = ${JSON.stringify(value)};
      // setTimeout (not rAF) so it still resolves in a hidden/throttled window — never hangs.
      const tick = () => new Promise((r) => setTimeout(r, 30));
      const readBack = (e) => e.isContentEditable ? (e.innerText || e.textContent || '') : (e.value || '');
      const landed = (e) => { const nl = norm(readBack(e)), nw = norm(target); return nl === nw || (nw.length > 0 && nl.includes(nw)); };

      let el = document.querySelector(${JSON.stringify(selector)});
      if (!el && want) {
        const inputs = Array.from(document.querySelectorAll('input, textarea, select, [contenteditable="true"]')).filter(vis);
        el = inputs.find((e) => idOf(e) === want) || inputs.find((e) => idOf(e).includes(want)) || null;
      }
      if (!el) return { filled: false, matched: '' };
      const matched = (el.name || el.id || el.tagName || '').toString();
      el.focus();

      // Pass 1 — plain write (fast path).
      if (el.isContentEditable) { el.textContent = target; }
      else { el.value = target; }
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      await tick();
      if (landed(el)) return { filled: true, matched };

      // Pass 2 — editor-aware insert for fields that discarded pass 1.
      try {
        if (el.isContentEditable) {
          // Select existing content so the insert REPLACES it, then dispatch a real paste event
          // (Lexical/Draft/ProseMirror read clipboardData and preserve newlines); execCommand is a
          // secondary for editors that act on insertText rather than paste.
          const range = document.createRange(); range.selectNodeContents(el);
          const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range);
          const dt = new DataTransfer(); dt.setData('text/plain', target);
          el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
          await tick();
          if (!landed(el) && document.execCommand) {
            const r2 = document.createRange(); r2.selectNodeContents(el);
            const s2 = window.getSelection(); s2.removeAllRanges(); s2.addRange(r2);
            document.execCommand('insertText', false, target);
          }
        } else {
          // React/controlled inputs override the value setter — use the native one + an input event.
          const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(proto, 'value');
          if (setter && setter.set) setter.set.call(el, target);
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }
      } catch (_) { /* fall through to an honest read-back */ }
      await tick();
      if (landed(el)) return { filled: true, matched };

      return {
        filled: false,
        matched,
        note: el.isContentEditable
          ? 'value did not land — this rich-text editor rejected direct, paste, and insertText writes; use run_js or ask the user to paste.'
          : 'value did not land in the field (it may be readonly, disabled, or reset/validated by the page).',
      };
    })()`;
    return (await this.wc(tabId).executeJavaScript(js, true)) as FillResult;
  }

  async submit(tabId: string, selector: string, label?: string): Promise<SubmitResult> {
    const js = `(() => {
      const norm = (s) => (s || '').toString().replace(/\\s+/g, ' ').trim();
      const want = norm(${JSON.stringify(label ?? '')}).toLowerCase();
      const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      const idOf = (e) => norm(
        e.getAttribute('aria-label') || e.getAttribute('name') || e.getAttribute('placeholder') ||
        (e.labels && e.labels[0] && e.labels[0].textContent) || ''
      ).toLowerCase();
      let el = document.querySelector(${JSON.stringify(selector)});
      if (!el && want) {
        const fields = Array.from(document.querySelectorAll('input, textarea, [role="searchbox"], [role="combobox"], [contenteditable="true"]')).filter(vis);
        el = fields.find((e) => idOf(e) === want) || fields.find((e) => idOf(e).includes(want)) || null;
      }
      if (!el) return { submitted: false, matched: '' };
      el.focus();
      // Two paths: many search boxes act on the Enter keydown; classic forms need requestSubmit.
      const opts = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
      el.dispatchEvent(new KeyboardEvent('keydown', opts));
      el.dispatchEvent(new KeyboardEvent('keypress', opts));
      el.dispatchEvent(new KeyboardEvent('keyup', opts));
      const form = el.form || (el.closest && el.closest('form'));
      if (form) {
        try { typeof form.requestSubmit === 'function' ? form.requestSubmit() : form.submit(); } catch (_) { /* handler-driven */ }
      }
      return { submitted: true, matched: (el.name || el.id || el.tagName || '').toString() };
    })()`;
    return (await this.wc(tabId).executeJavaScript(js, true)) as SubmitResult;
  }

  // --- Coordinate ("computer use") tier: real isTrusted input at viewport coordinates ---
  // Coordinates are CSS viewport pixels; sendInputEvent wants device pixels, so they are scaled by
  // zoomFactor (as in the Phase 1 selector path) and clamped to the live viewport. Same honest rules:
  // only on the active tab, liveness re-checked before the irreversible step, no humanization.

  private async viewport(tabId: string): Promise<{ vw: number; vh: number; zoom: number }> {
    const vp = (await this.wc(tabId).executeJavaScript(
      '({ vw: window.innerWidth, vh: window.innerHeight })',
      false,
    )) as { vw: number; vh: number };
    return { vw: vp.vw, vh: vp.vh, zoom: this.wc(tabId).getZoomFactor() };
  }

  /** Clamp a CSS-pixel point into the live viewport, returning device coords for sendInputEvent. */
  private async devicePoint(tabId: string, x: number, y: number): Promise<{ dx: number; dy: number; clamped: boolean }> {
    const { vw, vh, zoom } = await this.viewport(tabId);
    const cx = Math.max(0, Math.min(x, Math.max(0, vw - 1)));
    const cy = Math.max(0, Math.min(y, Math.max(0, vh - 1)));
    return { dx: coord(cx, zoom), dy: coord(cy, zoom), clamped: cx !== x || cy !== y };
  }

  private notActive(tabId: string): CoordResult | null {
    // Real input only delivers to the foreground/attached tab — be honest, don't fake it.
    return this.hooks.isActiveTab(tabId)
      ? null
      : { done: false, realInput: true, note: 'coordinate input needs the active tab' };
  }

  async moveTo(tabId: string, x: number, y: number, live?: Liveness): Promise<CoordResult> {
    const na = this.notActive(tabId);
    if (na) return na;
    const p = await this.devicePoint(tabId, x, y);
    ensureLive(live);
    this.wc(tabId).sendInputEvent({ type: 'mouseMove', x: p.dx, y: p.dy });
    return { done: true, realInput: true, note: p.clamped ? 'clamped to viewport' : undefined };
  }

  async clickAt(tabId: string, x: number, y: number, button: 'left' | 'right', live?: Liveness): Promise<CoordResult> {
    const na = this.notActive(tabId);
    if (na) return na;
    const p = await this.devicePoint(tabId, x, y);
    ensureLive(live);
    const wc = this.wc(tabId);
    wc.sendInputEvent({ type: 'mouseMove', x: p.dx, y: p.dy });
    wc.sendInputEvent({ type: 'mouseDown', x: p.dx, y: p.dy, button, clickCount: 1 });
    wc.sendInputEvent({ type: 'mouseUp', x: p.dx, y: p.dy, button, clickCount: 1 });
    return { done: true, realInput: true, note: p.clamped ? 'clamped to viewport' : undefined };
  }

  async scrollAt(tabId: string, x: number, y: number, dy: number, dx: number, live?: Liveness): Promise<CoordResult> {
    const na = this.notActive(tabId);
    if (na) return na;
    const p = await this.devicePoint(tabId, x, y);
    ensureLive(live);
    // Agent contract: positive dy = scroll DOWN (like DOM wheel / scrollBy). Electron's mouseWheel
    // deltaY is INVERTED (negative scrolls the content down), so flip the sign. canScroll + precise
    // deltas make pixel-delta wheel scrolling actually move the document (else it's dropped).
    this.wc(tabId).sendInputEvent({
      type: 'mouseWheel',
      x: p.dx,
      y: p.dy,
      deltaX: -dx,
      deltaY: -dy,
      canScroll: true,
      hasPreciseScrollingDeltas: true,
    } as Parameters<WebContents['sendInputEvent']>[0]);
    return { done: true, realInput: true };
  }

  async pressKey(tabId: string, key: string, live?: Liveness): Promise<CoordResult> {
    const na = this.notActive(tabId);
    if (na) return na;
    ensureLive(live);
    const wc = this.wc(tabId);
    wc.sendInputEvent({ type: 'keyDown', keyCode: key });
    wc.sendInputEvent({ type: 'keyUp', keyCode: key });
    return { done: true, realInput: true };
  }

  async typeText(tabId: string, text: string, live?: Liveness): Promise<CoordResult> {
    const na = this.notActive(tabId);
    if (na) return na;
    ensureLive(live);
    await this.typeChars(this.wc(tabId), text, live); // per-char, liveness re-checked each char
    return { done: true, realInput: true };
  }

  /** Screenshot + crosshair for the approval card. Read-only. Marker mapped CSS→image pixels. */
  async previewAt(tabId: string, x?: number, y?: number): Promise<ApprovalPreview | undefined> {
    const img = await this.wc(tabId).capturePage();
    const size = img.getSize();
    const image = img.toPNG().toString('base64');
    let mx: number | undefined;
    let my: number | undefined;
    if (x !== undefined && y !== undefined) {
      const { vw, vh } = await this.viewport(tabId);
      mx = Math.round(x * (size.width / Math.max(1, vw)));
      my = Math.round(y * (size.height / Math.max(1, vh)));
    }
    return { image, w: size.width, h: size.height, x: mx, y: my };
  }

  // --- Inspect tier ---
  async inspect(tabId: string, selector: string): Promise<ElementInfo> {
    const js = `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return { matched: false };
      const r = el.getBoundingClientRect();
      const attrs = {};
      for (const a of el.attributes) attrs[a.name] = a.value;
      return {
        matched: true,
        tagName: el.tagName.toLowerCase(),
        attributes: attrs,
        text: (el.textContent || '').trim().slice(0, 500),
        outerHTML: el.outerHTML.slice(0, 2000),
        rect: { x: r.x, y: r.y, width: r.width, height: r.height },
      };
    })()`;
    return (await this.wc(tabId).executeJavaScript(js, false)) as ElementInfo;
  }

  // --- Read tier ---
  /**
   * Resolve visible elements to coordinates via the DOM — the read-only companion to the
   * coordinate tools. Returns centres in CSS viewport px (same space click_at consumes), so the
   * agent skips the screenshot→vision→guess-a-pixel loop. Never scrolls/mutates: off-viewport
   * matches are reported with inViewport:false so the caller can `scroll` first.
   */
  async locate(tabId: string, query: { text?: string; selector?: string }): Promise<LocateResult> {
    const js = `(() => {
      const MAX = 10;
      const norm = (s) => (s || '').toString().replace(/\\s+/g, ' ').trim();
      const want = norm(${JSON.stringify(query.text ?? '')}).toLowerCase();
      const sel = ${JSON.stringify(query.selector ?? '')};
      const nameOf = (e) => norm(e.innerText || e.value || e.getAttribute('aria-label') || e.getAttribute('title') || e.getAttribute('alt') || e.getAttribute('placeholder'));
      const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      let cands = [];
      if (sel) {
        try { cands = Array.from(document.querySelectorAll(sel)); } catch (e) { return { error: 'bad selector' }; }
      } else {
        const set = 'a, button, input, textarea, select, [role], h1, h2, h3, h4, h5, h6, li, label, [aria-label], [title], summary';
        cands = Array.from(document.querySelectorAll(set));
      }
      cands = cands.filter(vis);
      if (want) {
        const scored = cands.filter((e) => nameOf(e).toLowerCase().includes(want));
        // Drop ancestors of other matches so we keep the tightest element around the text.
        cands = scored.filter((e) => !scored.some((o) => o !== e && e.contains(o)));
        // Exact-name matches first, then by document order (top of page first).
        cands.sort((a, b) => (nameOf(b).toLowerCase() === want ? 1 : 0) - (nameOf(a).toLowerCase() === want ? 1 : 0));
      }
      const vw = window.innerWidth, vh = window.innerHeight;
      const count = cands.length;
      const matches = cands.slice(0, MAX).map((el) => {
        const r = el.getBoundingClientRect();
        const x = r.left + r.width / 2, y = r.top + r.height / 2;
        const inViewport = x >= 0 && y >= 0 && x < vw && y < vh;
        let obscured = false;
        if (inViewport) {
          const hit = document.elementFromPoint(x, y);
          obscured = !(hit && (hit === el || el.contains(hit) || (hit.contains && hit.contains(el))));
        }
        const role = el.getAttribute('role');
        return {
          matched: (nameOf(el) || el.tagName).slice(0, 100),
          tag: el.tagName.toLowerCase() + (role ? '[' + role + ']' : ''),
          x: Math.round(x), y: Math.round(y),
          rect: { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) },
          inViewport, obscured,
        };
      });
      return { count, matches };
    })()`;
    const raw = (await this.wc(tabId).executeJavaScript(js, false)) as
      | { error: string }
      | { count: number; matches: LocateMatch[] };
    if ('error' in raw) throw new BrokerError(DenyReason.InvalidInput, 'invalid CSS selector');
    return { query, count: raw.count, matches: raw.matches };
  }

  // --- Act tier ---
  /**
   * Scroll the best element matching `text`/`selector` into view (block:center, instant), then
   * return its settled centre — so one targeted scroll replaces the blind scroll-and-recheck loop
   * when a `locate` match is off-viewport. DOM scroll (reliable element targeting), not real input;
   * scrolling isn't a bot-detection-sensitive action. Uses the same match logic as `locate`.
   */
  async scrollTo(tabId: string, query: { text?: string; selector?: string }): Promise<ScrollToResult> {
    const js = `(async () => {
      const norm = (s) => (s || '').toString().replace(/\\s+/g, ' ').trim();
      const want = norm(${JSON.stringify(query.text ?? '')}).toLowerCase();
      const sel = ${JSON.stringify(query.selector ?? '')};
      const nameOf = (e) => norm(e.innerText || e.value || e.getAttribute('aria-label') || e.getAttribute('title') || e.getAttribute('alt') || e.getAttribute('placeholder'));
      const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      let el = null;
      if (sel) {
        try { el = document.querySelector(sel); } catch (e) { return { error: 'bad selector' }; }
      }
      if (!el && want) {
        const set = 'a, button, input, textarea, select, [role], h1, h2, h3, h4, h5, h6, li, label, [aria-label], [title], summary';
        const cands = Array.from(document.querySelectorAll(set)).filter(vis);
        el = cands.find((e) => nameOf(e).toLowerCase() === want)
          || cands.find((e) => nameOf(e).toLowerCase().includes(want)) || null;
      }
      if (!el) return { found: false };
      const matched = (nameOf(el) || el.tagName).slice(0, 100);
      el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
      await new Promise((r) => requestAnimationFrame(() => r(null))); // let the instant scroll apply
      const r = el.getBoundingClientRect();
      const x = r.left + r.width / 2, y = r.top + r.height / 2;
      const vw = window.innerWidth, vh = window.innerHeight;
      const inViewport = x >= 0 && y >= 0 && x < vw && y < vh;
      let obscured = false;
      if (inViewport) {
        const hit = document.elementFromPoint(x, y);
        obscured = !(hit && (hit === el || el.contains(hit) || (hit.contains && hit.contains(el))));
      }
      return { found: true, matched, x: Math.round(x), y: Math.round(y), inViewport, obscured };
    })()`;
    const raw = (await this.wc(tabId).executeJavaScript(js, true)) as { error: string } | ScrollToResult;
    if ('error' in raw) throw new BrokerError(DenyReason.InvalidInput, 'invalid CSS selector');
    if (!raw.found) return { found: false, note: 'no match' };
    return raw;
  }

  async console(tabId: string, limit: number): Promise<ConsoleMessage[]> {
    return (this.consoleBuf.get(tabId) ?? []).slice(-limit);
  }

  async network(tabId: string, limit: number): Promise<NetworkEntry[]> {
    return (this.networkBuf.get(tabId) ?? []).slice(-limit);
  }

  /** Pull recent captured XHR/fetch bodies from the page's main-world ring buffer. */
  async networkBody(tabId: string, limit: number): Promise<NetworkBodyEntry[]> {
    const wc = this.resolve(tabId);
    if (!wc || wc.isDestroyed()) return [];
    const n = Math.max(1, Math.min(Math.floor(limit) || 1, 50));
    const js = `Array.isArray(window.__scbNet) ? window.__scbNet.slice(-${n}) : []`;
    const raw = (await wc.executeJavaScript(js, false).catch(() => [])) as unknown;
    return Array.isArray(raw) ? (raw as NetworkBodyEntry[]) : [];
  }

  /** Clear the page's captured-body buffer — called on every AI grant so no blind-period body leaks. */
  clearNetworkBody(tabId: string): void {
    const wc = this.resolve(tabId);
    if (wc && !wc.isDestroyed()) void wc.executeJavaScript('window.__scbNet = []', false).catch(() => {});
  }

  // --- Developer tier ---
  async runJs(tabId: string, script: string): Promise<unknown> {
    // Arbitrary script in the page's main world. Gated upstream by Develop mode +
    // approval (the script is shown in the action card and audited). userGesture=false.
    return this.wc(tabId).executeJavaScript(script, false);
  }
}
