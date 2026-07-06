/**
 * Outbound feedback channel. Used by BOTH the in-app "Send feedback" box and the
 * approval-gated `submit_feedback` agent tool — one shared submitter so the payload shape and
 * the destination are identical and tested in one place.
 *
 * This is, by design, the one place SafeCoBrowser sends user-authored text to an external
 * server, so it is deliberately narrow: a fixed endpoint, a small validated payload, no page
 * content. The agent path is additionally gated by the broker (Act-tier + approval).
 */

export const FEEDBACK_ENDPOINT =
  process.env.SAFECOBROWSER_FEEDBACK_URL ?? 'https://flowstations.net/api/feedback';

export type FeedbackSource = 'agent' | 'user';

export interface FeedbackInput {
  message: string;
  email?: string;
  source: FeedbackSource;
  /** Non-identifying app metadata (e.g. "SafeCoBrowser 0.0.1 / darwin"). Never page content. */
  context?: string;
}

export interface FeedbackResult {
  ok: boolean;
  status?: number;
  error?: string;
}

const MAX_MESSAGE = 5000;
const MAX_EMAIL = 200;
const MAX_CONTEXT = 500;

/** Validate + normalise a raw submission; throws on invalid (fail closed). */
export function normalizeFeedback(raw: {
  message?: unknown;
  email?: unknown;
  source?: unknown;
  context?: unknown;
}): FeedbackInput {
  const message = typeof raw.message === 'string' ? raw.message.trim() : '';
  if (message.length < 2) throw new Error('feedback message is required');
  const source: FeedbackSource = raw.source === 'agent' ? 'agent' : 'user';
  const email =
    typeof raw.email === 'string' && raw.email.trim() ? raw.email.trim().slice(0, MAX_EMAIL) : undefined;
  const context =
    typeof raw.context === 'string' && raw.context.trim()
      ? raw.context.trim().slice(0, MAX_CONTEXT)
      : undefined;
  return { message: message.slice(0, MAX_MESSAGE), email, source, context };
}

/** Minimal fetch shape so tests can inject a fake without DOM/Node typings. */
export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number }>;

/** POST a normalised submission to the feedback endpoint. Never throws — returns a result. */
export async function submitFeedback(
  raw: { message?: unknown; email?: unknown; source?: unknown; context?: unknown },
  opts: { endpoint?: string; fetchFn?: FetchLike; timeoutMs?: number } = {},
): Promise<FeedbackResult> {
  let input: FeedbackInput;
  try {
    input = normalizeFeedback(raw);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'invalid feedback' };
  }
  const endpoint = opts.endpoint ?? FEEDBACK_ENDPOINT;
  const doFetch = opts.fetchFn ?? (globalThis.fetch as unknown as FetchLike);
  try {
    const res = await doFetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 10000),
    });
    if (!res.ok) return { ok: false, status: res.status, error: `server returned ${res.status}` };
    return { ok: true, status: res.status };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'network error' };
  }
}
