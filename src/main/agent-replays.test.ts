import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  AgentReplayRecorder,
  AgentReplayStore,
  REPLAY_RECORDED_TOOLS,
  isSafeId,
  type ReplayFrame,
  type ReplayFrameSource,
  type ReplayMark,
} from './agent-replays';
import type { AuditEvent } from '../core/audit';

const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'agent-replays-'));
const jpg = (b: number): Buffer => Buffer.from([0xff, 0xd8, b]);

function add(store: AgentReplayStore, o: Partial<Parameters<AgentReplayStore['append']>[0]> = {}) {
  return store.append({
    tabId: 't1', epoch: 1, ts: 1000, tool: 'click', detail: '#go', url: 'https://example.com/', title: 'Example',
    frameJpeg: jpg(1), viewWidth: 800, viewHeight: 600, ...o,
  });
}

// --- store ---

test('store: steps append in order within one grant; both frames and the mark are kept', () => {
  const store = new AgentReplayStore(tmp());
  const mark: ReplayMark = { kind: 'rect', x: 40, y: 50, w: 120, h: 40 };
  add(store, { ts: 1000, mark, afterJpeg: jpg(2) });
  add(store, { ts: 2000, tool: 'navigate', frameJpeg: undefined, afterJpeg: jpg(3) });
  const [s] = store.listSessions();
  assert.equal(s.stepCount, 2);
  const steps = store.steps(s.id);
  assert.deepEqual(steps.map((x) => x.tool), ['click', 'navigate']);
  assert.equal(steps[0].frame, '1.jpg');
  assert.equal(steps[0].afterFrame, '1-after.jpg');
  assert.deepEqual(steps[0].mark, mark);
  assert.equal(steps[1].frame, undefined);
  assert.deepEqual(fs.readFileSync(store.framePath(s.id, steps[0].afterFrame)!), jpg(2));
});

test('store: a new grant (epoch) or another tab starts a new session; newest first', () => {
  const store = new AgentReplayStore(tmp());
  add(store, { epoch: 1, ts: 1000 });
  add(store, { epoch: 1, ts: 1100 });
  add(store, { epoch: 2, ts: 2000 });
  add(store, { tabId: 't2', epoch: 1, ts: 3000 });
  const sessions = store.listSessions();
  assert.equal(sessions.length, 3);
  assert.equal(sessions[0].tabId, 't2');
  assert.deepEqual(sessions.map((s) => s.stepCount).sort(), [1, 1, 2]);
});

test('store: a relaunch never appends to an old session (epochs restart every launch)', () => {
  const root = tmp();
  const a = new AgentReplayStore(root);
  add(a, { ts: 1000 });
  add(a, { ts: 2000 });
  const b = new AgentReplayStore(root); // relaunch: same tab, same epoch 1
  assert.equal(b.listSessions().length, 1, 'old session loads');
  add(b, { ts: 3000 });
  assert.deepEqual(b.listSessions().map((s) => s.stepCount), [1, 2]);
});

test('store: disabled writes nothing, and the switch persists', () => {
  const root = tmp();
  const store = new AgentReplayStore(root);
  store.setEnabled(false);
  assert.equal(add(store), null);
  assert.equal(store.listSessions().length, 0);
  assert.equal(new AgentReplayStore(root).enabled, false);
});

test('store: a mark without its frame is dropped', () => {
  const store = new AgentReplayStore(tmp());
  const step = add(store, { frameJpeg: undefined, mark: { kind: 'point', x: 1, y: 2, w: 0, h: 0 } })!;
  assert.equal(step.frame, undefined);
  assert.equal(step.mark, undefined);
});

test('store: prune drops sessions past retention and beyond the cap, newest kept', () => {
  const store = new AgentReplayStore(tmp());
  const day = 24 * 60 * 60 * 1000;
  const now = 100 * day;
  add(store, { tabId: 'old', ts: now - 8 * day });
  for (let i = 0; i < 5; i++) add(store, { tabId: `t${i}`, ts: now - i * 1000 });
  store.prune(now, 7 * day, 3);
  assert.deepEqual(store.listSessions().map((s) => s.tabId), ['t0', 't1', 't2']);
});

test('store: delete / deleteAll remove files', () => {
  const root = tmp();
  const store = new AgentReplayStore(root);
  add(store, { tabId: 'a', ts: 1000 });
  add(store, { tabId: 'b', ts: 2000 });
  const a = store.listSessions().find((s) => s.tabId === 'a')!;
  store.delete(a.id);
  assert.equal(fs.existsSync(path.join(root, a.id)), false);
  store.deleteAll();
  assert.equal(store.listSessions().length, 0);
});

test('store: ids that could escape the root are refused', () => {
  const store = new AgentReplayStore(tmp());
  for (const bad of ['..', '.', '../x', 'a/b', '', '.hidden', 'a\\b']) {
    assert.equal(isSafeId(bad), false, bad);
    assert.deepEqual(store.steps(bad), []);
    assert.equal(store.framePath('1-t1-e1', bad), null);
  }
  assert.equal(isSafeId(42), false);
});

test('store: only effectful tools are recorded; reads are not', () => {
  for (const t of ['click', 'fill', 'click_at', 'navigate', 'run_js', 'type_text', 'press_key', 'scroll', 'scroll_to', 'move_to']) {
    assert.ok(REPLAY_RECORDED_TOOLS.has(t), t);
  }
  for (const t of ['read_page', 'screenshot', 'inspect_element', 'read_console', 'read_network', 'read_network_body', 'locate', 'read_screen_text', 'list_tabs', 'get_mode', 'list_recipes', 'get_recipe', 'submit_feedback']) {
    assert.ok(!REPLAY_RECORDED_TOOLS.has(t), t);
  }
});

// --- recorder ---

function frames(): ReplayFrameSource & { captures: number } {
  let n = 0;
  const src = {
    captures: 0,
    async capture(): Promise<ReplayFrame> {
      src.captures++;
      n++;
      return { jpeg: jpg(n), viewWidth: 800, viewHeight: 600, url: `https://example.com/${n}`, title: `P${n}` };
    },
    async settle(): Promise<void> {},
  };
  return src;
}

const ev = (o: Partial<AuditEvent> = {}): AuditEvent => ({
  ts: 1000, tabId: 't1', toolName: 'click', mode: 'act', epoch: 1, outcome: 'allowed', detail: '#go', ...o,
});

test('recorder: a targeted click keeps its AT frame + mark and adds a RESULT frame', async () => {
  const store = new AgentReplayStore(tmp());
  const rec = new AgentReplayRecorder(store, frames(), () => true);
  const mark: ReplayMark = { kind: 'rect', x: 1, y: 2, w: 3, h: 4 };
  rec.noteTarget('t1', mark);
  rec.handle(ev());
  await rec.drain();
  const [s] = store.listSessions();
  const [step] = store.steps(s.id);
  assert.equal(step.frame, '1.jpg');
  assert.deepEqual(step.mark, mark);
  assert.equal(step.afterFrame, '1-after.jpg');
  assert.equal(rec.pendingTabs().length, 0);
});

test('recorder: the caption URL of an AT-action frame is the page BEFORE the click, not where it led', async () => {
  const store = new AgentReplayStore(tmp());
  const rec = new AgentReplayRecorder(store, frames(), () => true);
  rec.noteTarget('t1', { kind: 'rect', x: 1, y: 2, w: 3, h: 4 }); // 1st capture: https://example.com/1
  rec.handle(ev()); // RESULT capture afterwards: https://example.com/2
  await rec.drain();
  const [step] = store.steps(store.listSessions()[0].id);
  assert.equal(step.atUrl, 'https://example.com/1');
  assert.equal(step.url, 'https://example.com/2');
});

test('store: a step without a frame stores no atUrl; an older recording without one still loads', () => {
  const store = new AgentReplayStore(tmp());
  const nav = add(store, { tool: 'navigate', frameJpeg: undefined, afterJpeg: jpg(3), atUrl: 'https://example.com/x' })!;
  assert.equal(nav.atUrl, undefined);
  const root = tmp();
  const dir = path.join(root, '1-t1-e1');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'session.json'), JSON.stringify({ id: '1-t1-e1', tabId: 't1', epoch: 1, startedAt: 1, updatedAt: 1, stepCount: 1, title: '' }));
  fs.writeFileSync(path.join(dir, 'steps.jsonl'), JSON.stringify({ index: 1, ts: 1, tool: 'click', url: 'https://old/', frame: '1.jpg', viewWidth: 1, viewHeight: 1 }) + '\n');
  const old = new AgentReplayStore(root).steps('1-t1-e1');
  assert.equal(old[0].atUrl, undefined);
  assert.equal(old[0].url, 'https://old/');
});

test('recorder: denied calls and reads record nothing', async () => {
  const store = new AgentReplayStore(tmp());
  const rec = new AgentReplayRecorder(store, frames(), () => true);
  rec.handle(ev({ outcome: 'denied' }));
  rec.handle(ev({ toolName: 'read_page' }));
  await rec.drain();
  assert.equal(store.listSessions().length, 0);
});

test('recorder: a HUMAN recipe replay (agent not acting) never queues a frame', async () => {
  const store = new AgentReplayStore(tmp());
  const src = frames();
  const rec = new AgentReplayRecorder(store, src, () => false);
  rec.noteTarget('t1', { kind: 'point', x: 1, y: 1, w: 0, h: 0 });
  assert.deepEqual(rec.pendingTabs(), []);
  assert.equal(src.captures, 0);
});

test('recorder: a marked-then-denied call cannot attach its frame to the next step', async () => {
  const store = new AgentReplayStore(tmp());
  const rec = new AgentReplayRecorder(store, frames(), () => true);
  rec.noteTarget('t1', { kind: 'rect', x: 1, y: 1, w: 1, h: 1 });
  rec.handle(ev({ outcome: 'denied' })); // consumes the pending frame
  rec.handle(ev({ toolName: 'navigate' }));
  await rec.drain();
  const [step] = store.steps(store.listSessions()[0].id);
  assert.equal(step.frame, undefined);
  assert.equal(step.mark, undefined);
  assert.ok(step.afterFrame);
});

test('recorder: a non-targeted tool never takes a pending AT frame', async () => {
  const store = new AgentReplayStore(tmp());
  const rec = new AgentReplayRecorder(store, frames(), () => true);
  rec.noteTarget('t1', { kind: 'rect', x: 1, y: 1, w: 1, h: 1 });
  rec.handle(ev({ toolName: 'navigate' }));
  await rec.drain();
  const [step] = store.steps(store.listSessions()[0].id);
  assert.equal(step.frame, undefined);
});

test('recorder: steps are written in audit order', async () => {
  const store = new AgentReplayStore(tmp());
  const rec = new AgentReplayRecorder(store, frames(), () => true);
  for (const [i, t] of ['navigate', 'fill', 'click'].entries()) rec.handle(ev({ toolName: t, ts: 1000 + i }));
  await rec.drain();
  assert.deepEqual(store.steps(store.listSessions()[0].id).map((s) => s.tool), ['navigate', 'fill', 'click']);
});
