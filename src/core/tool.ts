import { Mode } from './modes';
import type { ApprovalPreview } from './approval';

export enum RiskLevel {
  Low = 'low',
  Medium = 'medium',
  High = 'high',
}

/**
 * Parse-or-throw validator for a tool's input. Intentionally the same shape as
 * zod's `.parse`, so a hand-written parser now can be swapped for a zod schema
 * later without touching the broker. MUST throw on invalid input (→ fail closed).
 */
export interface Parser<T> {
  parse(raw: unknown): T;
}

/**
 * Capabilities handed to a tool handler. Deliberately minimal: a handler NEVER
 * receives raw DOM, cookies, or session — only this brokered context. Page access
 * arrives as additional brokered methods in Phase 3, still mediated by the broker.
 */
export interface ToolContext {
  readonly tabId: string;
  /** The session epoch captured when execution began. */
  readonly epoch: number;
  /** False once the grant has been revoked/changed — long handlers should bail. */
  isLive(): boolean;
  /**
   * Aborts when the grant is revoked (epoch change) or the call times out.
   * EFFECTFUL handlers (click/fill/run_js) MUST check `isLive()` / `signal.aborted`
   * immediately before any irreversible step, so a mid-flight revoke prevents the
   * action itself — not merely the discarding of its result.
   */
  readonly signal: AbortSignal;
}

export interface Tool<I = unknown, O = unknown> {
  readonly name: string;
  readonly description: string;
  readonly minMode: Mode;
  readonly risk: RiskLevel;
  /** If true, every invocation needs explicit, single-use user approval. */
  readonly requiresApproval: boolean;
  /**
   * If true, the broker records this tool's input in the audit log (e.g. run_js
   * scripts). Default false — inputs may contain secrets and are NOT audited by default.
   */
  readonly auditInput?: boolean;
  /**
   * Optional redactor: returns the audit detail for an allowed call (e.g. the fill
   * selector WITHOUT its value). Takes precedence over `auditInput`, so a tool can log
   * *what* it touched without logging sensitive input.
   */
  auditDetail?(input: I): string;
  /**
   * Optional suffix derived from the tool's OUTPUT (not its input), appended to the audit detail
   * of an allowed call. Use for facts only known after execution — e.g. whether click/fill was
   * driven by real isTrusted input. Must never return sensitive data (the input redaction still
   * applies to `auditDetail`). Return undefined to add nothing.
   */
  auditResult?(output: O): string | undefined;
  /**
   * Optional: build a visual preview for the approval card BEFORE the action runs (e.g. a
   * screenshot with a crosshair at a coordinate target). Called by the broker when approval is
   * required. Must be read-only and fail-safe — if it throws, the broker proceeds without a preview
   * rather than blocking the approval. Never include sensitive data; the preview is shown live, not
   * audited.
   */
  preview?(input: I, tabId: string): Promise<ApprovalPreview | undefined>;
  readonly inputSchema: Parser<I>;
  handler(input: I, ctx: ToolContext): Promise<O>;
}

/**
 * Registry of the built-in tools. Lookups for unknown names return undefined so
 * the broker can fail closed. Duplicate registration is a programming error.
 */
export class ToolRegistry {
  private readonly tools = new Map<string, Tool<any, any>>();

  register(tool: Tool<any, any>): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`duplicate tool registration: ${tool.name}`);
    }
    this.tools.set(tool.name, tool);
  }

  get(name: string): Tool<any, any> | undefined {
    return this.tools.get(name);
  }

  list(): readonly Tool<any, any>[] {
    return [...this.tools.values()];
  }
}
