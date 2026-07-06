/**
 * Resolves which tab id a broker call should target: the caller's explicit `tab` override
 * (from `/api/invoke` or an MCP tool call's args) if present, else the active tab.
 *
 * FAILS CLOSED, no silent fallback:
 *  - an unknown `tab` id is rejected here — it must NEVER reach `broker.invoke`, which would
 *    otherwise treat any unseen id as a fresh (Blocked-by-default) session rather than an error;
 *  - a non-string `tab` is rejected the same way;
 *  - any `tab` that differs from the active one is rejected if the human's "Allow agent tab
 *    control" setting is off — and that gate runs BEFORE the existence check, so with the
 *    setting off, known and unknown ids are INDISTINGUISHABLE (same reason, same message).
 *    The reverse order would be an oracle: an agent probing t1, t2, t3… could enumerate and
 *    count the very tabs that setting is meant to hide.
 *
 * A resolved target's own per-tab mode is the ONLY permission gate after this — this module
 * decides WHICH tab, never whether the call is allowed on it (that's the broker's job).
 */

export type TabTargetResult =
  | { ok: true; tabId: string }
  | { ok: false; reason: 'invalid_input' | 'permission_denied'; message: string };

export interface TabTargetOptions {
  /** The raw `tab` field from the call — `undefined` if the caller omitted it entirely. */
  requested: unknown;
  /** The tab that would be targeted if `requested` is absent (zero-regression default). */
  active: () => string;
  /** True if `id` names a currently open tab. */
  isKnownTab: (id: string) => boolean;
  /** The user's "Allow agent tab control" setting — false forbids a non-active target. */
  allowTargeting: () => boolean;
}

export function resolveTabTarget(opts: TabTargetOptions): TabTargetResult {
  if (opts.requested === undefined) {
    return { ok: true, tabId: opts.active() };
  }
  if (typeof opts.requested !== 'string' || opts.requested.trim() === '') {
    return { ok: false, reason: 'invalid_input', message: '"tab" must be a non-empty string' };
  }
  const tabId = opts.requested;
  const active = opts.active();
  // An explicit target equal to the active tab is always fine — it's what a bare call does.
  if (tabId === active) {
    return { ok: true, tabId };
  }
  // Targeting gate FIRST (before existence): with the setting off, known and unknown ids must
  // be indistinguishable, or the error difference enumerates hidden tabs.
  if (!opts.allowTargeting()) {
    return { ok: false, reason: 'permission_denied', message: 'tab targeting disabled by user' };
  }
  if (!opts.isKnownTab(tabId)) {
    return { ok: false, reason: 'invalid_input', message: `unknown tab: ${tabId}` };
  }
  return { ok: true, tabId };
}
