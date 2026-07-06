import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Broker } from '../core/broker';
import { ToolRegistry } from '../core/tool';
import { resolveTabTarget } from '../core/tab-target';

export interface McpDeps {
  registry: ToolRegistry;
  broker: Broker;
  activeTab: () => string;
  /** See `ControlServerOptions.isKnownTab` — same fail-closed contract, threaded through here. */
  isKnownTab?: (id: string) => boolean;
  /** See `ControlServerOptions.allowTabTargeting`. */
  allowTabTargeting?: () => boolean;
}

/**
 * Build an McpServer mirroring the broker's registered tools. Every MCP tool call is
 * forwarded to `broker.invoke` — the broker stays the single permission + validation
 * authority, so the MCP-level schema is intentionally permissive (the broker's per-tool
 * Parser does the real validation).
 *
 * A call may carry an optional `tab` alongside its normal arguments (an id from `list_tabs`) to
 * target a tab other than the active one — it's stripped before the rest reaches the tool's own
 * schema. The target tab's own per-tab mode is the only permission gate; see `resolveTabTarget`.
 * Exception: `switch_tab` takes `tab` as its OWN input, so it's never treated as targeting there.
 *
 * SECURITY: this surface can NEVER change the permission mode — only the user's UI can.
 * An agent connected here may read/act ONLY within the mode the user granted, and a
 * "Stop AI"/block instantly fails its calls closed via the broker's epoch check.
 */
export function buildMcpServer(deps: McpDeps): McpServer {
  const server = new McpServer({ name: 'safecobrowser', version: '0.0.1' });

  for (const tool of deps.registry.list()) {
    // Open object schema: the broker validates the real shape per-tool.
    const inputSchema = z.object({}).catchall(z.unknown());
    // Cast around the SDK's generic inference — this is a generic forwarder.
    (server.registerTool as unknown as (n: string, c: unknown, cb: unknown) => void)(
      tool.name,
      { description: tool.description, inputSchema },
      async (args: Record<string, unknown>) => {
        // `tab` is an out-of-band targeting hint, not part of any tool's real input — strip it
        // before the rest reaches the broker/tool schema (see resolveTabTarget for the fail-
        // closed resolution: unknown/disallowed ids are rejected here, never passed through).
        // EXCEPT for switch_tab, whose OWN required input is `{ tab }`: stripping would break
        // it, and per-call targeting is meaningless for a global tab-management tool — its args
        // pass through unchanged and it runs against the active tab as before.
        // NOTE: switch_tab is TODAY the only tool that reads a `tab` input. If a future tool
        // takes one, add it to this exemption or the strip will silently swallow that input.
        let requested: unknown;
        let input: Record<string, unknown> = (args ?? {}) as Record<string, unknown>;
        if (tool.name !== 'switch_tab') {
          const { tab, ...rest } = input;
          requested = tab;
          input = rest;
        }
        const target = resolveTabTarget({
          requested,
          active: deps.activeTab,
          isKnownTab: deps.isKnownTab ?? (() => false),
          allowTargeting: deps.allowTabTargeting ?? (() => false), // fail closed when unwired
        });
        if (!target.ok) {
          return {
            isError: true,
            content: [{ type: 'text' as const, text: `denied: ${target.reason} — ${target.message}` }],
          };
        }
        const result = await deps.broker.invoke(target.tabId, tool.name, input);
        if (!result.ok) {
          return {
            isError: true,
            content: [
              {
                type: 'text' as const,
                text: `denied: ${result.reason}${result.message ? ` — ${result.message}` : ''}`,
              },
            ],
          };
        }
        const text =
          typeof result.output === 'string' ? result.output : JSON.stringify(result.output);
        return { content: [{ type: 'text' as const, text }] };
      },
    );
  }

  return server;
}

/**
 * Handle one Streamable HTTP request in stateless mode (a fresh server + transport per
 * request). Simple and robust for a single local client; auth is already enforced by the
 * control server before this is called.
 */
export async function handleMcpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  body: unknown,
  deps: McpDeps,
): Promise<void> {
  const server = buildMcpServer(deps);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  res.on('close', () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}
