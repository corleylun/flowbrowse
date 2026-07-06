import test from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import { createCore } from '../core';
import { Mode } from '../core/modes';
import { RiskLevel, Tool, Parser } from '../core/tool';
import { ControlServer } from './control-server';

const TOKEN = 'test-token-1234567890';

const echoSchema: Parser<{ value: string }> = {
  parse(raw) {
    if (typeof raw !== 'object' || raw === null || typeof (raw as { value?: unknown }).value !== 'string') {
      throw new Error('expected { value: string }');
    }
    return { value: (raw as { value: string }).value };
  },
};

const echoTool: Tool<{ value: string }, string> = {
  name: 'echo',
  description: 'echo uppercased',
  minMode: Mode.Read,
  risk: RiskLevel.Low,
  requiresApproval: false,
  inputSchema: echoSchema,
  async handler(input) {
    return input.value.toUpperCase();
  },
};

interface RawResponse {
  status: number;
  json: unknown;
}

// Raw http client so we can set arbitrary headers (fetch forbids Host/Origin).
function raw(
  url: string,
  opts: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method: opts.method ?? 'GET',
        headers: opts.headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c as Buffer));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json: unknown;
          try {
            json = text ? JSON.parse(text) : undefined;
          } catch {
            json = text;
          }
          resolve({ status: res.statusCode ?? 0, json });
        });
      },
    );
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

test('control server: auth gate + broker-gated API + MCP handshake', async (t) => {
  const core = createCore();
  core.registry.register(echoTool);
  const server = new ControlServer({
    token: TOKEN,
    port: 0, // ephemeral
    registry: core.registry,
    broker: core.broker,
    activeTab: () => 'main',
    currentMode: () => core.sessions.get('main').mode,
  });
  await server.start();
  t.after(async () => server.stop());

  const base = server.url;
  const host = `127.0.0.1:${server.port}`;
  const authed = { host, authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };

  await t.test('missing token → 401', async () => {
    const r = await raw(`${base}/api/status`, { headers: { host } });
    assert.equal(r.status, 401);
  });

  await t.test('wrong token → 401', async () => {
    const r = await raw(`${base}/api/status`, { headers: { host, authorization: 'Bearer nope' } });
    assert.equal(r.status, 401);
  });

  await t.test('disallowed host → 403', async () => {
    const r = await raw(`${base}/api/status`, {
      headers: { host: 'evil.example.com', authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(r.status, 403);
  });

  await t.test('disallowed origin → 403', async () => {
    const r = await raw(`${base}/api/status`, {
      headers: { ...authed, origin: 'http://evil.example.com' },
    });
    assert.equal(r.status, 403);
  });

  await t.test('GET /api/tools lists the registered tool', async () => {
    const r = await raw(`${base}/api/tools`, { headers: authed });
    assert.equal(r.status, 200);
    const tools = (r.json as { tools: Array<{ name: string }> }).tools;
    assert.equal(tools.length, 1);
    assert.equal(tools[0].name, 'echo');
  });

  await t.test('invoke is DENIED while the tab is Blocked (default)', async () => {
    const r = await raw(`${base}/api/invoke`, {
      method: 'POST',
      headers: authed,
      body: JSON.stringify({ tool: 'echo', input: { value: 'hi' } }),
    });
    assert.equal(r.status, 200);
    const result = r.json as { ok: boolean; reason?: string };
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'permission_denied');
  });

  await t.test('invoke SUCCEEDS once the user grants Read mode', async () => {
    core.sessions.setMode('main', Mode.Read); // simulates the user's UI grant
    const r = await raw(`${base}/api/invoke`, {
      method: 'POST',
      headers: authed,
      body: JSON.stringify({ tool: 'echo', input: { value: 'hi' } }),
    });
    const result = r.json as { ok: boolean; output?: string };
    assert.equal(result.ok, true);
    assert.equal(result.output, 'HI');
  });

  await t.test('GET /api/status reports the active tab + its (read-only) mode', async () => {
    // By now the user has granted Read mode above; status should reflect it live.
    const r = await raw(`${base}/api/status`, { headers: authed });
    assert.equal(r.status, 200);
    const body = r.json as { ok: boolean; tab: string; mode: string };
    assert.equal(body.ok, true);
    assert.equal(body.tab, 'main');
    assert.equal(body.mode, 'read');
  });

  await t.test('there is NO endpoint to change the permission mode', async () => {
    const r = await raw(`${base}/api/mode`, {
      method: 'POST',
      headers: authed,
      body: JSON.stringify({ tab: 'main', mode: 'develop' }),
    });
    assert.equal(r.status, 404); // agent surface cannot escalate itself
  });

  await t.test('MCP endpoint requires auth', async () => {
    const r = await raw(`${base}/mcp`, {
      method: 'POST',
      headers: { host, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    });
    assert.equal(r.status, 401);
  });

  await t.test('MCP initialize handshake returns a JSON-RPC result', async () => {
    const init = {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'test', version: '1.0.0' },
      },
    };
    const r = await raw(`${base}/mcp`, {
      method: 'POST',
      headers: { ...authed, accept: 'application/json, text/event-stream' },
      body: JSON.stringify(init),
    });
    assert.equal(r.status, 200);
    const body = r.json as { result?: { protocolVersion?: string; serverInfo?: { name?: string } } };
    assert.ok(body.result, 'has a JSON-RPC result');
    assert.equal(body.result?.serverInfo?.name, 'safecobrowser');
  });

  await t.test('setToken rotates the bearer: old token rejected, new accepted', async () => {
    const NEW = 'rotated-token-0987654321';
    server.setToken(NEW);
    const oldAuth = await raw(`${base}/api/status`, { headers: authed }); // still the original TOKEN
    assert.equal(oldAuth.status, 401, 'the old token no longer authenticates');
    const newAuth = await raw(`${base}/api/status`, {
      headers: { host, authorization: `Bearer ${NEW}` },
    });
    assert.equal(newAuth.status, 200, 'the new token authenticates');
    server.setToken(TOKEN); // restore for any later subtests
  });
});

test('control server: LAN access allowlists the passed host but not others', async (t) => {
  const core = createCore();
  core.registry.register(echoTool);
  core.sessions.setMode('main', Mode.Read);
  // Simulate LAN mode: bound wide, with one LAN IP explicitly allowlisted.
  const server = new ControlServer({
    token: TOKEN,
    port: 0,
    host: '127.0.0.1', // bind loopback in the test; the allowlist is what we're exercising
    allowedHosts: ['192.168.1.50'],
    registry: core.registry,
    broker: core.broker,
    activeTab: () => 'main',
    currentMode: () => core.sessions.get('main').mode,
  });
  await server.start();
  t.after(async () => server.stop());

  const base = server.url;
  const port = server.port;

  await t.test('the explicit LAN host is accepted', async () => {
    const r = await raw(`${base}/api/status`, {
      headers: { host: `192.168.1.50:${port}`, authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(r.status, 200);
  });

  await t.test('loopback still works', async () => {
    const r = await raw(`${base}/api/status`, {
      headers: { host: `127.0.0.1:${port}`, authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(r.status, 200);
  });

  await t.test('a different LAN IP is still rejected (rebinding guard holds)', async () => {
    const r = await raw(`${base}/api/status`, {
      headers: { host: `192.168.1.99:${port}`, authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(r.status, 403);
  });

  await t.test('setToken preserves the LAN allowlist', async () => {
    const NEW = 'rotated-lan-token-123456';
    server.setToken(NEW);
    const r = await raw(`${base}/api/status`, {
      headers: { host: `192.168.1.50:${port}`, authorization: `Bearer ${NEW}` },
    });
    assert.equal(r.status, 200, 'LAN host still allowed after rotation');
    server.setToken(TOKEN);
  });
});

test('control server: per-call background-tab targeting via /api/invoke', async (t) => {
  const core = createCore();
  core.registry.register(echoTool);
  const knownTabs = new Set(['main', 'bg']);
  let agentTabControl = true;
  const server = new ControlServer({
    token: TOKEN,
    port: 0,
    registry: core.registry,
    broker: core.broker,
    activeTab: () => 'main',
    currentMode: () => core.sessions.get('main').mode,
    isKnownTab: (id) => knownTabs.has(id),
    allowTabTargeting: () => agentTabControl,
  });
  await server.start();
  t.after(async () => server.stop());

  const base = server.url;
  const host = `127.0.0.1:${server.port}`;
  const authed = { host, authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };

  await t.test('absent "tab" -> active tab (zero-regression)', async () => {
    core.sessions.setMode('main', Mode.Read);
    const r = await raw(`${base}/api/invoke`, {
      method: 'POST',
      headers: authed,
      body: JSON.stringify({ tool: 'echo', input: { value: 'hi' } }),
    });
    const result = r.json as { ok: boolean; output?: string };
    assert.equal(result.ok, true);
    assert.equal(result.output, 'HI');
  });

  await t.test('"tab" targeting a Blocked background tab -> permission_denied on THAT tab', async () => {
    // 'bg' has never been granted anything -> still Blocked by default.
    const r = await raw(`${base}/api/invoke`, {
      method: 'POST',
      headers: authed,
      body: JSON.stringify({ tool: 'echo', input: { value: 'hi' }, tab: 'bg' }),
    });
    const result = r.json as { ok: boolean; reason?: string };
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'permission_denied');
  });

  await t.test('"tab" targeting a Read-granted background tab -> runs on that tab', async () => {
    core.sessions.setMode('bg', Mode.Read);
    const r = await raw(`${base}/api/invoke`, {
      method: 'POST',
      headers: authed,
      body: JSON.stringify({ tool: 'echo', input: { value: 'bye' }, tab: 'bg' }),
    });
    const result = r.json as { ok: boolean; output?: string };
    assert.equal(result.ok, true);
    assert.equal(result.output, 'BYE');
  });

  await t.test('unknown "tab" id -> clear error, never silently falls back to the active tab', async () => {
    const r = await raw(`${base}/api/invoke`, {
      method: 'POST',
      headers: authed,
      body: JSON.stringify({ tool: 'echo', input: { value: 'hi' }, tab: 'ghost' }),
    });
    assert.equal(r.status, 400);
    const body = r.json as { error?: string };
    assert.match(body.error ?? '', /unknown tab/);
  });

  await t.test('non-string "tab" -> 400, invalid input', async () => {
    const r = await raw(`${base}/api/invoke`, {
      method: 'POST',
      headers: authed,
      body: JSON.stringify({ tool: 'echo', input: { value: 'hi' }, tab: 42 }),
    });
    assert.equal(r.status, 400);
  });

  await t.test('allowTabTargeting=false + a DIFFERENT tab -> denied', async () => {
    agentTabControl = false;
    const r = await raw(`${base}/api/invoke`, {
      method: 'POST',
      headers: authed,
      body: JSON.stringify({ tool: 'echo', input: { value: 'hi' }, tab: 'bg' }),
    });
    const result = r.json as { ok: boolean; reason?: string };
    assert.equal(r.status, 200);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'permission_denied');
  });

  await t.test('allowTabTargeting=false: known and unknown ids are indistinguishable (no oracle)', async () => {
    // Same status AND same body for a real background tab vs a nonexistent id — otherwise the
    // 400-vs-200 difference lets an agent enumerate the tabs the disabled setting should hide.
    const probe = (tab: string) =>
      raw(`${base}/api/invoke`, {
        method: 'POST',
        headers: authed,
        body: JSON.stringify({ tool: 'echo', input: { value: 'hi' }, tab }),
      });
    const known = await probe('bg');
    const unknown = await probe('ghost');
    assert.equal(known.status, unknown.status);
    assert.deepEqual(known.json, unknown.json);
    assert.equal((known.json as { reason?: string }).reason, 'permission_denied');
  });

  await t.test('allowTabTargeting=false + the SAME tab as active -> still allowed', async () => {
    const r = await raw(`${base}/api/invoke`, {
      method: 'POST',
      headers: authed,
      body: JSON.stringify({ tool: 'echo', input: { value: 'hi' }, tab: 'main' }),
    });
    const result = r.json as { ok: boolean; output?: string };
    assert.equal(result.ok, true);
    agentTabControl = true; // restore for any later subtests
  });
});

test('control server: per-call background-tab targeting via MCP tools/call', async (t) => {
  const core = createCore();
  core.registry.register(echoTool);

  // Records which tab the broker ran it on, and REJECTS a `tab` key in its input — so a
  // forwarder that fails to strip the targeting hint fails this suite loudly.
  const probeTabs: string[] = [];
  const probeTool: Tool<Record<string, never>, string> = {
    name: 'probe',
    description: 'records its target tab; rejects a tab key in its input',
    minMode: Mode.Read,
    risk: RiskLevel.Low,
    requiresApproval: false,
    inputSchema: {
      parse(raw) {
        if (raw && typeof raw === 'object' && 'tab' in raw) {
          throw new Error('targeting hint leaked into tool input');
        }
        return {};
      },
    },
    async handler(_input, ctx) {
      probeTabs.push(ctx.tabId);
      return ctx.tabId;
    },
  };
  core.registry.register(probeTool);

  // A stand-in for the real switch_tab: its OWN required input is { tab }, so the MCP
  // forwarder must NOT strip it as a targeting hint (the regression this pins down).
  const switchCalls: string[] = [];
  const fakeSwitchTab: Tool<{ tab: string }, { switched: boolean; tab: string }> = {
    name: 'switch_tab',
    description: 'switch_tab stand-in — takes tab as its own input',
    minMode: Mode.Blocked,
    risk: RiskLevel.Low,
    requiresApproval: false,
    inputSchema: {
      parse(raw) {
        const tab = (raw as { tab?: unknown } | null)?.tab;
        if (typeof tab !== 'string' || tab === '') throw new Error('expected { tab: string }');
        return { tab };
      },
    },
    async handler(input) {
      switchCalls.push(input.tab);
      return { switched: true, tab: input.tab };
    },
  };
  core.registry.register(fakeSwitchTab);

  const knownTabs = new Set(['main', 'bg']);
  const server = new ControlServer({
    token: TOKEN,
    port: 0,
    registry: core.registry,
    broker: core.broker,
    activeTab: () => 'main',
    isKnownTab: (id) => knownTabs.has(id),
    allowTabTargeting: () => true,
  });
  await server.start();
  t.after(async () => server.stop());

  const base = server.url;
  const host = `127.0.0.1:${server.port}`;
  const authed = {
    host,
    authorization: `Bearer ${TOKEN}`,
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
  };

  const call = (tool: string, args: Record<string, unknown>, id = 1) =>
    raw(`${base}/mcp`, {
      method: 'POST',
      headers: authed,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id,
        method: 'tools/call',
        params: { name: tool, arguments: args },
      }),
    });

  const resultText = (r: { json: unknown }) =>
    (r.json as { result?: { content?: Array<{ text?: string }> } }).result?.content?.[0]?.text;

  await t.test('a `tab` argument targets that tab\'s own session', async () => {
    core.sessions.setMode('bg', Mode.Read);
    const r = await call('echo', { value: 'hi', tab: 'bg' }, 1);
    assert.equal(r.status, 200);
    assert.equal(resultText(r), 'HI');
  });

  await t.test('`tab` is STRIPPED from the tool input and the broker runs on that tab', async () => {
    // probe's schema throws on a `tab` key, so success here proves the strip; its output/record
    // proves the broker was invoked with the targeted tab, not the active one.
    const r = await call('probe', { tab: 'bg' }, 2);
    assert.equal(r.status, 200);
    assert.equal(resultText(r), 'bg');
    assert.equal(probeTabs.at(-1), 'bg');
  });

  await t.test('switch_tab keeps its OWN {tab} input over MCP (not treated as targeting)', async () => {
    // Regression: stripping switch_tab's tab left it with {} → invalid_input, breaking it
    // entirely over MCP. Its args must pass through untouched, running on the active tab.
    const r = await call('switch_tab', { tab: 'bg' }, 3);
    assert.equal(r.status, 200);
    const text = resultText(r) ?? '';
    assert.ok(!/invalid_input/.test(text), `switch_tab was denied: ${text}`);
    assert.match(text, /"switched":true/);
    assert.equal(switchCalls.at(-1), 'bg', 'the handler received its tab intact');
  });

  await t.test('a Blocked background tab is denied via MCP too', async () => {
    core.sessions.revoke('bg');
    const r = await call('echo', { value: 'hi', tab: 'bg' }, 4);
    assert.equal(r.status, 200);
    const text = JSON.stringify(r.json);
    assert.ok(/denied|permission/i.test(text), `expected denial, got: ${text}`);
  });

  await t.test('an unknown `tab` id is denied, never silently uses the active tab', async () => {
    const r = await call('echo', { value: 'hi', tab: 'ghost' }, 5);
    assert.equal(r.status, 200);
    const text = JSON.stringify(r.json);
    assert.ok(/unknown tab/i.test(text), `expected an unknown-tab denial, got: ${text}`);
  });
});
