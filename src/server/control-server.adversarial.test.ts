import test from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import { createCore } from '../core';
import { Mode } from '../core/modes';
import { RiskLevel, Tool, Parser } from '../core/tool';
import { ControlServer } from './control-server';

/**
 * Aidan — Phase 2 ADVERSARIAL probes for the control surface.
 *
 * Uses a raw node:http client so we can forge Host / Origin / Authorization /
 * duplicate headers that fetch() would forbid or normalize. We attack the auth
 * gate (DNS-rebinding, origin, token), the body cap, the per-request MCP server,
 * error-leak surface, and the no-self-escalation guarantee.
 *
 * Read-only review: this file does NOT modify any implementation.
 */

const TOKEN = 'a'.repeat(64);

const echoSchema: Parser<{ value: string }> = {
  parse(raw) {
    if (
      typeof raw !== 'object' ||
      raw === null ||
      typeof (raw as { value?: unknown }).value !== 'string'
    ) {
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

// A tool that throws an internal-looking secret. The broker must sanitize this to
// "tool handler failed" before it ever reaches the MCP/api caller.
const SECRET = '/Users/victim/.ssh/id_rsa AWS_SECRET=hunter2';
const explodeSchema: Parser<unknown> = { parse: (raw) => raw };
const explodeTool: Tool<unknown, string> = {
  name: 'explode',
  description: 'always throws',
  minMode: Mode.Read,
  risk: RiskLevel.Low,
  requiresApproval: false,
  inputSchema: explodeSchema,
  async handler() {
    throw new Error(`internal failure ${SECRET}`);
  },
};

interface RawResponse {
  status: number;
  headersSent: number;
  raw: string;
  json: unknown;
}

// Raw http client. `headers` is an array of [name, value] tuples so we can send
// duplicate / oddly-cased headers that an object would collapse.
function raw(
  url: string,
  opts: { method?: string; headers?: Array<[string, string]>; body?: string } = {},
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const headers: Record<string, string | string[]> = {};
    for (const [k, v] of opts.headers ?? []) {
      const existing = headers[k];
      if (existing === undefined) headers[k] = v;
      else if (Array.isArray(existing)) existing.push(v);
      else headers[k] = [existing, v];
    }
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method: opts.method ?? 'GET',
        headers,
        // Fresh socket per probe: an aborted body (e.g. the 1MB-cap test) must not
        // poison a reused keep-alive connection for the next request.
        agent: false,
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
            json = undefined;
          }
          resolve({
            status: res.statusCode ?? 0,
            headersSent: res.statusCode ?? 0,
            raw: text,
            json,
          });
        });
      },
    );
    req.on('error', reject);
    // A request that never gets a response would hang the whole suite; bound it so a
    // non-responding endpoint (e.g. a stateless MCP GET that opens no stream) surfaces
    // as an explicit failure instead of a deadlock.
    req.setTimeout(5000, () => {
      req.destroy(new Error('client timeout: no response in 5s'));
    });
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

test('Phase 2 adversarial: control surface', async (t) => {
  const core = createCore();
  core.registry.register(echoTool);
  core.registry.register(explodeTool);
  const server = new ControlServer({
    token: TOKEN,
    port: 0,
    registry: core.registry,
    broker: core.broker,
    activeTab: () => 'main',
  });
  await server.start();
  t.after(async () => server.stop());

  const base = server.url;
  const HOST = `127.0.0.1:${server.port}`;
  const good = (): Array<[string, string]> => [
    ['host', HOST],
    ['authorization', `Bearer ${TOKEN}`],
    ['content-type', 'application/json'],
  ];

  // ---- DNS-rebinding / Host attacks --------------------------------------

  await t.test('Host without port is rejected (exact-match allowlist)', async () => {
    const r = await raw(`${base}/api/status`, {
      headers: [['host', '127.0.0.1'], ['authorization', `Bearer ${TOKEN}`]],
    });
    assert.equal(r.status, 403);
  });

  await t.test('Host 0.0.0.0 is rejected even with valid token', async () => {
    const r = await raw(`${base}/api/status`, {
      headers: [['host', `0.0.0.0:${server.port}`], ['authorization', `Bearer ${TOKEN}`]],
    });
    assert.equal(r.status, 403);
  });

  await t.test('Host with trailing dot (127.0.0.1.) is rejected', async () => {
    const r = await raw(`${base}/api/status`, {
      headers: [['host', `127.0.0.1.:${server.port}`], ['authorization', `Bearer ${TOKEN}`]],
    });
    assert.equal(r.status, 403);
  });

  await t.test('uppercase LOCALHOST host is accepted (case-insensitive allowlist)', async () => {
    const r = await raw(`${base}/api/status`, {
      headers: [['host', `LOCALHOST:${server.port}`], ['authorization', `Bearer ${TOKEN}`]],
    });
    assert.equal(r.status, 200);
  });

  await t.test('comma-joined dual Host ("good, evil") is rejected (not split-accepted)', async () => {
    // On the wire, a duplicate Host arrives as a single comma-joined value. The
    // allowlist is exact-match, so "127.0.0.1:p, evil.example.com" must NOT match.
    const r = await raw(`${base}/api/status`, {
      headers: [
        ['host', `${HOST}, evil.example.com`],
        ['authorization', `Bearer ${TOKEN}`],
      ],
    });
    assert.equal(r.status, 403);
  });

  await t.test('disallowed host blocks /mcp too (not just /api)', async () => {
    const r = await raw(`${base}/mcp`, {
      method: 'POST',
      headers: [
        ['host', 'evil.example.com'],
        ['authorization', `Bearer ${TOKEN}`],
        ['content-type', 'application/json'],
        ['accept', 'application/json, text/event-stream'],
      ],
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    });
    assert.equal(r.status, 403);
  });

  // ---- Origin attacks -----------------------------------------------------

  await t.test('Origin with mismatched scheme (https) is rejected', async () => {
    const r = await raw(`${base}/api/status`, {
      headers: [...good(), ['origin', `https://127.0.0.1:${server.port}`]],
    });
    assert.equal(r.status, 403);
  });

  await t.test('cross-origin web page Origin is rejected', async () => {
    const r = await raw(`${base}/api/status`, {
      headers: [...good(), ['origin', 'http://evil.example.com']],
    });
    assert.equal(r.status, 403);
  });

  await t.test('literal "null" Origin is rejected (sandboxed iframe / file://)', async () => {
    const r = await raw(`${base}/api/status`, {
      headers: [...good(), ['origin', 'null']],
    });
    assert.equal(r.status, 403);
  });

  await t.test('uppercase-scheme allowed Origin is accepted (case-insensitive)', async () => {
    const r = await raw(`${base}/api/status`, {
      headers: [...good(), ['origin', `HTTP://127.0.0.1:${server.port}`]],
    });
    assert.equal(r.status, 200);
  });

  // ---- Token attacks ------------------------------------------------------

  await t.test('lowercase "bearer" prefix is rejected (prefix is exact)', async () => {
    const r = await raw(`${base}/api/status`, {
      headers: [['host', HOST], ['authorization', `bearer ${TOKEN}`]],
    });
    assert.equal(r.status, 401);
  });

  await t.test('empty bearer token is rejected', async () => {
    const r = await raw(`${base}/api/status`, {
      headers: [['host', HOST], ['authorization', 'Bearer ']],
    });
    assert.equal(r.status, 401);
  });

  await t.test('token that is a prefix of the real token is rejected', async () => {
    const r = await raw(`${base}/api/status`, {
      headers: [['host', HOST], ['authorization', `Bearer ${TOKEN.slice(0, 32)}`]],
    });
    assert.equal(r.status, 401);
  });

  await t.test('token with an embedded space (different token) is rejected', async () => {
    // NOTE: trailing whitespace is stripped by node per RFC 7230 OWS rules, so the
    // server never sees it. An embedded space, however, yields a genuinely different
    // string of a different length and must be rejected by the constant-time compare.
    const mangled = `${TOKEN.slice(0, 30)} ${TOKEN.slice(31)}`; // same length, value differs
    const r = await raw(`${base}/api/status`, {
      headers: [['host', HOST], ['authorization', `Bearer ${mangled}`]],
    });
    assert.equal(r.status, 401);
  });

  // ---- Body cap / DoS -----------------------------------------------------

  await t.test('oversized body on /api/invoke is rejected (1MB cap), fails closed', async () => {
    // The cap throws mid-stream. Because the server responds + tears down while the
    // client is still uploading, the client may observe a 500 OR a socket error
    // (EPIPE/ECONNRESET). The SECURITY property is what we assert: the call is never
    // accepted (no 200), nothing leaks, and the server stays up. (See report finding
    // B2 — the abrupt teardown is a robustness rough edge, not an auth hole.)
    const big = JSON.stringify({ tool: 'echo', input: { value: 'x'.repeat(2_000_000) } });
    let outcome: { status: number; raw: string } | { error: string };
    try {
      const r = await raw(`${base}/api/invoke`, { method: 'POST', headers: good(), body: big });
      outcome = { status: r.status, raw: r.raw };
    } catch (e) {
      outcome = { error: (e as Error).message };
    }
    if ('status' in outcome) {
      assert.notEqual(outcome.status, 200, 'oversized body must never be accepted');
      assert.ok(!outcome.raw.includes('id_rsa'), 'no leak in cap response');
    }
    // Server must still be alive and serving after the cap rejection.
    const follow = await raw(`${base}/api/status`, { headers: good() });
    assert.equal(follow.status, 200, 'server survives the oversized-body rejection');
  });

  await t.test('invalid JSON body on /api/invoke -> 500, no internal stack leak', async () => {
    const r = await raw(`${base}/api/invoke`, {
      method: 'POST',
      headers: good(),
      body: '{ not json',
    });
    assert.equal(r.status, 500);
    const j = r.json as { error?: string; detail?: string };
    assert.equal(j.error, 'internal error');
    // detail is our authored "invalid JSON body" — must NOT contain a file path/stack.
    assert.ok(!/\/Users\/|\.ts:|at Object|node_modules/.test(r.raw), `leak: ${r.raw}`);
  });

  // ---- No self-escalation -------------------------------------------------

  await t.test('there is NO /api/mode route (agent cannot change mode)', async () => {
    const r = await raw(`${base}/api/mode`, {
      method: 'POST',
      headers: good(),
      body: JSON.stringify({ tab: 'main', mode: 'develop' }),
    });
    assert.equal(r.status, 404);
  });

  await t.test('PUT/DELETE on /api/status are not routed (method-gated) -> 404', async () => {
    const put = await raw(`${base}/api/status`, { method: 'PUT', headers: good() });
    assert.equal(put.status, 404);
  });

  // ---- Broker authority: error sanitization through the API & MCP --------

  await t.test('/api/invoke: a throwing tool handler does NOT leak the secret to caller', async () => {
    core.sessions.setMode('main', Mode.Read);
    const r = await raw(`${base}/api/invoke`, {
      method: 'POST',
      headers: good(),
      body: JSON.stringify({ tool: 'explode', input: {} }),
    });
    assert.equal(r.status, 200);
    const j = r.json as { ok: boolean; reason?: string; message?: string };
    assert.equal(j.ok, false);
    assert.equal(j.message, 'tool handler failed');
    assert.ok(!r.raw.includes('id_rsa') && !r.raw.includes('hunter2'), `leak: ${r.raw}`);
  });

  await t.test('/api/invoke with missing "tool" -> 400', async () => {
    const r = await raw(`${base}/api/invoke`, {
      method: 'POST',
      headers: good(),
      body: JSON.stringify({ input: { value: 'hi' } }),
    });
    assert.equal(r.status, 400);
  });

  await t.test('/api/invoke while Blocked is denied (broker is authority)', async () => {
    core.sessions.revoke('main'); // back to Blocked
    const r = await raw(`${base}/api/invoke`, {
      method: 'POST',
      headers: good(),
      body: JSON.stringify({ tool: 'echo', input: { value: 'hi' } }),
    });
    const j = r.json as { ok: boolean; reason?: string };
    assert.equal(j.ok, false);
    assert.equal(j.reason, 'permission_denied');
  });

  // ---- MCP tools/call goes through the broker -----------------------------

  await t.test('MCP tools/call for a throwing tool returns isError without leaking secret', async () => {
    core.sessions.setMode('main', Mode.Read);
    const call = {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'explode', arguments: {} },
    };
    const r = await raw(`${base}/mcp`, {
      method: 'POST',
      headers: [...good(), ['accept', 'application/json, text/event-stream']],
      body: JSON.stringify(call),
    });
    assert.equal(r.status, 200);
    assert.ok(!r.raw.includes('id_rsa') && !r.raw.includes('hunter2'), `MCP leak: ${r.raw}`);
    // The denial text should be the broker's sanitized "tool handler failed".
    assert.ok(r.raw.includes('tool handler failed'), `expected sanitized text, got: ${r.raw}`);
  });

  await t.test('MCP tools/call for an unknown tool fails closed (no handler reached)', async () => {
    const call = {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'no_such_tool', arguments: {} },
    };
    const r = await raw(`${base}/mcp`, {
      method: 'POST',
      headers: [...good(), ['accept', 'application/json, text/event-stream']],
      body: JSON.stringify(call),
    });
    assert.equal(r.status, 200);
    // Either the SDK rejects (unknown tool) or the broker denies — never executes.
    assert.ok(!r.raw.includes('id_rsa'), `leak: ${r.raw}`);
  });

  await t.test('MCP tools/call while Blocked is denied via broker', async () => {
    core.sessions.revoke('main');
    const call = {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'echo', arguments: { value: 'hi' } },
    };
    const r = await raw(`${base}/mcp`, {
      method: 'POST',
      headers: [...good(), ['accept', 'application/json, text/event-stream']],
      body: JSON.stringify(call),
    });
    assert.equal(r.status, 200);
    assert.ok(/denied|permission/i.test(r.raw), `expected denial, got: ${r.raw}`);
  });

  // ---- Per-request MCP server: method handling / no crash -----------------

  await t.test('GET /mcp does not crash the server (server keeps serving)', async () => {
    // A stateless StreamableHTTP transport (sessionIdGenerator: undefined) may not
    // emit a response to a GET. We tolerate either a status OR a client timeout, then
    // assert the server is still alive for a follow-up request (no crash / no wedge).
    let observed: string;
    try {
      const r = await raw(`${base}/mcp`, {
        method: 'GET',
        headers: [...good(), ['accept', 'application/json, text/event-stream']],
      });
      observed = `status ${r.status}`;
    } catch (e) {
      observed = (e as Error).message;
    }
    // eslint-disable-next-line no-console
    console.error(`[probe] GET /mcp -> ${observed}`);
    const follow = await raw(`${base}/api/status`, { headers: good() });
    assert.equal(follow.status, 200, 'server still serving after GET /mcp');
  });

  await t.test('unauthenticated GET /mcp -> 401 (auth gates before MCP)', async () => {
    const r = await raw(`${base}/mcp`, {
      method: 'GET',
      headers: [['host', HOST], ['accept', 'application/json, text/event-stream']],
    });
    assert.equal(r.status, 401);
  });

  await t.test('many sequential MCP requests do not leak resources / crash', async () => {
    core.sessions.setMode('main', Mode.Read);
    for (let i = 0; i < 25; i++) {
      const r = await raw(`${base}/mcp`, {
        method: 'POST',
        headers: [...good(), ['accept', 'application/json, text/event-stream']],
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 100 + i,
          method: 'tools/call',
          params: { name: 'echo', arguments: { value: 'hi' } },
        }),
      });
      assert.equal(r.status, 200, `iter ${i}`);
    }
    const follow = await raw(`${base}/api/status`, { headers: good() });
    assert.equal(follow.status, 200);
  });

  // ---- Array-valued auth headers (covered for control-server path) --------

  await t.test('array-valued authorization (duplicate) first value used', async () => {
    const r = await raw(`${base}/api/status`, {
      headers: [
        ['host', HOST],
        ['authorization', `Bearer ${TOKEN}`],
        ['authorization', 'Bearer evil'],
      ],
    });
    // node may join with ", " (-> invalid) or array-first; must not be a forged pass.
    assert.ok(r.status === 200 || r.status === 401, `unexpected ${r.status}`);
  });
});
