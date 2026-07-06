import { Mode, DEFAULT_MODE } from './modes';

export interface SessionState {
  readonly tabId: string;
  readonly mode: Mode;
  readonly epoch: number;
}

export type SessionListener = (state: SessionState) => void;

/**
 * Authoritative per-tab AI session state.
 *
 * The epoch is a monotonic counter that bumps on EVERY change — mode change,
 * block, or revoke. The broker captures the epoch and re-checks the live value at
 * execution time, so "Stop AI" / "Block tab" instantly invalidates any in-flight
 * or pending call. This is what makes revocation *real* rather than cosmetic.
 *
 * An unseen tab is Blocked by default (epoch 0) — AI is off until explicitly invited.
 */
export class SessionManager {
  private readonly sessions = new Map<string, SessionState>();
  private readonly listeners = new Set<SessionListener>();
  private epochCounter = 0;

  /** Current state for a tab; defaults to Blocked if the tab is unseen. */
  get(tabId: string): SessionState {
    return this.sessions.get(tabId) ?? { tabId, mode: DEFAULT_MODE, epoch: 0 };
  }

  /**
   * Set a tab's mode. ALWAYS bumps the epoch — even a no-op set (e.g. Blocked→Blocked)
   * is treated as a fresh revocation so any concurrent call is invalidated.
   */
  setMode(tabId: string, mode: Mode): SessionState {
    const next: SessionState = { tabId, mode, epoch: ++this.epochCounter };
    this.sessions.set(tabId, next);
    this.emit(next);
    return next;
  }

  /** Revoke all AI access for a tab (Stop AI / Block). */
  revoke(tabId: string): SessionState {
    return this.setMode(tabId, Mode.Blocked);
  }

  /**
   * Remove a tab's session entry entirely (the tab is gone). No event is emitted —
   * nothing observes a closed tab. Revoke first if there may be an in-flight call.
   */
  delete(tabId: string): void {
    this.sessions.delete(tabId);
  }

  /** Subscribe to session changes (drives the permission indicator UI). */
  onChange(listener: SessionListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(state: SessionState): void {
    for (const l of this.listeners) {
      // A misbehaving listener must never break the session core.
      try {
        l(state);
      } catch {
        /* swallow */
      }
    }
  }
}
