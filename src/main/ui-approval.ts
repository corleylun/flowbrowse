import { ipcMain } from 'electron';
import type { WebContents } from 'electron';
import { ApprovalProvider, ApprovalRequest, ApprovalDecision } from '../core/approval';

/**
 * Routes broker approval requests to the chrome UI as action cards and awaits the
 * user's Approve/Reject. If the UI is unavailable, it reports `available: false` so the
 * broker audits a policy/no-mechanism deny (ApprovalRequired) rather than a user
 * rejection. Used by the Act/Develop tiers (Phase 4); harmless until then.
 *
 * A call may target a background tab (see `resolveTabTarget`) — when it does, the card is
 * labeled with that tab's (privacy-filtered) title so the human isn't approving an effect on a
 * tab they aren't even looking at.
 */
export class UiApprovalProvider implements ApprovalProvider {
  private seq = 0;
  private readonly pending = new Map<number, (d: ApprovalDecision) => void>();

  constructor(
    private readonly chrome: () => WebContents | null,
    /** Notified when the set of open cards becomes non-empty/empty (drives layout). */
    private readonly onPendingChange?: (pending: boolean) => void,
    /** An unanswered card auto-rejects after this long, so the broker never hangs. A function is
     *  re-evaluated per request, so a settings change takes effect without reconstruction. */
    private readonly timeoutMs: number | (() => number) = 120_000,
    /** Returns true to approve without showing a card (the user's per-tab auto-approve). */
    private readonly autoApprove?: (req: ApprovalRequest) => boolean,
    /** The tab currently in the foreground — used only to decide whether an approval card needs
     *  a "Tab: <title>" line (a background-tab call is otherwise illegible: the human might
     *  approve thinking it's the tab they're looking at). Never affects the decision itself. */
    private readonly activeTabId?: () => string,
    /** Privacy-filtered title lookup for the target tab, reusing whatever redaction `list_tabs`
     *  already applies (best-effort, like every other agent-facing read). */
    private readonly tabTitle?: (tabId: string) => string,
  ) {
    ipcMain.handle('ai:approval-response', (_e, payload: { id: number; approved: boolean }) => {
      this.pending.get(payload.id)?.({ approved: payload.approved === true, available: true });
    });
  }

  request(req: ApprovalRequest): Promise<ApprovalDecision> {
    // The user's per-tab auto-approve — resolve immediately, no card (still audited). Auto-approve
    // is a deliberate per-tab opt-in ON TOP of a deliberate mode grant: the human said "I trust
    // this tab, don't ask." We honor that on ANY tab, foreground or background — a background-tab
    // call on an auto-approved tab runs card-less, and the record lives in the audit log / Activity
    // panel (every call is logged with its tab id). Cards that DO show (non-auto-approved tabs) are
    // still labeled with the target tab (see below).
    if (this.autoApprove?.(req)) {
      return Promise.resolve({ approved: true, available: true });
    }
    const chrome = this.chrome();
    if (!chrome || chrome.isDestroyed()) {
      return Promise.resolve({ approved: false, available: false });
    }
    const id = ++this.seq;
    // Label the card ONLY when the target differs from the foreground tab right now — the
    // common case (active-tab calls) stays exactly as it looked before this feature.
    const targetTab =
      this.activeTabId && this.tabTitle && this.activeTabId() !== req.tabId
        ? this.tabTitle(req.tabId)
        : undefined;
    return new Promise<ApprovalDecision>((resolve) => {
      const settle = (decision: ApprovalDecision): void => {
        if (!this.pending.has(id)) return; // already settled
        this.pending.delete(id);
        clearTimeout(timer);
        if (this.pending.size === 0) this.onPendingChange?.(false);
        this.chrome()?.send('ai:approval-close', { id });
        resolve(decision);
      };
      const ms = typeof this.timeoutMs === 'function' ? this.timeoutMs() : this.timeoutMs;
      const timer = setTimeout(() => settle({ approved: false, available: true }), ms);
      this.pending.set(id, settle);
      if (this.pending.size === 1) this.onPendingChange?.(true);
      chrome.send('ai:approval-request', {
        id,
        toolName: req.toolName,
        risk: req.risk,
        summary: req.summary,
        input: req.input,
        preview: req.preview,
        targetTab,
      });
    });
  }
}
