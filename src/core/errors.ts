/**
 * Reasons the broker refuses a call. Every refusal path FAILS CLOSED (deny on any
 * doubt) — there is no "allow on error". Returned to callers as a structured reason,
 * never as a leaked exception or partial result.
 */
export enum DenyReason {
  UnknownTool = 'unknown_tool',
  PermissionDenied = 'permission_denied', // tab mode below the tool's minMode
  InvalidInput = 'invalid_input', // failed schema validation
  ApprovalRequired = 'approval_required', // needs approval, none available
  ApprovalRejected = 'approval_rejected', // user said no
  Revoked = 'revoked', // session changed/blocked mid-flight
  Timeout = 'timeout', // handler exceeded the time budget
  HandlerError = 'handler_error', // tool threw
}

export class BrokerError extends Error {
  constructor(
    public readonly reason: DenyReason,
    message: string,
  ) {
    super(message);
    this.name = 'BrokerError';
  }
}
