import { modeAtLeast } from './modes';
import { BrokerError, DenyReason } from './errors';
import { ToolContext, ToolRegistry } from './tool';
import { SessionManager } from './session';
import { ApprovalProvider } from './approval';
import { AuditOutcome, AuditSink } from './audit';

export interface InvokeResult<O = unknown> {
  ok: boolean;
  output?: O;
  reason?: DenyReason;
  message?: string;
}

const DEFAULT_HANDLER_TIMEOUT_MS = 30_000;

/** Stringify a tool input for the audit (used only when a tool opts in via auditInput). */
function safeInputDetail(input: unknown): string {
  try {
    const s = typeof input === 'string' ? input : JSON.stringify(input);
    return s.length > 2000 ? `${s.slice(0, 2000)}…(truncated)` : s;
  } catch {
    return '[unserializable input]';
  }
}

/** Rejects with the signal's abort reason (a BrokerError) when the signal aborts. */
function rejectOnAbort(signal: AbortSignal): Promise<never> {
  return new Promise<never>((_resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}

/**
 * The Broker is the SINGLE chokepoint for every AI tool call — from the MCP server,
 * the CLI, or any future caller. There is no other path to a tool handler.
 *
 * Cardinal rule: FAIL CLOSED. An unknown tool, insufficient mode, invalid input,
 * missing/rejected approval, mid-flight revocation, or a handler throwing all result
 * in denial — never a pass-through and never a partial result. Tools never touch raw
 * DOM/cookies/session; they receive only the minimal brokered ToolContext.
 *
 * Order of checks (each gate can only deny, never escalate):
 *   1. tool exists
 *   2. tab mode >= tool.minMode
 *   3. input validates against the tool's schema
 *   4. approval (if required), bound to the current epoch
 *   5. execute, then re-check the epoch — discard the result if anything changed
 */
export class Broker {
  private readonly handlerTimeoutMs: number;

  constructor(
    private readonly registry: ToolRegistry,
    private readonly sessions: SessionManager,
    private readonly approvals: ApprovalProvider,
    private readonly audit: AuditSink,
    opts: { handlerTimeoutMs?: number } = {},
  ) {
    this.handlerTimeoutMs = opts.handlerTimeoutMs ?? DEFAULT_HANDLER_TIMEOUT_MS;
  }

  async invoke<O = unknown>(tabId: string, toolName: string, rawInput: unknown): Promise<InvokeResult<O>> {
    // Snapshot used for the permission decision and the audit record.
    const session = this.sessions.get(tabId);

    try {
      const tool = this.registry.get(toolName);
      if (!tool) {
        throw new BrokerError(DenyReason.UnknownTool, `unknown tool: ${toolName}`);
      }

      // 1. Permission: the tab's CURRENT mode must satisfy the tool's minMode.
      if (!modeAtLeast(session.mode, tool.minMode)) {
        throw new BrokerError(
          DenyReason.PermissionDenied,
          `${toolName} requires ${tool.minMode}, tab is ${session.mode}`,
        );
      }

      // 2. Validate input (parse-or-throw → fail closed on anything malformed).
      let input: unknown;
      try {
        input = tool.inputSchema.parse(rawInput);
      } catch (e) {
        throw new BrokerError(
          DenyReason.InvalidInput,
          e instanceof Error ? e.message : 'invalid input',
        );
      }

      // 3. Approval (single-use, bound to this epoch).
      if (tool.requiresApproval) {
        // Optional visual preview (e.g. coordinate crosshair). Fail-safe: a preview error must
        // never block the approval — we just show the card without it.
        let preview;
        if (tool.preview) {
          try {
            preview = await tool.preview(input, tabId);
          } catch {
            preview = undefined;
          }
          // The grant must still be live after the (async) preview capture.
          if (this.sessions.get(tabId).epoch !== session.epoch) {
            throw new BrokerError(DenyReason.Revoked, 'session changed during preview');
          }
        }
        const decision = await this.approvals.request({
          tabId,
          epoch: session.epoch,
          toolName,
          risk: tool.risk,
          summary: tool.description,
          input,
          preview,
        });
        // The grant must not have changed while we waited on the human.
        if (this.sessions.get(tabId).epoch !== session.epoch) {
          throw new BrokerError(DenyReason.Revoked, 'session changed during approval');
        }
        if (!decision.approved) {
          // Distinguish an explicit user rejection from a policy/no-mechanism deny
          // (e.g. the default DenyAll provider) so the audit is meaningful.
          if (decision.available === false) {
            throw new BrokerError(DenyReason.ApprovalRequired, 'no approval mechanism available');
          }
          throw new BrokerError(DenyReason.ApprovalRejected, 'rejected by user');
        }
      }

      // 4. Execute under an abort signal tied to revocation + a timeout. The signal lets
      //    an effectful handler bail *before* its irreversible step, and the timeout stops
      //    a hung/hostile handler from wedging the call. Capturing the epoch also detects
      //    mid-flight revocation for the post-execution result discard.
      const startEpoch = session.epoch;
      const controller = new AbortController();
      const ctx: ToolContext = {
        tabId,
        epoch: startEpoch,
        isLive: () => this.sessions.get(tabId).epoch === startEpoch,
        signal: controller.signal,
      };
      const unsubscribe = this.sessions.onChange((s) => {
        if (s.tabId === tabId && s.epoch !== startEpoch && !controller.signal.aborted) {
          controller.abort(new BrokerError(DenyReason.Revoked, 'session revoked during execution'));
        }
      });
      const timer = setTimeout(() => {
        if (!controller.signal.aborted) {
          controller.abort(new BrokerError(DenyReason.Timeout, 'tool handler timed out'));
        }
      }, this.handlerTimeoutMs);

      let output: O;
      try {
        const handlerPromise = tool.handler(input, ctx);
        // Swallow a late handler rejection if the abort wins the race (no unhandled rejection).
        handlerPromise.catch(() => undefined);
        output = (await Promise.race([handlerPromise, rejectOnAbort(controller.signal)])) as O;
      } finally {
        clearTimeout(timer);
        unsubscribe();
      }

      // The abort (timeout or revoke) wins authoritatively — even if a hostile handler
      // resolved synchronously inside its own abort listener and won the race.
      if (controller.signal.aborted) {
        throw controller.signal.reason;
      }

      // 5. Liveness re-check: if the grant changed while running, discard the result.
      if (this.sessions.get(tabId).epoch !== startEpoch) {
        throw new BrokerError(DenyReason.Revoked, 'session revoked during execution');
      }

      // A redactor (auditDetail) wins; else log the full input only if the tool opts in.
      let allowedDetail: string | undefined;
      if (tool.auditDetail) {
        try {
          allowedDetail = String(tool.auditDetail(input)).slice(0, 2000);
        } catch {
          allowedDetail = '[audit detail error]';
        }
      } else if (tool.auditInput) {
        allowedDetail = safeInputDetail(input);
      }
      // Append an output-derived suffix (e.g. "[real input]") — facts only known post-execution.
      if (tool.auditResult) {
        try {
          const extra = tool.auditResult(output);
          if (extra) allowedDetail = (allowedDetail ? `${allowedDetail} ` : '') + `[${extra}]`;
        } catch {
          /* never let an audit annotation fail the call */
        }
      }
      this.log(session, toolName, 'allowed', undefined, allowedDetail);
      return { ok: true, output };
    } catch (err) {
      const reason = err instanceof BrokerError ? err.reason : DenyReason.HandlerError;
      const outcome: AuditOutcome =
        reason === DenyReason.HandlerError || reason === DenyReason.Timeout ? 'error' : 'denied';
      const detail = err instanceof Error ? err.message : String(err);

      // (#1) On a mid-flight revoke the top-of-call snapshot is stale — log the LIVE
      // session so the audit shows the grant was actually pulled, not the old grant.
      const logState = reason === DenyReason.Revoked ? this.sessions.get(tabId) : session;
      this.log(logState, toolName, outcome, reason, detail);

      // (#5) Never surface raw handler/exception text to the caller — a thrown
      // handler error could carry internal paths/secrets, and external callers
      // (MCP/CLI agents) must not see it. Full detail stays in the audit only.
      // Our own BrokerError messages are authored and safe to return.
      const callerMessage = reason === DenyReason.HandlerError ? 'tool handler failed' : detail;
      return { ok: false, reason, message: callerMessage };
    }
  }

  private log(
    session: { tabId: string; mode: string; epoch: number },
    toolName: string,
    outcome: AuditOutcome,
    reason?: DenyReason,
    detail?: string,
  ): void {
    this.audit.record({
      ts: Date.now(),
      tabId: session.tabId,
      toolName,
      mode: session.mode,
      epoch: session.epoch,
      outcome,
      reason,
      detail,
    });
  }
}
