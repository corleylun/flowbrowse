import test from 'node:test';
import assert from 'node:assert/strict';

import { Mode } from './modes';
import { RiskLevel, Tool, ToolRegistry, Parser } from './tool';
import { SessionManager } from './session';
import { ApprovalProvider, DenyAllApprovalProvider } from './approval';
import { MemoryAuditSink } from './audit';
import { Broker } from './broker';
import { DenyReason } from './errors';

// --- fixtures ---

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
  description: 'echo the value uppercased',
  minMode: Mode.Read,
  risk: RiskLevel.Low,
  requiresApproval: false,
  inputSchema: echoSchema,
  async handler(input) {
    return input.value.toUpperCase();
  },
};

const actTool: Tool<{ value: string }, string> = {
  name: 'doAct',
  description: 'a high-risk action that needs approval',
  minMode: Mode.Act,
  risk: RiskLevel.High,
  requiresApproval: true,
  inputSchema: echoSchema,
  async handler(input) {
    return `acted:${input.value}`;
  },
};

class ApproveAll implements ApprovalProvider {
  async request() {
    return { approved: true };
  }
}

function build(approval: ApprovalProvider = new DenyAllApprovalProvider()) {
  const registry = new ToolRegistry();
  registry.register(echoTool);
  registry.register(actTool);
  const sessions = new SessionManager();
  const audit = new MemoryAuditSink();
  const broker = new Broker(registry, sessions, approval, audit);
  return { registry, sessions, audit, broker };
}

// --- tests ---

test('unknown tool fails closed', async () => {
  const { broker, sessions } = build();
  sessions.setMode('t1', Mode.Develop); // even at max privilege
  const r = await broker.invoke('t1', 'nope', {});
  assert.equal(r.ok, false);
  assert.equal(r.reason, DenyReason.UnknownTool);
});

test('denies when tab mode is below the tool minMode', async () => {
  const { broker } = build(); // tab defaults to Blocked
  const r = await broker.invoke('t1', 'echo', { value: 'hi' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, DenyReason.PermissionDenied);
});

test('allows when tab mode meets the tool minMode', async () => {
  const { broker, sessions } = build();
  sessions.setMode('t1', Mode.Read);
  const r = await broker.invoke<string>('t1', 'echo', { value: 'hi' });
  assert.equal(r.ok, true);
  assert.equal(r.output, 'HI');
});

test('invalid input fails closed', async () => {
  const { broker, sessions } = build();
  sessions.setMode('t1', Mode.Read);
  const r = await broker.invoke('t1', 'echo', { value: 123 });
  assert.equal(r.ok, false);
  assert.equal(r.reason, DenyReason.InvalidInput);
});

test('approval-required tool is denied by default (fail closed, no mechanism)', async () => {
  const { broker, sessions } = build(); // DenyAll → available:false
  sessions.setMode('t1', Mode.Act);
  const r = await broker.invoke('t1', 'doAct', { value: 'x' });
  assert.equal(r.ok, false);
  // No approval mechanism available → ApprovalRequired (not a user rejection).
  assert.equal(r.reason, DenyReason.ApprovalRequired);
});

test('explicit user rejection is audited as ApprovalRejected (not ApprovalRequired)', async () => {
  const rejectProvider: ApprovalProvider = {
    async request() {
      return { approved: false, available: true }; // a real user said no
    },
  };
  const { broker, sessions } = build(rejectProvider);
  sessions.setMode('t1', Mode.Act);
  const r = await broker.invoke('t1', 'doAct', { value: 'x' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, DenyReason.ApprovalRejected);
});

test('approval-required tool runs only when approved', async () => {
  const { broker, sessions } = build(new ApproveAll());
  sessions.setMode('t1', Mode.Act);
  const r = await broker.invoke<string>('t1', 'doAct', { value: 'x' });
  assert.equal(r.ok, true);
  assert.equal(r.output, 'acted:x');
});

test('revocation DURING execution discards the result', async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((res) => (release = res));
  const slow: Tool<unknown, string> = {
    name: 'slow',
    description: 'waits',
    minMode: Mode.Read,
    risk: RiskLevel.Low,
    requiresApproval: false,
    inputSchema: { parse: () => ({}) },
    async handler() {
      await gate;
      return 'done';
    },
  };
  const registry = new ToolRegistry();
  registry.register(slow);
  const sessions = new SessionManager();
  const broker = new Broker(registry, sessions, new DenyAllApprovalProvider(), new MemoryAuditSink());

  sessions.setMode('t1', Mode.Read);
  const pending = broker.invoke('t1', 'slow', {});
  sessions.revoke('t1'); // "Stop AI" lands while the handler is still running
  release();
  const r = await pending;
  assert.equal(r.ok, false);
  assert.equal(r.reason, DenyReason.Revoked);
});

test('every decision is audited (allow + deny)', async () => {
  const { broker, sessions, audit } = build();
  await broker.invoke('t1', 'echo', { value: 'x' }); // denied: tab Blocked
  sessions.setMode('t1', Mode.Read);
  await broker.invoke('t1', 'echo', { value: 'x' }); // allowed
  assert.equal(audit.events.length, 2);
  assert.equal(audit.events[0].outcome, 'denied');
  assert.equal(audit.events[0].reason, DenyReason.PermissionDenied);
  assert.equal(audit.events[1].outcome, 'allowed');
});

test('tool.preview flows into the approval request (and a preview error never blocks)', async () => {
  const captured: Array<{ preview: unknown }> = [];
  const provider: ApprovalProvider = {
    async request(req) {
      captured.push({ preview: req.preview });
      return { approved: true };
    },
  };
  const registry = new ToolRegistry();
  const withPreview: Tool<{ x: number }, string> = {
    name: 'tap', description: 'tap', minMode: Mode.Act, risk: RiskLevel.Medium, requiresApproval: true,
    inputSchema: { parse: (r) => r as { x: number } },
    preview: async (i) => ({ image: 'IMG', w: 4, h: 4, x: i.x, y: i.x }),
    async handler() { return 'ok'; },
  };
  const boom: Tool<unknown, string> = {
    name: 'boom', description: 'boom', minMode: Mode.Act, risk: RiskLevel.Medium, requiresApproval: true,
    inputSchema: { parse: () => ({}) },
    preview: async () => { throw new Error('capture failed'); },
    async handler() { return 'ok'; },
  };
  registry.register(withPreview);
  registry.register(boom);
  const sessions = new SessionManager();
  const broker = new Broker(registry, sessions, provider, new MemoryAuditSink());
  sessions.setMode('t1', Mode.Act);

  const r1 = await broker.invoke('t1', 'tap', { x: 7 });
  assert.equal(r1.ok, true);
  assert.deepEqual(captured[0].preview, { image: 'IMG', w: 4, h: 4, x: 7, y: 7 });

  // A throwing preview must NOT fail the call — approval proceeds with no preview.
  const r2 = await broker.invoke('t1', 'boom', {});
  assert.equal(r2.ok, true);
  assert.equal(captured[1].preview, undefined);
});

test('auditResult appends an output-derived suffix; auditDetail redaction is preserved', async () => {
  const registry = new ToolRegistry();
  const tool: Tool<{ selector: string }, { realInput: boolean }> = {
    name: 'tap',
    description: 'tap',
    minMode: Mode.Read,
    risk: RiskLevel.Low,
    requiresApproval: false,
    auditDetail: (i) => i.selector,
    auditResult: (o) => (o.realInput ? 'real input' : undefined),
    inputSchema: { parse: (r) => r as { selector: string } },
    async handler(i) {
      return { realInput: i.selector === '#real' };
    },
  };
  registry.register(tool);
  const sessions = new SessionManager();
  const audit = new MemoryAuditSink();
  const broker = new Broker(registry, sessions, new DenyAllApprovalProvider(), audit);
  sessions.setMode('t1', Mode.Read);

  await broker.invoke('t1', 'tap', { selector: '#real' });
  assert.equal(audit.events.at(-1)?.detail, '#real [real input]');

  await broker.invoke('t1', 'tap', { selector: '#plain' });
  assert.equal(audit.events.at(-1)?.detail, '#plain'); // no suffix when realInput is false
});

test('audit on mid-flight revoke records the live (revoked) state, not the stale snapshot', async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((res) => (release = res));
  const slow: Tool<unknown, string> = {
    name: 'slow2',
    description: 'waits',
    minMode: Mode.Read,
    risk: RiskLevel.Low,
    requiresApproval: false,
    inputSchema: { parse: () => ({}) },
    async handler() {
      await gate;
      return 'done';
    },
  };
  const registry = new ToolRegistry();
  registry.register(slow);
  const sessions = new SessionManager();
  const audit = new MemoryAuditSink();
  const broker = new Broker(registry, sessions, new DenyAllApprovalProvider(), audit);

  sessions.setMode('t1', Mode.Read);
  const pending = broker.invoke('t1', 'slow2', {});
  const revoked = sessions.revoke('t1'); // Blocked, fresh epoch
  release();
  const r = await pending;

  assert.equal(r.reason, DenyReason.Revoked);
  const ev = audit.events.at(-1)!;
  assert.equal(ev.reason, DenyReason.Revoked);
  assert.equal(ev.mode, Mode.Blocked, 'audit shows the revoked mode, not the stale read');
  assert.equal(ev.epoch, revoked.epoch, 'audit shows the live (post-revoke) epoch');
});

test('handler exceeding the timeout fails closed as a timeout', async () => {
  const slow: Tool<unknown, string> = {
    name: 'forever',
    description: 'never resolves',
    minMode: Mode.Read,
    risk: RiskLevel.Low,
    requiresApproval: false,
    inputSchema: { parse: () => ({}) },
    handler: () => new Promise<string>(() => {}), // never resolves
  };
  const registry = new ToolRegistry();
  registry.register(slow);
  const sessions = new SessionManager();
  const audit = new MemoryAuditSink();
  const broker = new Broker(registry, sessions, new DenyAllApprovalProvider(), audit, {
    handlerTimeoutMs: 40,
  });
  sessions.setMode('t1', Mode.Read);
  const r = await broker.invoke('t1', 'forever', {});
  assert.equal(r.ok, false);
  assert.equal(r.reason, DenyReason.Timeout);
  assert.equal(audit.events.at(-1)?.outcome, 'error');
});

test('revoke aborts an in-flight handler PROMPTLY via ctx.signal (no wait for handler)', async () => {
  let sawAbort = false;
  const waits: Tool<unknown, string> = {
    name: 'awaitAbort',
    description: 'resolves only when aborted',
    minMode: Mode.Read,
    risk: RiskLevel.Low,
    requiresApproval: false,
    inputSchema: { parse: () => ({}) },
    handler: (_input, ctx) =>
      new Promise<string>((resolve) => {
        // Effectful handlers watch the signal; here we never resolve on our own.
        ctx.signal.addEventListener('abort', () => {
          sawAbort = true;
          resolve('too late');
        });
      }),
  };
  const registry = new ToolRegistry();
  registry.register(waits);
  const sessions = new SessionManager();
  const broker = new Broker(registry, sessions, new DenyAllApprovalProvider(), new MemoryAuditSink());
  sessions.setMode('t1', Mode.Read);
  const pending = broker.invoke('t1', 'awaitAbort', {});
  await Promise.resolve(); // let the handler attach its abort listener
  sessions.revoke('t1'); // Stop AI → should abort the call without the handler resolving on its own
  const r = await pending;
  assert.equal(r.ok, false);
  assert.equal(r.reason, DenyReason.Revoked);
  assert.equal(sawAbort, true, 'handler observed the abort via ctx.signal');
});

test('throwing handler: caller gets a generic message, audit keeps the full detail', async () => {
  const boom: Tool<unknown, string> = {
    name: 'boom2',
    description: 'boom',
    minMode: Mode.Read,
    risk: RiskLevel.Low,
    requiresApproval: false,
    inputSchema: { parse: () => ({}) },
    async handler() {
      throw new Error('internal failure secret=hunter2');
    },
  };
  const registry = new ToolRegistry();
  registry.register(boom);
  const sessions = new SessionManager();
  const audit = new MemoryAuditSink();
  const broker = new Broker(registry, sessions, new DenyAllApprovalProvider(), audit);

  sessions.setMode('t1', Mode.Read);
  const r = await broker.invoke('t1', 'boom2', {});

  assert.equal(r.ok, false);
  assert.equal(r.reason, DenyReason.HandlerError);
  assert.equal(r.message, 'tool handler failed', 'caller gets a generic message');
  assert.doesNotMatch(String(r.message), /hunter2/, 'secret never leaks to the caller');
  const ev = audit.events.at(-1)!;
  assert.match(String(ev.detail), /hunter2/, 'full detail retained in the audit only');
});
