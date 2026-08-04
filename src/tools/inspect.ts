import { Mode } from '../core/modes';
import { RiskLevel, Tool, Parser } from '../core/tool';

export interface ElementInfo {
  matched: boolean;
  tagName?: string;
  attributes?: Record<string, string>;
  text?: string;
  outerHTML?: string;
  rect?: { x: number; y: number; width: number; height: number };
}
export interface ConsoleMessage {
  level: string;
  text: string;
  ts: number;
}
export interface NetworkEntry {
  method: string;
  url: string;
  status?: number;
  ts: number;
}
export interface NetworkBodyEntry {
  method: string;
  url: string;
  status: number;
  contentType: string;
  /** Text/JSON response body, truncated to ~64KB (see `truncated`). */
  body: string;
  truncated: boolean;
  ts: number;
}

/** Brokered Inspect-tier introspection (read-only; no approval). Electron-free interface. */
export interface InspectController {
  inspect(tabId: string, selector: string): Promise<ElementInfo>;
  console(tabId: string, limit: number): Promise<ConsoleMessage[]>;
  network(tabId: string, limit: number): Promise<NetworkEntry[]>;
  networkBody(tabId: string, limit: number): Promise<NetworkBodyEntry[]>;
}

const selectorSchema: Parser<{ selector: string }> = {
  parse(raw) {
    const o = raw as { selector?: unknown };
    if (typeof raw !== 'object' || raw === null || typeof o.selector !== 'string' || o.selector.trim() === '') {
      throw new Error('expected { selector: string }');
    }
    return { selector: o.selector.trim() };
  },
};

const limitSchema: Parser<{ limit: number }> = {
  parse(raw) {
    if (raw === undefined || raw === null) return { limit: 100 };
    if (typeof raw !== 'object') throw new Error('expected optional { limit: number }');
    const l = (raw as { limit?: unknown }).limit;
    if (l === undefined) return { limit: 100 };
    if (typeof l !== 'number' || !Number.isFinite(l) || l <= 0) {
      throw new Error('limit must be a positive number');
    }
    return { limit: Math.min(Math.floor(l), 1000) };
  },
};

/** inspect_element + read_console + read_network. All Inspect-tier, no approval. */
export function createInspectTools(inspect: InspectController): Tool[] {
  const inspectElement: Tool<{ selector: string }, ElementInfo> = {
    name: 'inspect_element',
    description: 'Inspect a DOM element: tag, attributes, text, outerHTML, and bounds.',
    minMode: Mode.Inspect,
    risk: RiskLevel.Low,
    requiresApproval: false,
    auditInput: true,
    inputSchema: selectorSchema,
    handler: (input, ctx) => inspect.inspect(ctx.tabId, input.selector),
  };

  const readConsole: Tool<{ limit: number }, ConsoleMessage[]> = {
    name: 'read_console',
    description: 'Read recent console messages from the page.',
    minMode: Mode.Inspect,
    risk: RiskLevel.Low,
    requiresApproval: false,
    inputSchema: limitSchema,
    handler: (input, ctx) => inspect.console(ctx.tabId, input.limit),
  };

  const readNetwork: Tool<{ limit: number }, NetworkEntry[]> = {
    name: 'read_network',
    description: 'Read recent network request metadata (method, URL, status).',
    minMode: Mode.Inspect,
    risk: RiskLevel.Low,
    requiresApproval: false,
    inputSchema: limitSchema,
    handler: (input, ctx) => inspect.network(ctx.tabId, input.limit),
  };

  const readNetworkBody: Tool<{ limit: number }, NetworkBodyEntry[]> = {
    name: 'read_network_body',
    description:
      'Read recent XHR/fetch responses WITH their bodies (method, URL, status, contentType, body). ' +
      'Text/JSON only; each body truncated to ~64KB. Only captures responses received since AI was ' +
      'granted on this tab (bodies from the blind period are cleared on every grant).',
    minMode: Mode.Inspect,
    risk: RiskLevel.Low,
    requiresApproval: false,
    inputSchema: limitSchema,
    handler: (input, ctx) => inspect.networkBody(ctx.tabId, input.limit),
  };

  return [inspectElement, readConsole, readNetwork, readNetworkBody];
}
