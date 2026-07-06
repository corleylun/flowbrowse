import { RiskLevel } from './tool';

/**
 * Visual preview for an approval card. Coordinate ("computer use") actions are illegible as text
 * ("click at (412,308)"), so the card shows a page screenshot with a crosshair at the target, letting
 * the human approve WHAT will be acted on, not a number. The image is shown live in the card only —
 * it is NEVER written to the audit log (the audit stores the coordinates + a digest, no page pixels).
 */
export interface ApprovalPreview {
  /** base64 PNG (no data: prefix). */
  readonly image: string;
  /** Image pixel dimensions, so the renderer can place the crosshair proportionally. */
  readonly w: number;
  readonly h: number;
  /** Crosshair point in image pixel space (omitted = no marker, just the page snapshot). */
  readonly x?: number;
  readonly y?: number;
}

export interface ApprovalRequest {
  readonly tabId: string;
  /** Epoch the approval is bound to — if the session changes, the approval is void. */
  readonly epoch: number;
  readonly toolName: string;
  readonly risk: RiskLevel;
  /** Human-readable description of the CONCRETE effect, for the action card. */
  readonly summary: string;
  /** The exact validated input the user is approving. */
  readonly input: unknown;
  /** Optional visual preview (e.g. screenshot + crosshair) for coordinate actions. */
  readonly preview?: ApprovalPreview;
}

export interface ApprovalDecision {
  readonly approved: boolean;
  /**
   * Whether a real decision was made by a user. `false` means no approval mechanism
   * was available and the request was auto-denied by policy (e.g. the default
   * DenyAll, before a UI gate exists) — operationally distinct from an explicit user
   * rejection, and audited differently. Defaults to `true` when omitted.
   */
  readonly available?: boolean;
}

export interface ApprovalProvider {
  request(req: ApprovalRequest): Promise<ApprovalDecision>;
}

/**
 * Default provider: denies everything, and reports `available: false` so the broker
 * audits these as ApprovalRequired (no mechanism) rather than ApprovalRejected (user
 * said no). Fail-closed by construction — until the real UI gate (Phase 3.4) is wired
 * in, NO approval-requiring tool can run.
 */
export class DenyAllApprovalProvider implements ApprovalProvider {
  async request(): Promise<ApprovalDecision> {
    return { approved: false, available: false };
  }
}
