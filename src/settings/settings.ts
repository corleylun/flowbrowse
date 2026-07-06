import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * App-wide user settings:
 *  - a global User-Agent override (empty = the browser default),
 *  - the approval-card timeout (how long a card waits before auto-DENYING — fail-closed),
 *  - the local MCP/control-server port.
 *
 * The UA is sanitised on the way in — CR/LF and control chars are stripped (a newline in a UA
 * could otherwise smuggle an extra HTTP header) and the length is capped.
 */

export interface AppSettings {
  /** '' = use the browser default. */
  userAgent: string;
  /** Auto-deny an unanswered approval card after this many ms. */
  approvalTimeoutMs: number;
  /** The localhost control/MCP server port. */
  mcpPort: number;
  /**
   * When true (default), the agent may enumerate ALL tabs (list_tabs) and bring any of them to
   * the foreground (switch_tab). When false, the agent sees only the active tab and switch_tab is
   * denied — the historical single-active-tab isolation. Switching never escalates a tab's mode;
   * each tab is still gated by its own per-tab grant.
   */
  agentTabControl: boolean;
  /**
   * When true, the control/MCP server binds to all interfaces (0.0.0.0) and adds the machine's
   * LAN IPs to the Host/Origin allowlist so a remote PC can connect. Default FALSE — loopback only.
   * ⚠ The surface is plaintext HTTP: only enable on a trusted network; use an SSH/Tailscale tunnel
   * for anything over the internet. Still gated by the bearer token + the per-tab AI grant.
   */
  lanAccess: boolean;
}

const MAX_UA_LEN = 512;

export const DEFAULT_APPROVAL_TIMEOUT_MS = 120_000;
const MIN_APPROVAL_TIMEOUT_MS = 5_000;
const MAX_APPROVAL_TIMEOUT_MS = 600_000;

export const DEFAULT_MCP_PORT = 8676;

export const DEFAULT_AGENT_TAB_CONTROL = true;

export const DEFAULT_LAN_ACCESS = false;

/** Strip header-injection vectors / control chars, collapse newlines, trim, and cap length. */
export function sanitizeUserAgent(ua: unknown): string {
  if (typeof ua !== 'string') return '';
  return ua
    .replace(/[\r\n]+/g, ' ')
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f]/g, '')
    .trim()
    .slice(0, MAX_UA_LEN);
}

/** Clamp the approval timeout into a sane, always-times-out range (fail-closed). */
export function sanitizeApprovalTimeout(v: unknown): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : DEFAULT_APPROVAL_TIMEOUT_MS;
  return Math.min(MAX_APPROVAL_TIMEOUT_MS, Math.max(MIN_APPROVAL_TIMEOUT_MS, n));
}

/** A valid TCP port, or the default. */
export function sanitizePort(v: unknown): number {
  const n = typeof v === 'number' && Number.isInteger(v) ? v : DEFAULT_MCP_PORT;
  return n >= 1 && n <= 65535 ? n : DEFAULT_MCP_PORT;
}

/** Coerce to a boolean, defaulting when absent/garbage (so a missing key keeps the default). */
export function sanitizeAgentTabControl(v: unknown): boolean {
  return typeof v === 'boolean' ? v : DEFAULT_AGENT_TAB_CONTROL;
}

/** LAN access is off unless explicitly, validly true (fail-closed: garbage/absent → loopback only). */
export function sanitizeLanAccess(v: unknown): boolean {
  return typeof v === 'boolean' ? v : DEFAULT_LAN_ACCESS;
}

export class SettingsStore {
  private state: AppSettings = {
    userAgent: '',
    approvalTimeoutMs: DEFAULT_APPROVAL_TIMEOUT_MS,
    mcpPort: DEFAULT_MCP_PORT,
    agentTabControl: DEFAULT_AGENT_TAB_CONTROL,
    lanAccess: DEFAULT_LAN_ACCESS,
  };

  constructor(private readonly file: string) {
    this.load();
  }

  private load(): void {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Partial<AppSettings>;
      this.state = {
        userAgent: sanitizeUserAgent(raw.userAgent),
        approvalTimeoutMs: sanitizeApprovalTimeout(raw.approvalTimeoutMs),
        mcpPort: sanitizePort(raw.mcpPort),
        agentTabControl: sanitizeAgentTabControl(raw.agentTabControl),
        lanAccess: sanitizeLanAccess(raw.lanAccess),
      };
    } catch {
      /* none yet */
    }
  }

  private save(): void {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
      fs.writeFileSync(this.file, JSON.stringify(this.state, null, 2), { mode: 0o600 });
    } catch {
      /* best effort */
    }
  }

  get(): AppSettings {
    return { ...this.state };
  }

  getUserAgent(): string {
    return this.state.userAgent;
  }

  setUserAgent(ua: unknown): void {
    this.state.userAgent = sanitizeUserAgent(ua);
    this.save();
  }

  getApprovalTimeoutMs(): number {
    return this.state.approvalTimeoutMs;
  }

  setApprovalTimeoutMs(ms: unknown): void {
    this.state.approvalTimeoutMs = sanitizeApprovalTimeout(ms);
    this.save();
  }

  getMcpPort(): number {
    return this.state.mcpPort;
  }

  setMcpPort(port: unknown): void {
    this.state.mcpPort = sanitizePort(port);
    this.save();
  }

  getAgentTabControl(): boolean {
    return this.state.agentTabControl;
  }

  setAgentTabControl(on: unknown): void {
    this.state.agentTabControl = sanitizeAgentTabControl(on);
    this.save();
  }

  getLanAccess(): boolean {
    return this.state.lanAccess;
  }

  setLanAccess(on: unknown): void {
    this.state.lanAccess = sanitizeLanAccess(on);
    this.save();
  }
}
