export * from './modes';
export * from './errors';
export * from './tool';
export * from './session';
export * from './approval';
export * from './audit';
export * from './broker';

import { ToolRegistry } from './tool';
import { SessionManager } from './session';
import { ApprovalProvider, DenyAllApprovalProvider } from './approval';
import { AuditSink, ConsoleAuditSink } from './audit';
import { Broker } from './broker';

export interface Core {
  registry: ToolRegistry;
  sessions: SessionManager;
  broker: Broker;
}

export interface CoreOptions {
  /** Defaults to fail-closed DenyAll until a real UI gate is provided. */
  approvals?: ApprovalProvider;
  audit?: AuditSink;
}

/**
 * Construct the security core. This is the foundation everything else hangs off:
 *   - tools are registered onto `registry` (Phase 3+)
 *   - the MCP server and CLI call `broker.invoke` (Phase 2)
 *   - the real approval UI and a durable audit sink replace the defaults (Phase 3.4 / 6)
 *
 * Defaults are fail-closed: DenyAll approval means no approval-requiring tool runs
 * until a real UI gate exists.
 */
export function createCore(opts: CoreOptions = {}): Core {
  const registry = new ToolRegistry();
  const sessions = new SessionManager();
  const approvals = opts.approvals ?? new DenyAllApprovalProvider();
  const audit = opts.audit ?? new ConsoleAuditSink();
  const broker = new Broker(registry, sessions, approvals, audit);
  return { registry, sessions, broker };
}
