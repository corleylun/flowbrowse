import { DenyReason } from './errors';

export type AuditOutcome = 'allowed' | 'denied' | 'error';

/**
 * One brokered decision. This is the seed of the auditable log (Phase 6 makes it
 * durable + exportable). NEVER put secrets here — inputs must already be masked
 * upstream before they reach the broker.
 */
export interface AuditEvent {
  readonly ts: number;
  readonly tabId: string;
  readonly toolName: string;
  readonly mode: string;
  readonly epoch: number;
  readonly outcome: AuditOutcome;
  readonly reason?: DenyReason;
  readonly detail?: string;
}

export interface AuditSink {
  record(event: AuditEvent): void;
}

/** Minimal sink for Phase 1. Phase 6 replaces this with durable, exportable storage. */
export class ConsoleAuditSink implements AuditSink {
  record(event: AuditEvent): void {
    console.log('[audit]', JSON.stringify(event));
  }
}

/** Collects events in memory — used by tests and (soon) the UI activity log. */
export class MemoryAuditSink implements AuditSink {
  readonly events: AuditEvent[] = [];
  record(event: AuditEvent): void {
    this.events.push(event);
  }
}
