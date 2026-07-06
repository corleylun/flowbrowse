import { RecordedAction } from './actions';
import { ActController } from '../tools/act';

export interface ReplayStep {
  action: RecordedAction;
  status: 'done' | 'skipped' | 'failed';
  detail?: string;
}

export interface ReplayResult {
  performed: number;
  skipped: number;
  failed: number;
  steps: ReplayStep[];
}

export interface ReplayDeps {
  act: ActController;
  navigate?: (url: string) => Promise<void> | void;
  tabId?: string;
  /** Abort mid-replay (e.g. the user pressed Stop). */
  shouldContinue?: () => boolean;
  /** Pause between steps (ms) so the user can follow along. Default 0 (no pause). */
  delayMs?: number;
  /** Longer pause after a submit/navigate so the new page can load. Default 1500. */
  navSettleMs?: number;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Replay a recorded sequence LITERALLY (v1 — LLM generalization/parameterization is
 * deferred). Sensitive (masked) fills are skipped, never guessed: the user fills those
 * manually. Replay is user-initiated (the user runs their own recipe), so it performs
 * actions directly via the ActController rather than as an AI tool call.
 */
export async function replayActions(actions: RecordedAction[], deps: ReplayDeps): Promise<ReplayResult> {
  const tabId = deps.tabId ?? 'main';
  const delayMs = deps.delayMs ?? 0;
  const steps: ReplayStep[] = [];
  let performed = 0;
  let skipped = 0;
  let failed = 0;

  for (let i = 0; i < actions.length; i++) {
    const action = actions[i];
    if (deps.shouldContinue && !deps.shouldContinue()) break;
    if (i > 0 && delayMs > 0) {
      // A submit/navigate likely loaded a new page — give it longer to settle before the next step.
      const prev = actions[i - 1].type;
      await sleep(prev === 'submit' || prev === 'navigate' ? Math.max(delayMs, deps.navSettleMs ?? 1500) : delayMs);
    }
    try {
      if (action.type === 'click') {
        const r = await deps.act.click(tabId, action.selector, action.label);
        if (r.clicked) {
          performed++;
          steps.push({ action, status: 'done' });
        } else {
          failed++;
          steps.push({ action, status: 'failed', detail: `no element matched (${action.label || action.selector})` });
        }
      } else if (action.type === 'fill') {
        if (action.masked || action.value === null) {
          skipped++;
          steps.push({ action, status: 'skipped', detail: 'sensitive field — fill manually' });
        } else {
          const r = await deps.act.fill(tabId, action.selector, action.value, action.label);
          if (r.filled) {
            performed++;
            steps.push({ action, status: 'done' });
          } else {
            failed++;
            steps.push({ action, status: 'failed', detail: `no field matched (${action.label || action.selector})` });
          }
        }
      } else if (action.type === 'submit') {
        const r = await deps.act.submit(tabId, action.selector, action.label);
        if (r.submitted) {
          performed++;
          steps.push({ action, status: 'done' });
        } else {
          failed++;
          steps.push({ action, status: 'failed', detail: `no field to submit (${action.label || action.selector})` });
        }
      } else if (action.type === 'navigate') {
        if (deps.navigate) {
          await deps.navigate(action.url);
          performed++;
          steps.push({ action, status: 'done' });
        } else {
          skipped++;
          steps.push({ action, status: 'skipped', detail: 'no navigator available' });
        }
      }
    } catch (e) {
      failed++;
      steps.push({ action, status: 'failed', detail: e instanceof Error ? e.message : String(e) });
    }
  }

  return { performed, skipped, failed, steps };
}
