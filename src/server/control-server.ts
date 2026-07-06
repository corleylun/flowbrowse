import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { checkAuth, controlAuthConfig, AuthConfig } from './auth';
import { Broker } from '../core/broker';
import { ToolRegistry } from '../core/tool';
import { resolveTabTarget } from '../core/tab-target';
import { handleMcpRequest } from '../mcp/server';

export interface ControlServerOptions {
  host?: string; // default 127.0.0.1; pass 0.0.0.0 to accept LAN connections
  port?: number; // default 8676; pass 0 for an ephemeral port (tests)
  /**
   * Bare host/IP values (no port) to allow in the Host/Origin allowlist beyond loopback — the
   * machine's LAN IPs when LAN access is on. Empty (default) = loopback only. This is the
   * DNS-rebinding guard, so only these exact hosts are accepted even when bound to 0.0.0.0.
   */
  allowedHosts?: string[];
  token: string;
  registry: ToolRegistry;
  broker: Broker;
  activeTab: () => string;
  /** The active tab's current permission mode (read-only — there is NO setter on this surface). */
  currentMode?: () => string;
  /**
   * True if `id` names a currently open tab — used to resolve a per-call `tab` override (see
   * `resolveTabTarget`). Omitted only by tests that never send `tab`; defaults to "nothing is
   * known" so an explicit target always fails closed instead of reaching the broker.
   */
  isKnownTab?: (id: string) => boolean;
  /**
   * The human's "Allow agent tab control" setting — false forbids targeting any tab other than
   * the active one. Defaults to false (fail closed) when omitted — an unwired frontend must not
   * grant targeting the wired setting could forbid.
   */
  allowTabTargeting?: () => boolean;
}

const MAX_BODY = 1_000_000; // 1 MB request-body cap

/** A request-level failure that maps to a specific HTTP status (vs. a 500). */
class RequestError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * The control surface. Binds to 127.0.0.1 by default (loopback only); with LAN access on it binds
 * to 0.0.0.0 and the caller passes the machine's LAN IPs as `allowedHosts`. Every request is gated
 * through `checkAuth` (bearer token + Host/Origin allowlist — the allowlist is the DNS-rebinding
 * guard, so even bound wide only the loopback + explicit LAN hosts are accepted). Two route groups,
 * both flowing
 * through the broker:
 *   - /mcp        the MCP Streamable HTTP endpoint (Claude Code / Codex connect here)
 *   - /api/*      a small JSON control API for the bundled CLI
 *
 * Deliberately has NO endpoint to change the permission mode — only the user's UI may
 * do that. An external agent can read/act, never escalate itself.
 */
export class ControlServer {
  private server: http.Server | null = null;
  private auth: AuthConfig | null = null;
  private readonly host: string;
  private readonly desiredPort: number;
  private readonly extraHosts: string[];
  private boundPort = 0;

  constructor(private readonly opts: ControlServerOptions) {
    this.host = opts.host ?? '127.0.0.1';
    this.desiredPort = opts.port ?? 8676;
    this.extraHosts = opts.allowedHosts ?? [];
  }

  get url(): string {
    return `http://${this.host}:${this.boundPort}`;
  }
  get port(): number {
    return this.boundPort;
  }

  async start(): Promise<void> {
    const server = http.createServer((req, res) => {
      void this.onRequest(req, res);
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.desiredPort, this.host, () => {
        server.removeListener('error', reject);
        resolve();
      });
    });
    this.server = server;
    this.boundPort = (server.address() as AddressInfo).port;
    this.auth = controlAuthConfig(this.opts.token, this.boundPort, this.extraHosts);
  }

  /** Rotate the bearer token in place — any agent still using the old token is immediately
   *  rejected. The server keeps running on the same port. */
  setToken(token: string): void {
    this.auth = controlAuthConfig(token, this.boundPort, this.extraHosts);
  }

  async stop(): Promise<void> {
    const s = this.server;
    if (!s) return;
    await new Promise<void>((resolve) => s.close(() => resolve()));
    this.server = null;
  }

  private async onRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      const auth = checkAuth(req.headers, this.auth!);
      if (!auth.ok) {
        return this.json(res, auth.status, { error: auth.reason });
      }

      const pathname = new URL(req.url ?? '/', this.url).pathname;

      if (pathname === '/mcp') {
        // Stateless transport only services POST; reject other methods up front so an
        // idle GET (SSE) can't hang a freshly-built transport.
        if (req.method !== 'POST') {
          return this.json(res, 405, { error: 'method not allowed' });
        }
        const body = await this.readJson(req);
        await handleMcpRequest(req, res, body, {
          registry: this.opts.registry,
          broker: this.opts.broker,
          activeTab: this.opts.activeTab,
          isKnownTab: this.opts.isKnownTab,
          allowTabTargeting: this.opts.allowTabTargeting,
        });
        return;
      }

      if (pathname === '/api/status' && req.method === 'GET') {
        return this.json(res, 200, {
          ok: true,
          tab: this.opts.activeTab(),
          mode: this.opts.currentMode?.() ?? 'unknown',
        });
      }

      if (pathname === '/api/tools' && req.method === 'GET') {
        const tools = this.opts.registry.list().map((t) => ({
          name: t.name,
          description: t.description,
          minMode: t.minMode,
          risk: t.risk,
          requiresApproval: t.requiresApproval,
        }));
        return this.json(res, 200, { tools });
      }

      if (pathname === '/api/invoke' && req.method === 'POST') {
        const body = (await this.readJson(req)) as
          | { tool?: unknown; input?: unknown; tab?: unknown }
          | undefined;
        if (!body || typeof body.tool !== 'string') {
          return this.json(res, 400, { error: 'missing "tool"' });
        }
        // Resolve which tab this call targets BEFORE the broker ever sees a tabId — an unknown
        // or disallowed `tab` must never reach broker.invoke (see resolveTabTarget).
        const target = resolveTabTarget({
          requested: body.tab,
          active: this.opts.activeTab,
          isKnownTab: this.opts.isKnownTab ?? (() => false),
          allowTargeting: this.opts.allowTabTargeting ?? (() => false), // fail closed when unwired
        });
        if (!target.ok) {
          if (target.reason === 'invalid_input') {
            return this.json(res, 400, { error: target.message });
          }
          return this.json(res, 200, { ok: false, reason: target.reason, message: target.message });
        }
        const result = await this.opts.broker.invoke(target.tabId, body.tool, body.input ?? {});
        return this.json(res, 200, result);
      }

      return this.json(res, 404, { error: 'not found' });
    } catch (err) {
      if (err instanceof RequestError) {
        return this.json(res, err.status, { error: err.message });
      }
      const message = err instanceof Error ? err.message : 'internal error';
      return this.json(res, 500, { error: 'internal error', detail: message.slice(0, 200) });
    }
  }

  private async readJson(req: http.IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    let size = 0;
    let oversized = false;
    for await (const chunk of req) {
      if (oversized) continue; // keep draining the socket so we can reply cleanly
      size += (chunk as Buffer).length;
      if (size > MAX_BODY) {
        oversized = true;
        continue;
      }
      chunks.push(chunk as Buffer);
    }
    if (oversized) throw new RequestError(413, 'request body too large');
    if (chunks.length === 0) return undefined;
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      throw new Error('invalid JSON body'); // → 500, no internal detail leaked
    }
  }

  private json(res: http.ServerResponse, status: number, payload: unknown): void {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(payload));
  }
}
