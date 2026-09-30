/**
 * Agent replays: a watch-only recording of what an AI agent DID in the UI, so the human can step
 * back through it afterwards — up to two frames per effectful action: AT the action (target
 * marked) and its RESULT once the page settles.
 *
 * **Watch-only, by design.** Nothing here re-executes anything. Re-running an agent's actions
 * against a live site repeats real effects (submits, purchases) and rarely works anyway (pages
 * change, sessions expire); a human-driven re-run is what recipes are for.
 *
 * **HUMAN-ONLY.** No agent tool reads this store — same as history/downloads. The recordings hold
 * pixels of pages the agent was granted at the time and they outlive the grant, so an agent must
 * never be able to read them back through the broker. The chrome UI reads them over IPC that
 * main.ts restricts to the chrome view's own webContents.
 *
 * **Only what was already allowed.** A step is recorded only for an ALLOWED audit event of an
 * effectful tool — so only while the tab was granted, never during the blind period, never a
 * denied call, never a read. Frames are the rendered page, so the privacy filter (which redacts in
 * the page itself) applies to them as it does to `screenshot`; captions reuse the audit detail,
 * so `fill` never carries its value. A fill's RESULT frame does show the typed text as rendered
 * (password fields render as dots).
 *
 * Electron-free (Node fs only) so it is unit-testable; main.ts supplies frames. Layout under root:
 *
 *   config.json                 { "enabled": boolean }
 *   <sessionId>/session.json    ReplaySession
 *   <sessionId>/steps.jsonl     one ReplayStep per line
 *   <sessionId>/<n>.jpg         step n AT the action (click/fill/click_at), target marked
 *   <sessionId>/<n>-after.jpg   step n's RESULT, once the page settled
 */
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import type { AuditEvent } from '../core/audit';

export interface ReplaySession {
  id: string;
  tabId: string;
  /** The session epoch of the grant — a new grant (or revoke + re-grant) starts a new session. */
  epoch: number;
  /** The app launch it was recorded in. Epochs restart every launch, so (tab, epoch) alone would
   *  splice a fresh run onto an old session. Only the current launch's id ever matches, so a
   *  session from an earlier launch is never appended to. */
  runId?: string;
  startedAt: number;
  updatedAt: number;
  stepCount: number;
  /** Page title when the session started (display only; privacy-filtered at display time). */
  title: string;
}

/** Where the action landed, in the frame's own DIP space (`viewWidth` x `viewHeight`). */
export interface ReplayMark {
  kind: 'rect' | 'point';
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ReplayStep {
  index: number;
  ts: number;
  tool: string;
  /** The audit record's own detail — already redacted upstream. */
  detail?: string;
  url?: string;
  title?: string;
  /** Frame AT the action (target marked by `mark`); only for tools with a target. */
  frame?: string;
  mark?: ReplayMark;
  /** Frame showing the RESULT, once the page settled. */
  afterFrame?: string;
  viewWidth: number;
  viewHeight: number;
}

/** A captured frame, as main.ts supplies it. */
export interface ReplayFrame {
  jpeg: Buffer;
  viewWidth: number;
  viewHeight: number;
  url?: string;
  title?: string;
}

/** The effectful tools a replay records — the ones that change what is on screen. Reads are
 *  deliberately absent: looking is not "controlling the UI", and would bury the actions in noise. */
export const REPLAY_RECORDED_TOOLS: ReadonlySet<string> = new Set([
  'click', 'fill', 'click_at', 'move_to', 'scroll', 'scroll_to',
  'press_key', 'type_text', 'navigate', 'run_js',
]);

/** The tools that mark a target (the click outline) — the only ones an AT-action frame belongs to. */
export const REPLAY_TARGETED_TOOLS: ReadonlySet<string> = new Set(['click', 'fill', 'click_at']);

export const REPLAY_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const REPLAY_MAX_SESSIONS = 50;

/** A single safe path component — ids are generated here, but a tampered file must never steer a
 *  read or a delete outside the store root. */
export function isSafeId(s: unknown): s is string {
  return typeof s === 'string' && s.length > 0 && !s.startsWith('.') && /^[A-Za-z0-9._-]+$/.test(s);
}

function safeComponent(s: string): string {
  const out = s.replace(/[^A-Za-z0-9_]/g, '_').slice(0, 40);
  return out || 'tab';
}

export interface AppendInput {
  tabId: string;
  epoch: number;
  ts: number;
  tool: string;
  detail?: string;
  url?: string;
  title?: string;
  frameJpeg?: Buffer;
  mark?: ReplayMark;
  afterJpeg?: Buffer;
  viewWidth: number;
  viewHeight: number;
}

export class AgentReplayStore {
  /** Identifies this app launch — see `ReplaySession.runId`. */
  readonly runId = randomUUID();
  private readonly sessions = new Map<string, ReplaySession>();
  private enabledValue = true;
  private readonly listeners = new Set<() => void>();

  constructor(readonly root: string) {
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    this.load();
  }

  get enabled(): boolean {
    return this.enabledValue;
  }

  setEnabled(on: boolean): void {
    this.enabledValue = !!on;
    try {
      fs.writeFileSync(path.join(this.root, 'config.json'), JSON.stringify({ enabled: this.enabledValue }), { mode: 0o600 });
    } catch {
      /* best effort — the in-memory switch still applies this launch */
    }
    this.fire();
  }

  onChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /** Newest first. */
  listSessions(): ReplaySession[] {
    return [...this.sessions.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  steps(sessionId: unknown): ReplayStep[] {
    if (!isSafeId(sessionId)) return [];
    let text: string;
    try {
      text = fs.readFileSync(path.join(this.root, sessionId, 'steps.jsonl'), 'utf8');
    } catch {
      return [];
    }
    const out: ReplayStep[] = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line) as ReplayStep);
      } catch {
        /* skip a damaged line rather than losing the session */
      }
    }
    return out;
  }

  /** Absolute path of a frame file in a session, or null — never resolves outside the root. */
  framePath(sessionId: unknown, name: unknown): string | null {
    if (!isSafeId(sessionId) || !isSafeId(name)) return null;
    return path.join(this.root, sessionId, name);
  }

  /** Append one step. Returns it as written, or null if recording is disabled. Best-effort: a
   *  failed write drops the step, never the agent's action. */
  append(i: AppendInput): ReplayStep | null {
    if (!this.enabledValue) return null;
    let session = this.current(i.tabId, i.epoch);
    if (!session) {
      session = {
        id: `${i.ts}-${safeComponent(i.tabId)}-e${i.epoch}`,
        tabId: i.tabId,
        epoch: i.epoch,
        runId: this.runId,
        startedAt: i.ts,
        updatedAt: i.ts,
        stepCount: 0,
        title: i.title ?? '',
      };
    }
    const dir = path.join(this.root, session.id);
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    } catch {
      return null;
    }
    const index = session.stepCount + 1;
    const write = (buf: Buffer | undefined, name: string): string | undefined => {
      if (!buf || buf.length === 0) return undefined;
      try {
        fs.writeFileSync(path.join(dir, name), buf, { mode: 0o600 });
        return name;
      } catch {
        return undefined;
      }
    };
    const frame = write(i.frameJpeg, `${index}.jpg`);
    const afterFrame = write(i.afterJpeg, `${index}-after.jpg`);
    const step: ReplayStep = {
      index,
      ts: i.ts,
      tool: i.tool,
      ...(i.detail !== undefined ? { detail: i.detail } : {}),
      ...(i.url !== undefined ? { url: i.url } : {}),
      ...(i.title !== undefined ? { title: i.title } : {}),
      ...(frame ? { frame } : {}),
      ...(frame && i.mark ? { mark: i.mark } : {}), // a mark without its frame means nothing
      ...(afterFrame ? { afterFrame } : {}),
      viewWidth: i.viewWidth,
      viewHeight: i.viewHeight,
    };
    try {
      fs.appendFileSync(path.join(dir, 'steps.jsonl'), JSON.stringify(step) + '\n', { mode: 0o600 });
    } catch {
      return null;
    }
    session.stepCount = index;
    session.updatedAt = i.ts;
    if (!session.title && i.title) session.title = i.title;
    this.sessions.set(session.id, session);
    this.writeSession(session);
    this.fire();
    return step;
  }

  delete(sessionId: unknown): void {
    if (!isSafeId(sessionId)) return;
    this.sessions.delete(sessionId);
    try {
      fs.rmSync(path.join(this.root, sessionId), { recursive: true, force: true });
    } catch {
      /* already gone */
    }
    this.fire();
  }

  deleteAll(): void {
    for (const id of [...this.sessions.keys()]) {
      try {
        fs.rmSync(path.join(this.root, id), { recursive: true, force: true });
      } catch {
        /* already gone */
      }
    }
    this.sessions.clear();
    this.fire();
  }

  /** Drop sessions last updated before now - retention, then keep only the newest maxSessions. */
  prune(now: number, retentionMs = REPLAY_RETENTION_MS, maxSessions = REPLAY_MAX_SESSIONS): void {
    const doomed = this.listSessions()
      .filter((s, idx) => idx >= maxSessions || s.updatedAt < now - retentionMs)
      .map((s) => s.id);
    for (const id of doomed) this.delete(id);
  }

  private current(tabId: string, epoch: number): ReplaySession | undefined {
    for (const s of this.sessions.values()) {
      if (s.tabId === tabId && s.epoch === epoch && s.runId === this.runId) return s;
    }
    return undefined;
  }

  private load(): void {
    try {
      const cfg = JSON.parse(fs.readFileSync(path.join(this.root, 'config.json'), 'utf8')) as { enabled?: unknown };
      if (typeof cfg.enabled === 'boolean') this.enabledValue = cfg.enabled;
    } catch {
      /* no config yet — default on */
    }
    let entries: string[] = [];
    try {
      entries = fs.readdirSync(this.root);
    } catch {
      return;
    }
    for (const name of entries) {
      if (!isSafeId(name) || name === 'config.json') continue;
      try {
        const s = JSON.parse(fs.readFileSync(path.join(this.root, name, 'session.json'), 'utf8')) as ReplaySession;
        if (s && s.id === name && typeof s.tabId === 'string') this.sessions.set(s.id, s);
      } catch {
        /* not a session dir */
      }
    }
  }

  private writeSession(s: ReplaySession): void {
    try {
      fs.writeFileSync(path.join(this.root, s.id, 'session.json'), JSON.stringify(s), { mode: 0o600 });
    } catch {
      /* best effort */
    }
  }

  private fire(): void {
    for (const cb of this.listeners) {
      try {
        cb();
      } catch {
        /* a UI listener must never break recording */
      }
    }
  }
}

/** What the recorder needs from main.ts — Electron stays out of this file. */
export interface ReplayFrameSource {
  /** Capture the tab now, or null (no such tab, hidden, empty capture). */
  capture(tabId: string): Promise<ReplayFrame | null>;
  /** Resolve once the tab has settled after an action (load done + a short render wait, capped). */
  settle(tabId: string): Promise<void>;
}

const PENDING_TTL_MS = 5000;

/**
 * Turns the agent's ALLOWED effectful tool calls into replay steps. Fed by the audit sink's
 * `onRecord` (`handle`) and by the page controller's highlight hook (`noteTarget`).
 *
 * The AT-action frame is captured the moment the target is marked — the page as it was when the
 * action landed, before a click's navigation replaces it. The RESULT frame is captured once the
 * page settles. Steps are appended strictly in audit order: each waits for the previous write.
 * Limit: if the agent's next action starts before the page settles (< ~1s), the result frame may
 * already include it.
 */
export class AgentReplayRecorder {
  private readonly pending = new Map<string, { frame: Promise<ReplayFrame | null>; mark: ReplayMark; at: number }>();
  private tail: Promise<void> = Promise.resolve();

  /**
   * @param isAgentActing true while an AGENT call may be acting on the tab — false while the
   *   human's own recipe replay runs, so its marks never enter an agent recording.
   */
  constructor(
    private readonly store: AgentReplayStore,
    private readonly frames: ReplayFrameSource,
    private readonly isAgentActing: (tabId: string) => boolean,
    private readonly now: () => number = Date.now,
  ) {}

  /** The page controller marked an action's target on `tabId`. */
  noteTarget(tabId: string, mark: ReplayMark): void {
    if (!this.store.enabled || !this.isAgentActing(tabId)) return;
    const frame = this.frames.capture(tabId).catch(() => null);
    this.pending.set(tabId, { frame, mark, at: this.now() });
  }

  /** Feed every audit event here. Only ALLOWED events of an effectful tool become steps. */
  handle(event: AuditEvent): void {
    const tabId = event.tabId;
    // Consume the pending target on EVERY event for the tab — a mark whose call was then
    // denied/revoked must not attach to the agent's next step.
    const p = this.pending.get(tabId);
    this.pending.delete(tabId);
    if (!this.store.enabled || event.outcome !== 'allowed' || !REPLAY_RECORDED_TOOLS.has(event.toolName)) return;
    const targeted = p && REPLAY_TARGETED_TOOLS.has(event.toolName) && this.now() - p.at < PENDING_TTL_MS ? p : undefined;
    this.tail = this.tail
      .then(async () => {
        const atAction = targeted ? await targeted.frame : null;
        await this.frames.settle(tabId).catch(() => undefined);
        const result = await this.frames.capture(tabId).catch(() => null);
        const size = atAction ?? result;
        this.store.append({
          tabId,
          epoch: event.epoch,
          ts: event.ts,
          tool: event.toolName,
          detail: event.detail,
          url: result?.url ?? atAction?.url,
          title: result?.title ?? atAction?.title,
          frameJpeg: atAction?.jpeg,
          mark: atAction ? targeted?.mark : undefined,
          afterJpeg: result?.jpeg,
          viewWidth: size?.viewWidth ?? 0,
          viewHeight: size?.viewHeight ?? 0,
        });
      })
      .catch(() => undefined); // recording is best-effort; never break the chain
  }

  /** Test hook: tabs holding an AT-action frame not yet consumed. */
  pendingTabs(): string[] {
    return [...this.pending.keys()];
  }

  /** Test hook: resolves once every queued step has been written. */
  drain(): Promise<void> {
    return this.tail;
  }
}
