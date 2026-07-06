import { Mode } from '../core/modes';
import { RiskLevel, Tool, Parser, ToolContext } from '../core/tool';

const emptySchema: Parser<Record<string, never>> = {
  parse(raw) {
    if (raw == null) return {};
    if (typeof raw !== 'object') throw new Error('expected no input ({} )');
    return {};
  },
};

/**
 * `get_mode` — lets the agent READ the active tab's current permission mode instead of inferring it
 * from `permission_denied`. It is **off the permission ladder** (`minMode: Blocked`) so the agent can
 * always check (even when the tab is Off — e.g. right after a relaunch, when every tab resets to Off
 * with no other signal). It is strictly read-only: it reveals only the user's own per-tab UI setting
 * (no page/session/cookie data) and cannot change the mode — only the human's UI can. No approval.
 *
 * `getMode` is injected (the broker hands handlers a minimal ToolContext, not the SessionManager).
 */
export function createStatusTools(getMode: (tabId: string) => Mode): Tool[] {
  const getModeTool: Tool<Record<string, never>, { tab: string; mode: Mode }> = {
    name: 'get_mode',
    description:
      "Read the active tab's current AI permission mode (blocked/read/inspect/act/develop). Read-only — you cannot change it (only the user can, in the UI). Use this to know what you're allowed to do instead of guessing from denials, e.g. after a relaunch resets tabs to Off.",
    minMode: Mode.Blocked,
    risk: RiskLevel.Low,
    requiresApproval: false,
    inputSchema: emptySchema,
    async handler(_input, ctx: ToolContext) {
      return { tab: ctx.tabId, mode: getMode(ctx.tabId) };
    },
  };
  return [getModeTool];
}
