import { Mode } from '../core/modes';
import { RiskLevel, Tool, Parser, ToolContext } from '../core/tool';
import { BrokerError, DenyReason } from '../core/errors';

export interface ClickResult {
  clicked: boolean;
  matched: string;
  /** When `clicked` is false in real-input mode, a short hint (e.g. target obscured). Never sensitive. */
  note?: string;
  /** True iff this action was driven by real isTrusted input (sendInputEvent), not synthesized JS. */
  realInput?: boolean;
}
export interface FillResult {
  filled: boolean;
  matched: string;
  /** When `filled` is false, a short hint for the agent (e.g. a rich-text-editor gap). Never the value. */
  note?: string;
  /** True iff this action was driven by real isTrusted input (sendInputEvent), not synthesized JS. */
  realInput?: boolean;
}
export interface SubmitResult {
  submitted: boolean;
  matched: string;
}

/**
 * The liveness bits an effectful controller needs to fail closed mid-action. A multi-step real
 * input path (per-character typing) MUST re-check this before every irreversible step so a
 * Stop AI / revoke during a long fill prevents further keystrokes — not just discards the result.
 * `ToolContext` satisfies this structurally, so handlers pass `ctx`.
 */
export interface Liveness {
  isLive(): boolean;
  readonly signal: AbortSignal;
}

/** Brokered Act-tier actions on the page (Electron-free interface; no raw webContents).
 *  `label` is an optional accessible-name fallback used by replay when the CSS selector no
 *  longer matches (dynamic SPAs reshuffle the DOM); AI tool calls pass selector only. */
export interface ActController {
  click(tabId: string, selector: string, label?: string, live?: Liveness): Promise<ClickResult>;
  fill(tabId: string, selector: string, value: string, label?: string, live?: Liveness): Promise<FillResult>;
  /** Press Enter / submit the field's form. Used by replay; `label` is the accessible-name fallback. */
  submit(tabId: string, selector: string, label?: string): Promise<SubmitResult>;
}

const clickSchema: Parser<{ selector: string }> = {
  parse(raw) {
    const o = raw as { selector?: unknown };
    if (typeof raw !== 'object' || raw === null || typeof o.selector !== 'string') {
      throw new Error('expected { selector: string }');
    }
    const selector = o.selector.trim();
    if (!selector) throw new Error('selector must not be empty');
    return { selector };
  },
};

const fillSchema: Parser<{ selector: string; value: string }> = {
  parse(raw) {
    const o = raw as { selector?: unknown; value?: unknown };
    if (typeof raw !== 'object' || raw === null) throw new Error('expected { selector, value }');
    if (typeof o.selector !== 'string' || o.selector.trim() === '') {
      throw new Error('selector must be a non-empty string');
    }
    if (typeof o.value !== 'string') throw new Error('value must be a string');
    return { selector: o.selector.trim(), value: o.value };
  },
};

/** Effectful guard (#4): never perform the action if the grant was pulled. */
function ensureLive(ctx: ToolContext): void {
  if (ctx.signal.aborted || !ctx.isLive()) {
    throw new BrokerError(DenyReason.Revoked, 'revoked before action executed');
  }
}

/**
 * The Act-tier tools: `click` and `fill`. Both are effectful, so both always require
 * approval (the concrete selector/value is shown in the action card) and re-check
 * liveness immediately before acting. `fill` does NOT audit its value (it may be a
 * password); `click` audits its selector (safe + useful for traceability).
 */
export function createActTools(act: ActController): Tool[] {
  const click: Tool<{ selector: string }, ClickResult> = {
    name: 'click',
    description: 'Click a visible element matching a CSS selector.',
    minMode: Mode.Act,
    risk: RiskLevel.Medium,
    requiresApproval: true,
    auditDetail: (input) => input.selector,
    auditResult: (out) => (out.realInput ? 'real input' : undefined),
    inputSchema: clickSchema,
    async handler(input, ctx) {
      ensureLive(ctx);
      return act.click(ctx.tabId, input.selector, undefined, ctx);
    },
  };

  const fill: Tool<{ selector: string; value: string }, FillResult> = {
    name: 'fill',
    description:
      'Type a value into an input matching a CSS selector. Honest: returns filled:false (with a note) if the value did not actually land — e.g. a rich-text editor that ignores direct writes.',
    minMode: Mode.Act,
    risk: RiskLevel.Medium,
    requiresApproval: true,
    // Log WHICH field was filled, never the value (it may be a password).
    auditDetail: (input) => `${input.selector} (value hidden)`,
    auditResult: (out) => (out.realInput ? 'real input' : undefined),
    inputSchema: fillSchema,
    async handler(input, ctx) {
      ensureLive(ctx);
      return act.fill(ctx.tabId, input.selector, input.value, undefined, ctx);
    },
  };

  return [click, fill];
}
