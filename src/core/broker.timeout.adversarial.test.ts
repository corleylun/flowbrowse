import test from 'node:test';
import assert from 'node:assert/strict';

import { Mode } from './modes';
import { RiskLevel, Tool, ToolRegistry, Parser, ToolContext } from './tool';
import { SessionManager } from './session';
import { DenyAllApprovalProvider } from './approval';
import { MemoryAuditSink } from './audit';
import { Broker } from './broker';
import { DenyReason } from './errors';

const anySchema: Parser<unknown> = { parse: (raw) => raw };

function makeBroker(handlerTimeoutMs?: number) {
  const registry = new ToolRegistry();
  const sessions = new SessionManager();
  const audit = new MemoryAuditSink();
  const broker = new Broker(registry, sessions, new DenyAllApprovalProvider(), audit, { handlerTimeoutMs });
  return { registry, sessions, audit, broker };
}

// T1. A hung handler that never resolves is abandoned as a Timeout (fails closed),
//     never wedges the call.
test('TIMEOUT: a hung handler is abandoned as Timeout', async () => {
  const { registry, sessions, audit, broker } = makeBroker(20);
  const tool: Tool<unknown, string> = {
    name: 'hang',
    description: 'hang',
    minMode: Mode.Read,
    risk: RiskLevel.Low,
    requiresApproval: false,
    inputSchema: anySchema,
    handler() {
      // never resolves
      return new Promise<string>(() => {});
    },
  };
  registry.register(tool);
  sessions.setMode('t1', Mode.Read);
  const r = await broker.invoke('t1', 'hang', {});
  assert.equal(r.ok, false);
  assert.equal(r.reason, DenyReason.Timeout);
  // Audit records a timeout as an 'error' outcome.
  assert.equal(audit.events.at(-1)?.outcome, 'error');
  assert.equal(audit.events.at(-1)?.reason, DenyReason.Timeout);
});

// T2. The timeout aborts the ctx.signal so an effectful handler that watches the
//     signal can bail. We observe signal.aborted flipping inside the handler, with a
//     handler that bails (rejects) on abort — the correct cooperative pattern.
test('TIMEOUT: ctx.signal aborts when the handler times out (cooperative bail)', async () => {
  const { registry, sessions, broker } = makeBroker(20);
  let abortedReason: unknown = null;
  let sawAbort = false;
  const tool: Tool<unknown, string> = {
    name: 'watch',
    description: 'watch',
    minMode: Mode.Read,
    risk: RiskLevel.Low,
    requiresApproval: false,
    inputSchema: anySchema,
    handler(_i, ctx: ToolContext) {
      return new Promise<string>((_resolve, reject) => {
        ctx.signal.addEventListener('abort', () => {
          sawAbort = true;
          abortedReason = ctx.signal.reason;
          reject(ctx.signal.reason); // cooperative: propagate the abort
        });
      });
    },
  };
  registry.register(tool);
  sessions.setMode('t1', Mode.Read);
  const r = await broker.invoke('t1', 'watch', {});
  assert.equal(sawAbort, true, 'handler observed the abort');
  assert.equal((abortedReason as { reason?: DenyReason })?.reason, DenyReason.Timeout);
  assert.equal(r.ok, false);
  assert.equal(r.reason, DenyReason.Timeout);
});

// T2b. FINDING (latent, not exploitable by shipped tools): the broker uses
//   Promise.race([handlerPromise, rejectOnAbort(signal)]). The handler's own abort
//   listener is registered BEFORE rejectOnAbort's (the handler is invoked first), so a
//   handler that RESOLVES synchronously inside its abort listener wins the race and its
//   result is returned despite the timeout (epoch unchanged → final liveness gate passes).
//   None of click/fill/run_js do this (they throw pre-effect), so it is contained — but
//   it means "timeout" is not strictly authoritative against an adversarial handler.
//   This test documents the ACTUAL behavior so a fix (track an `aborted` flag and force
//   the abort to win, or check signal.aborted after the race) can flip it.
test('TIMEOUT: a handler resolving in its abort listener still loses to the timeout (fixed)', async () => {
  const { registry, sessions, broker } = makeBroker(15);
  const tool: Tool<unknown, string> = {
    name: 'evilabort',
    description: 'evilabort',
    minMode: Mode.Read,
    risk: RiskLevel.Low,
    requiresApproval: false,
    inputSchema: anySchema,
    handler(_i, ctx: ToolContext) {
      return new Promise<string>((resolve) => {
        ctx.signal.addEventListener('abort', () => resolve('DEFEATED_TIMEOUT'));
      });
    },
  };
  registry.register(tool);
  sessions.setMode('t1', Mode.Read);
  const r = await broker.invoke<string>('t1', 'evilabort', {});
  // The post-race signal check makes the abort authoritative: the handler cannot slip a
  // result through by resolving inside its own abort listener.
  assert.equal(r.ok, false);
  assert.equal(r.reason, DenyReason.Timeout);
  assert.notEqual(r.output, 'DEFEATED_TIMEOUT');
});

// T3. A handler that resolves with a value JUST as the timer is about to fire still
//     succeeds if it wins the race; if the value is produced before the timeout the
//     result must be returned (no spurious timeout for a fast handler).
test('TIMEOUT: a fast handler is not spuriously timed out', async () => {
  const { registry, sessions, broker } = makeBroker(1000);
  const tool: Tool<unknown, string> = {
    name: 'fast',
    description: 'fast',
    minMode: Mode.Read,
    risk: RiskLevel.Low,
    requiresApproval: false,
    inputSchema: anySchema,
    async handler() {
      return 'quick';
    },
  };
  registry.register(tool);
  sessions.setMode('t1', Mode.Read);
  const r = await broker.invoke<string>('t1', 'fast', {});
  assert.equal(r.ok, true);
  assert.equal(r.output, 'quick');
});

// T4. Revoke beats timeout: if a revoke lands before the timeout, the reason is
//     Revoked (not Timeout) and the result is discarded.
test('TIMEOUT: revoke during a slow handler reports Revoked, not Timeout', async () => {
  const { registry, sessions, broker } = makeBroker(10_000);
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let started!: () => void;
  const startedP = new Promise<void>((r) => (started = r));
  const tool: Tool<unknown, string> = {
    name: 'slow',
    description: 'slow',
    minMode: Mode.Read,
    risk: RiskLevel.Low,
    requiresApproval: false,
    inputSchema: anySchema,
    async handler() {
      started();
      await gate;
      return 'done';
    },
  };
  registry.register(tool);
  sessions.setMode('t1', Mode.Read);
  const pending = broker.invoke('t1', 'slow', {});
  await startedP;
  sessions.revoke('t1');
  release();
  const r = await pending;
  assert.equal(r.ok, false);
  assert.equal(r.reason, DenyReason.Revoked, 'revoke wins over timeout');
});

// T5. A handler that RESOLVES after a timeout has already been declared must not
//     "un-timeout" the call or produce a second settlement / leak a result.
test('TIMEOUT: a late-resolving handler cannot override a declared timeout', async () => {
  const { registry, sessions, broker } = makeBroker(15);
  let resolveHandler!: (v: string) => void;
  const tool: Tool<unknown, string> = {
    name: 'lateresolve',
    description: 'lateresolve',
    minMode: Mode.Read,
    risk: RiskLevel.Low,
    requiresApproval: false,
    inputSchema: anySchema,
    handler() {
      return new Promise<string>((res) => {
        resolveHandler = res;
      });
    },
  };
  registry.register(tool);
  sessions.setMode('t1', Mode.Read);
  const r = await broker.invoke<string>('t1', 'lateresolve', {});
  assert.equal(r.ok, false);
  assert.equal(r.reason, DenyReason.Timeout);
  // Now resolve the handler late — must NOT throw an unhandled rejection or change result.
  resolveHandler('TOO_LATE');
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(r.output, undefined, 'late result never leaks');
});

// T6. A handler that REJECTS after a timeout was declared must not surface as an
//     unhandled rejection (broker swallows the late rejection).
test('TIMEOUT: a late-rejecting handler does not cause an unhandled rejection', async () => {
  const { registry, sessions, broker } = makeBroker(15);
  let rejectHandler!: (e: Error) => void;
  const tool: Tool<unknown, string> = {
    name: 'latereject',
    description: 'latereject',
    minMode: Mode.Read,
    risk: RiskLevel.Low,
    requiresApproval: false,
    inputSchema: anySchema,
    handler() {
      return new Promise<string>((_res, rej) => {
        rejectHandler = rej;
      });
    },
  };
  registry.register(tool);
  sessions.setMode('t1', Mode.Read);

  let unhandled: unknown = null;
  const onUnhandled = (e: unknown) => (unhandled = e);
  process.on('unhandledRejection', onUnhandled);
  const r = await broker.invoke('t1', 'latereject', {});
  assert.equal(r.reason, DenyReason.Timeout);
  rejectHandler(new Error('late boom with secret=hunter2'));
  await new Promise((res) => setTimeout(res, 20));
  process.off('unhandledRejection', onUnhandled);
  assert.equal(unhandled, null, 'late handler rejection must be swallowed');
});

// T7. Timeout detail / message must not leak handler internals to the caller; the
//     caller-facing message for a timeout is the authored BrokerError text.
test('TIMEOUT: timeout caller message is the authored text, not handler internals', async () => {
  const { registry, sessions, broker } = makeBroker(10);
  const tool: Tool<unknown, string> = {
    name: 'hang2',
    description: 'hang2',
    minMode: Mode.Read,
    risk: RiskLevel.Low,
    requiresApproval: false,
    inputSchema: anySchema,
    handler() {
      return new Promise<string>(() => {});
    },
  };
  registry.register(tool);
  sessions.setMode('t1', Mode.Read);
  const r = await broker.invoke('t1', 'hang2', {});
  assert.equal(r.reason, DenyReason.Timeout);
  assert.match(String(r.message), /timed out/);
});
