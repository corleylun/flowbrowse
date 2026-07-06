import { Mode } from '../core/modes';
import { RiskLevel, Tool, Parser, ToolContext } from '../core/tool';

/** One entry returned by `list_tabs`. `title`/`url` are already privacy-redacted by the host. */
export interface TabInfo {
  tab: string;
  active: boolean;
  mode: Mode;
  title: string;
  url: string;
}

/** Outcome of a `switch_tab` request — non-throwing so the agent gets a clear, structured answer. */
export interface SwitchResult {
  switched: boolean;
  tab?: string;
  reason?: string;
}

/**
 * Host-provided tab operations. The broker hands handlers only a minimal ToolContext (no tab model,
 * no Electron), so the main process injects these closures — exactly like `getMode` for `get_mode`.
 *
 *  - `list()` returns the tabs the agent is allowed to see (all tabs when the user's
 *    `agentTabControl` setting is on; just the active tab when off), titles/URLs already redacted.
 *  - `switchTo(id)` brings a tab to the foreground IF the setting allows AND the tab exists; it
 *    never changes any tab's permission mode (each tab stays gated by its own grant).
 */
export interface TabToolDeps {
  list: () => TabInfo[];
  switchTo: (id: string) => SwitchResult;
}

const emptySchema: Parser<Record<string, never>> = {
  parse(raw) {
    if (raw == null) return {};
    if (typeof raw !== 'object') throw new Error('expected no input ({} )');
    return {};
  },
};

const switchSchema: Parser<{ tab: string }> = {
  parse(raw) {
    if (!raw || typeof raw !== 'object') throw new Error('expected { tab: string }');
    const tab = (raw as { tab?: unknown }).tab;
    if (typeof tab !== 'string' || tab.trim() === '') throw new Error('"tab" must be a non-empty string');
    return { tab: tab.trim() };
  },
};

/**
 * `list_tabs` + `switch_tab` — let the agent see the open tabs and move the foreground between them.
 *
 * Both are **off the permission ladder** (`minMode: Blocked`): they aren't page operations on the
 * current tab, so — like `get_mode` — the agent can call them at any mode. The real controls are:
 *  1. the user's **Allow agent tab control** setting (default on; off → list shows only the active
 *     tab and switch is denied), enforced inside the injected closures, and
 *  2. the **per-tab mode** — switching to a tab does NOT grant the agent anything; if that tab is
 *     Off the agent still reads/acts nothing there. Switching only re-targets among tabs the user
 *     has already set up. Neither tool can change a tab's mode (only the human's UI can).
 *
 * No approval (the user chose frictionless switching); every call is still audit-logged.
 */
export function createTabTools(deps: TabToolDeps): Tool[] {
  const listTabs: Tool<Record<string, never>, { tabs: TabInfo[] }> = {
    name: 'list_tabs',
    description:
      "List the browser's open tabs — each with its id, whether it's active, its AI permission mode, and its (privacy-filtered) title and URL. Use this to find another tab before switch_tab. If the user has disabled agent tab control, only the active tab is returned.",
    minMode: Mode.Blocked,
    risk: RiskLevel.Low,
    requiresApproval: false,
    inputSchema: emptySchema,
    async handler(_input, _ctx: ToolContext) {
      return { tabs: deps.list() };
    },
  };

  const switchTab: Tool<{ tab: string }, SwitchResult> = {
    name: 'switch_tab',
    description:
      "Bring another tab to the foreground by its id (from list_tabs); subsequent tool calls then target that tab. Does NOT change any tab's permission mode — a tab that is Off still exposes nothing after switching. Returns { switched, tab?, reason? }; switched is false (with a reason) if the user disabled tab control or the id doesn't exist. You cannot open or close tabs.",
    minMode: Mode.Blocked,
    risk: RiskLevel.Low,
    requiresApproval: false,
    auditDetail: (input) => `→ ${input.tab}`,
    inputSchema: switchSchema,
    async handler(input, _ctx: ToolContext) {
      return deps.switchTo(input.tab);
    },
  };

  return [listTabs, switchTab];
}
