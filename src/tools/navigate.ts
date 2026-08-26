import { Mode } from '../core/modes';
import { RiskLevel, Tool, Parser } from '../core/tool';
import { BrokerError, DenyReason } from '../core/errors';
import { Liveness } from './act';
// Pure, Electron-free URL predicate shared with the human address bar. Imported rather than
// re-implemented: scheme-defaulting is security-relevant, and two copies would drift.
import { isLocalHost } from '../main/nav';

export interface NavigateResult {
  ok: boolean;
  /** The COMMITTED url after redirects on success; the requested url on failure. */
  url: string;
  /** Page title once loaded (may be empty for a page that sets it late). */
  title?: string;
  /** Short, non-sensitive failure context (e.g. 'ERR_NAME_NOT_RESOLVED'). */
  note?: string;
}

/** Brokered top-level navigation of one tab (Electron-free interface; no raw webContents). */
export interface NavigateController {
  navigate(tabId: string, url: string, live?: Liveness): Promise<NavigateResult>;
}

const MAX_URL = 2048;

/**
 * Validate + normalize an agent-supplied navigation target.
 *
 * SECURITY — this is the tool's real boundary, so it fails closed on anything but http(s):
 *  - `file:` would turn a Read-tier grant into a filesystem read, and the browser profile
 *    directory / cookie DB is off-limits to the agent by design — a core security rule;
 *  - `javascript:` would be `run_js` through the back door, bypassing the Develop grant that
 *    exists precisely to gate script execution;
 *  - `data:` / `chrome:` / any other scheme is refused for the same "no side doors" reason.
 * A non-http(s) scheme is rejected EXPLICITLY (invalid_input naming the scheme) rather than
 * silently coerced — the human address bar turns junk into a web search, which would be a
 * dishonest answer to an agent that asked for something specific.
 *
 * Embedded credentials (`https://bank.com@evil.com/`) are refused too: that URL reads as
 * bank.com to a human skimming the approval card but navigates to evil.com, and a card the
 * human misreads is not consent.
 *
 * Scheme-less input is accepted for convenience and defaults to https, except a localhost-family
 * host or an explicit `:port` (almost always a local dev server), which default to http — the
 * same rule the address bar uses.
 */
export function parseNavigationUrl(raw: string): string {
  const s = raw.trim();
  if (s === '') throw new Error('url must not be empty');
  if (s.length > MAX_URL) throw new Error(`url must be at most ${MAX_URL} characters`);
  // Control characters are never legal in a URL and can smuggle a second line past a naive
  // prefix check (header/scheme splitting). Reject rather than strip.
  if (/[\u0000-\u001f\u007f]/.test(s)) throw new Error('url must not contain control characters');

  // Find a scheme, being careful that `example.com:8080/p` is a host:port, NOT a scheme.
  const colon = s.indexOf(':');
  const slash = s.indexOf('/');
  let hasScheme = false;
  if (colon > 0 && (slash === -1 || colon < slash)) {
    const scheme = s.slice(0, colon);
    const rest = s.slice(colon + 1);
    const isPort = /^\d+(?:$|[/?#])/.test(rest);
    if (!isPort) {
      if (!/^https?$/i.test(scheme)) {
        throw new Error(`only http and https urls are allowed (got "${scheme}:")`);
      }
      hasScheme = true;
    }
  }

  const candidate = hasScheme ? s : defaultScheme(s) + s;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error('not a valid url');
  }
  // Belt-and-suspenders: whatever the parse did, only http(s) leaves this function.
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('only http and https urls are allowed');
  }
  if (!parsed.hostname) throw new Error('url must have a host');
  if (parsed.username || parsed.password) {
    throw new Error('url must not embed credentials (user:pass@host)');
  }
  return parsed.toString();
}

/** http:// for the localhost family and anything with an explicit port; https:// otherwise. */
function defaultScheme(s: string): string {
  const authority = s.split(/[/?#]/, 1)[0];
  const portMatch = authority.match(/^(.*):(\d+)$/);
  const host = portMatch ? portMatch[1] : authority;
  return portMatch || isLocalHost(host) ? 'http://' : 'https://';
}

const navigateSchema: Parser<{ url: string }> = {
  parse(raw) {
    if (typeof raw !== 'object' || raw === null) throw new Error('expected { url: string }');
    const o = raw as { url?: unknown };
    if (typeof o.url !== 'string') throw new Error('url must be a string');
    return { url: parseNavigationUrl(o.url) };
  },
};

/**
 * `navigate` — load a url in the target tab.
 *
 * WHY IT EXISTS: without it the only way an agent could reach a new page was `run_js` with
 * `location.href`, which needs the **Develop** grant — full page control, able to read
 * cookies/session and exfiltrate. That inverted the ladder at its most ordinary point: "go to
 * the pricing page and read it" cost strictly more privilege than clicking a button. This tool
 * ADDS no capability — an Act-tier agent can already reach another origin by clicking a link —
 * it removes the need to hand over `run_js` to do the most basic thing a browser does.
 *
 * Act-tier + approval, like every other effectful tool: the approval card shows the concrete
 * (validated, credential-free) url, so the consent is legible. The url is audited — it is the
 * agent's own input, not page content, and traceability of where the agent went is the point.
 *
 * NOTE ON GRANTS: a tab's AI grant deliberately persists across navigation (see `makeTabView`
 * in main.ts — there is no cross-origin auto-revoke), so navigating does not re-prompt for the
 * new origin. That is a pre-existing, deliberate property of the grant model, unchanged here:
 * `click` on a cross-origin link already carries the grant the same way.
 */
export function createNavigateTool(ctrl: NavigateController): Tool<{ url: string }, NavigateResult> {
  return {
    name: 'navigate',
    description:
      'Load a URL in the current tab (http/https only). Returns the committed URL after ' +
      'redirects, so you can tell when a site bounced you to a login or consent page.',
    minMode: Mode.Act,
    risk: RiskLevel.Medium,
    requiresApproval: true,
    // The destination is the whole point of the record — log it (the schema has already
    // stripped credentials, so this cannot log a user:pass pair).
    auditDetail: (input) => input.url,
    inputSchema: navigateSchema,
    async handler(input, ctx) {
      // Effectful pre-gate: never start a navigation whose grant was pulled after approval.
      if (ctx.signal.aborted || !ctx.isLive()) {
        throw new BrokerError(DenyReason.Revoked, 'revoked before navigate executed');
      }
      return ctrl.navigate(ctx.tabId, input.url, ctx);
    },
  };
}
