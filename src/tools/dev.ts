import { Mode } from '../core/modes';
import { RiskLevel, Tool, Parser } from '../core/tool';
import { BrokerError, DenyReason } from '../core/errors';

/**
 * Brokered Developer-tier access to the page. Implemented by the main process; kept as an
 * interface so the dev tools stay Electron-free and handlers never touch raw webContents.
 */
export interface DevController {
  /** Execute arbitrary JavaScript in the page and return the result. */
  runJs(tabId: string, script: string): Promise<unknown>;
}

const MAX_SCRIPT = 100_000;

const scriptSchema: Parser<{ script: string }> = {
  parse(raw) {
    if (typeof raw !== 'object' || raw === null || typeof (raw as { script?: unknown }).script !== 'string') {
      throw new Error('expected { script: string }');
    }
    const script = (raw as { script: string }).script;
    if (script.trim().length === 0) throw new Error('script must not be empty');
    if (script.length > MAX_SCRIPT) throw new Error('script too large');
    return { script };
  },
};

/**
 * The Developer-tier tools. `run_js` is FULL page control (can read cookies/session,
 * mutate the DOM, exfiltrate) — so it is its own grant (minMode Develop), it always
 * requires approval (the script is shown in the action card), and the script is audited.
 *
 * As an effectful tool it re-checks liveness immediately before the irreversible step
 * (#4): if the grant was pulled between approval and execution, it does NOT run.
 */
export function createDevTools(dev: DevController): Tool[] {
  const runJs: Tool<{ script: string }, unknown> = {
    name: 'run_js',
    description: 'Run JavaScript in the current page (full page control).',
    minMode: Mode.Develop,
    risk: RiskLevel.High,
    requiresApproval: true,
    auditInput: true, // the script is logged
    inputSchema: scriptSchema,
    async handler(input, ctx) {
      // Pre-gate (#4): never run if the grant was revoked between approval and now.
      if (ctx.signal.aborted || !ctx.isLive()) {
        throw new BrokerError(DenyReason.Revoked, 'revoked before run_js executed');
      }
      return dev.runJs(ctx.tabId, input.script);
    },
  };
  return [runJs];
}
