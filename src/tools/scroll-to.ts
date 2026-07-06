import { Mode } from '../core/modes';
import { RiskLevel, Tool, Parser } from '../core/tool';

/**
 * Result of scrolling a located element into view. Coordinates are the element's centre in CSS
 * viewport px AFTER the scroll settles — i.e. ready to hand to `click_at` / `move_to`.
 */
export interface ScrollToResult {
  found: boolean;
  /** Accessible name / text of the element scrolled to (truncated). */
  matched?: string;
  x?: number;
  y?: number;
  /** True once the element's centre is inside the viewport (normally true after a successful scroll). */
  inViewport?: boolean;
  /** True if, after scrolling, another element still covers the centre (a click there would miss). */
  obscured?: boolean;
  /** Short, non-sensitive context (e.g. "no match"). */
  note?: string;
}

export interface ScrollToController {
  scrollTo(tabId: string, query: { text?: string; selector?: string }): Promise<ScrollToResult>;
}

const MAX_TEXT = 200;
const MAX_SELECTOR = 500;

const scrollToSchema: Parser<{ text?: string; selector?: string }> = {
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
 * `scroll_to` — bring the element matching `text`/`selector` into view (DOM `scrollIntoView`), then
 * report its post-scroll centre coordinates. One targeted scroll replaces the blind
 * scroll-and-re-check loop when a `locate` match is off-viewport. Act-tier + approval (it repositions
 * the page, like `scroll`), but the approval card shows the human-legible query rather than a raw
 * delta. Uses JS scroll (reliable element targeting) — not a bot-detection-sensitive action.
 */
export function createScrollToTool(ctrl: ScrollToController): Tool<{ text?: string; selector?: string }, ScrollToResult> {
  return {
    name: 'scroll_to',
    description:
      'Scroll the element matching text or CSS selector into view, then return its centre ' +
      'coordinates (CSS px) for click_at / move_to. Use after locate reports a match as inViewport:false.',
    minMode: Mode.Act,
    risk: RiskLevel.Low,
    requiresApproval: true,
    auditDetail: (i) => (i.selector ? `selector: ${i.selector}` : `text: ${i.text}`),
    inputSchema: scrollToSchema,
    handler: (input, ctx) => ctrl.scrollTo(ctx.tabId, input),
  };
}
