import { Mode } from '../core/modes';
import { RiskLevel, Tool, Parser, ToolContext } from '../core/tool';
import { BrokerError, DenyReason } from '../core/errors';
import { ApprovalPreview } from '../core/approval';
import { Liveness } from './act';

/**
 * "Computer use" coordinate tools: the agent reads a screenshot, decides a point, and SafeCoBrowser
 * delivers REAL isTrusted input there (sendInputEvent) — for canvas/WebGL apps and pages with no
 * stable DOM where selector-based click/fill can't find the target. Coordinates are CSS viewport
 * pixels (origin = top-left of the page content). These are NOT a humanization/evasion layer: real
 * trusted input only, no curves, no jitter. Each is Act-tier and approval-gated, and the approval
 * card shows a screenshot with a crosshair on the target (built via the tool's `preview` hook) so a
 * coordinate action stays legible to the human and the audit.
 */
export interface CoordResult {
  done: boolean;
  /** Short hint when done is false (e.g. out of viewport), or context. Never sensitive. */
  note?: string;
  /** Always true for these tools — they are inherently real isTrusted input. */
  realInput?: boolean;
}

export interface CoordinateController {
  moveTo(tabId: string, x: number, y: number, live?: Liveness): Promise<CoordResult>;
  clickAt(tabId: string, x: number, y: number, button: 'left' | 'right', live?: Liveness): Promise<CoordResult>;
  scrollAt(tabId: string, x: number, y: number, dy: number, dx: number, live?: Liveness): Promise<CoordResult>;
  pressKey(tabId: string, key: string, live?: Liveness): Promise<CoordResult>;
  typeText(tabId: string, text: string, live?: Liveness): Promise<CoordResult>;
}

/** Bare keys only — NO modifier chords, NO app/devtools accelerators (those could fire menu items
 *  or open devtools). A coordinate agent gets navigation/editing keys, nothing that escapes the page. */
export const ALLOWED_KEYS = new Set<string>([
  'Enter', 'Tab', 'Escape', 'Backspace', 'Delete',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'Home', 'End', 'PageUp', 'PageDown', 'Space',
]);

const MAX_COORD = 100_000; // generous upper bound; the controller clamps to the live viewport
const MAX_TEXT = 10_000;

function num(v: unknown, name: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`${name} must be a finite number`);
  return v;
}
function coordPair(o: { x?: unknown; y?: unknown }): { x: number; y: number } {
  const x = num(o.x, 'x'), y = num(o.y, 'y');
  if (x < 0 || y < 0 || x > MAX_COORD || y > MAX_COORD) throw new Error('x/y out of range');
  return { x: Math.round(x), y: Math.round(y) };
}

const moveSchema: Parser<{ x: number; y: number }> = {
  parse(raw) {
    if (typeof raw !== 'object' || raw === null) throw new Error('expected { x, y }');
    return coordPair(raw as { x?: unknown; y?: unknown });
  },
};

const clickSchema: Parser<{ x: number; y: number; button: 'left' | 'right' }> = {
  parse(raw) {
    if (typeof raw !== 'object' || raw === null) throw new Error('expected { x, y, button? }');
    const o = raw as { x?: unknown; y?: unknown; button?: unknown };
    const { x, y } = coordPair(o);
    let button: 'left' | 'right' = 'left';
    if (o.button !== undefined) {
      if (o.button !== 'left' && o.button !== 'right') throw new Error("button must be 'left' or 'right'");
      button = o.button;
    }
    return { x, y, button };
  },
};

const scrollSchema: Parser<{ x: number; y: number; dy: number; dx: number }> = {
  parse(raw) {
    if (typeof raw !== 'object' || raw === null) throw new Error('expected { x, y, dy, dx? }');
    const o = raw as { x?: unknown; y?: unknown; dy?: unknown; dx?: unknown };
    const { x, y } = coordPair(o);
    const dy = num(o.dy, 'dy');
    const dx = o.dx === undefined ? 0 : num(o.dx, 'dx');
    return { x, y, dy: Math.round(dy), dx: Math.round(dx) };
  },
};

const keySchema: Parser<{ key: string }> = {
  parse(raw) {
    const o = raw as { key?: unknown };
    if (typeof raw !== 'object' || raw === null || typeof o.key !== 'string') {
      throw new Error('expected { key: string }');
    }
    const key = o.key.trim();
    if (!ALLOWED_KEYS.has(key)) {
      throw new Error(`key must be one of: ${[...ALLOWED_KEYS].join(', ')}`);
    }
    return { key };
  },
};

const textSchema: Parser<{ text: string }> = {
  parse(raw) {
    const o = raw as { text?: unknown };
    if (typeof raw !== 'object' || raw === null || typeof o.text !== 'string') {
      throw new Error('expected { text: string }');
    }
    if (o.text.length === 0) throw new Error('text must not be empty');
    if (o.text.length > MAX_TEXT) throw new Error('text too large');
    return { text: o.text };
  },
};

function ensureLive(ctx: ToolContext): void {
  if (ctx.signal.aborted || !ctx.isLive()) {
    throw new BrokerError(DenyReason.Revoked, 'revoked before action executed');
  }
}

/**
 * The coordinate (computer-use) tools. All Act-tier, Medium risk, approval-required, and real input.
 * `preview` (used by the broker before approval) attaches a screenshot + crosshair so the human sees
 * WHERE the action lands — coordinate actions are otherwise illegible to the approval/audit layer.
 * `type_text` audits a character COUNT, never the text (it may be a secret).
 */
export interface CoordPreviewer {
  /** Screenshot + marker for the approval card. Marker omitted for non-point actions. */
  previewAt(tabId: string, x?: number, y?: number): Promise<ApprovalPreview | undefined>;
}

export function createCoordinateTools(ctrl: CoordinateController, preview: CoordPreviewer): Tool[] {
  const realInput = (out: CoordResult): string | undefined => (out.realInput ? 'real input' : undefined);

  const moveTo: Tool<{ x: number; y: number }, CoordResult> = {
    name: 'move_to',
    description: 'Move the mouse cursor to a viewport coordinate (CSS pixels, real input).',
    minMode: Mode.Act,
    risk: RiskLevel.Medium,
    requiresApproval: true,
    auditDetail: (i) => `(${i.x}, ${i.y})`,
    auditResult: realInput,
    inputSchema: moveSchema,
    async handler(i, ctx) {
      ensureLive(ctx);
      return ctrl.moveTo(ctx.tabId, i.x, i.y, ctx);
    },
  };

  const clickAt: Tool<{ x: number; y: number; button: 'left' | 'right' }, CoordResult> = {
    name: 'click_at',
    description: 'Click at a viewport coordinate (CSS pixels) with real, trusted mouse input.',
    minMode: Mode.Act,
    risk: RiskLevel.Medium,
    requiresApproval: true,
    auditDetail: (i) => `${i.button} (${i.x}, ${i.y})`,
    auditResult: realInput,
    inputSchema: clickSchema,
    async handler(i, ctx) {
      ensureLive(ctx);
      return ctrl.clickAt(ctx.tabId, i.x, i.y, i.button, ctx);
    },
  };

  const scroll: Tool<{ x: number; y: number; dy: number; dx: number }, CoordResult> = {
    name: 'scroll',
    description: 'Scroll by a wheel delta at a viewport coordinate (real input).',
    minMode: Mode.Act,
    risk: RiskLevel.Medium,
    requiresApproval: true,
    auditDetail: (i) => `(${i.x}, ${i.y}) dy=${i.dy} dx=${i.dx}`,
    auditResult: realInput,
    inputSchema: scrollSchema,
    async handler(i, ctx) {
      ensureLive(ctx);
      return ctrl.scrollAt(ctx.tabId, i.x, i.y, i.dy, i.dx, ctx);
    },
  };

  const pressKey: Tool<{ key: string }, CoordResult> = {
    name: 'press_key',
    description: 'Press a single key (Enter, Tab, Escape, arrows, etc.) as real input. No modifier chords.',
    minMode: Mode.Act,
    risk: RiskLevel.Medium,
    requiresApproval: true,
    auditDetail: (i) => i.key,
    auditResult: realInput,
    inputSchema: keySchema,
    async handler(i, ctx) {
      ensureLive(ctx);
      return ctrl.pressKey(ctx.tabId, i.key, ctx);
    },
  };

  const typeText: Tool<{ text: string }, CoordResult> = {
    name: 'type_text',
    description: 'Type text at the currently focused field as real per-character key input.',
    minMode: Mode.Act,
    risk: RiskLevel.Medium,
    requiresApproval: true,
    // Value-hidden: the text may be a secret. Log only a character count, like fill.
    auditDetail: (i) => `${i.text.length} chars (value hidden)`,
    auditResult: realInput,
    inputSchema: textSchema,
    async handler(i, ctx) {
      ensureLive(ctx);
      return ctrl.typeText(ctx.tabId, i.text, ctx);
    },
  };

  // Wire approval previews: point tools show a crosshair; key/type show the current page (no marker).
  (moveTo as Tool).preview = (i: unknown, tabId: string) => preview.previewAt(tabId, (i as { x: number }).x, (i as { y: number }).y);
  (clickAt as Tool).preview = (i: unknown, tabId: string) => preview.previewAt(tabId, (i as { x: number }).x, (i as { y: number }).y);
  (scroll as Tool).preview = (i: unknown, tabId: string) => preview.previewAt(tabId, (i as { x: number }).x, (i as { y: number }).y);
  (pressKey as Tool).preview = (_i: unknown, tabId: string) => preview.previewAt(tabId);
  (typeText as Tool).preview = (_i: unknown, tabId: string) => preview.previewAt(tabId);

  return [moveTo, clickAt, scroll, pressKey, typeText];
}
