/**
 * Per-tab AI permission modes, as an ordered privilege ladder.
 *
 * A tool declares the minimum mode it needs (`minMode`); the broker grants a call
 * only when the tab's CURRENT mode is at least that level. Default is Blocked.
 *
 * Note: "watch / record" (observing the user's own actions) is a SEPARATE axis
 * added in Phase 5 — it is intentionally not part of this privilege ladder.
 */
export enum Mode {
  Blocked = 'blocked', // no AI access at all (default)
  Read = 'read', // shared view: read_page, screenshot
  Inspect = 'inspect', // + inspect_element, console, network
  Act = 'act', // + click, fill (always behind approval)
  Develop = 'develop', // + run_js (full page control)
}

const ORDER: Record<Mode, number> = {
  [Mode.Blocked]: 0,
  [Mode.Read]: 1,
  [Mode.Inspect]: 2,
  [Mode.Act]: 3,
  [Mode.Develop]: 4,
};

export function modeRank(m: Mode): number {
  return ORDER[m];
}

/** True iff `current` grants at least the privilege required by `required`. */
export function modeAtLeast(current: Mode, required: Mode): boolean {
  return modeRank(current) >= modeRank(required);
}

export const DEFAULT_MODE = Mode.Blocked;
