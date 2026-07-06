import { Mode } from '../core/modes';
import { RiskLevel, Tool, Parser } from '../core/tool';

/**
 * A single located element, in the SAME CSS-viewport pixel space that `click_at`/`move_to`
 * consume — so an agent can `locate` then act on the returned `x`/`y` without reading a
 * screenshot or guessing pixels (the expensive vision step in the computer-use loop).
 */
export interface LocateMatch {
  /** Accessible name / text of the match, truncated. */
  matched: string;
  /** Lowercased tag, plus any ARIA role (e.g. "a[link]", "button"). */
  tag: string;
  /** Centre point in CSS viewport px — feed straight to click_at / move_to. */
  x: number;
  y: number;
  rect: { x: number; y: number; width: number; height: number };
  /** True when the centre is inside the live viewport (directly actionable without scrolling). */
  inViewport: boolean;
  /** When inViewport, true if another element covers the centre point (a trusted click would miss). */
  obscured: boolean;
}

export interface LocateResult {
  query: { text?: string; selector?: string };
  /** Total visible matches found (before the cap). */
  count: number;
  /** Up to MAX_MATCHES matches, nearest-the-top first. */
  matches: LocateMatch[];
}

/** Read-only DOM geometry lookup. Electron-free interface (implemented by PageController). */
export interface LocateController {
  locate(tabId: string, query: { text?: string; selector?: string }): Promise<LocateResult>;
}

const MAX_TEXT = 200;
const MAX_SELECTOR = 500;

const locateSchema: Parser<{ text?: string; selector?: string }> = {
  parse(raw) {
    if (typeof raw !== 'object' || raw === null) throw new Error('expected { text?, selector? }');
    const o = raw as { text?: unknown; selector?: unknown };
    const text = o.text === undefined ? undefined : String(o.text).slice(0, MAX_TEXT);
    const selector = o.selector === undefined ? undefined : String(o.selector).slice(0, MAX_SELECTOR);
    if ((text === undefined || text.trim() === '') && (selector === undefined || selector.trim() === '')) {
      throw new Error('provide a non-empty "text" or "selector"');
    }
    return {
      text: text && text.trim() !== '' ? text.trim() : undefined,
      selector: selector && selector.trim() !== '' ? selector.trim() : undefined,
    };
  },
};

/**
 * `locate` — resolve visible elements to coordinates via the DOM (no screenshot, no approval).
 * The fast half of the computer-use loop: it moves target-finding off the model's vision and onto
 * the page's own layout (~20 ms), so `click_at`/`move_to` become deterministic on any DOM page.
 * Read-only: it never scrolls or mutates the page (use `scroll` to bring an off-viewport match in).
 */
export function createLocateTool(ctrl: LocateController): Tool<{ text?: string; selector?: string }, LocateResult> {
  return {
    name: 'locate',
    description:
      'Find visible elements by text or CSS selector and return their centre coordinates (CSS px) ' +
      'for click_at / move_to, with viewport + occlusion flags. Read-only; does not scroll or change the page.',
    minMode: Mode.Read,
    risk: RiskLevel.Low,
    requiresApproval: false,
    auditInput: true,
    inputSchema: locateSchema,
    handler: (input, ctx) => ctrl.locate(ctx.tabId, input),
  };
}
