import { Mode } from '../core/modes';
import { RiskLevel, Tool, Parser, ToolContext } from '../core/tool';
import { BrokerError, DenyReason } from '../core/errors';
import { FeedbackResult } from '../feedback/feedback';

export interface FeedbackToolInput {
  message: string;
  email?: string;
}

const schema: Parser<FeedbackToolInput> = {
  parse(raw) {
    const o = raw as { message?: unknown; email?: unknown };
    if (typeof raw !== 'object' || raw === null || typeof o.message !== 'string') {
      throw new Error('expected { message: string }');
    }
    const message = o.message.trim();
    if (message.length < 2) throw new Error('message must not be empty');
    const email = typeof o.email === 'string' && o.email.trim() ? o.email.trim() : undefined;
    return { message: message.slice(0, 5000), email };
  },
};

/**
 * The agent-facing feedback tool. Feedback is NOT a page operation — it sends only agent-authored
 * text (never page content) to a fixed FlowStations endpoint — so it does not belong on the page
 * permission ladder: minMode is Blocked, i.e. it is callable at ANY tab mode (even Off). Its sole
 * guard is the mandatory approval card, which shows the exact message before anything is sent. This
 * keeps "Off = no access to your page/session" intact (feedback touches neither) while not forcing
 * the user to grant page-action powers just to relay an opinion. `send` is injected so the network
 * call lives in one tested place (src/feedback/feedback.ts).
 */
export function createFeedbackTool(
  send: (input: FeedbackToolInput) => Promise<FeedbackResult>,
): Tool<FeedbackToolInput, { sent: boolean }> {
  return {
    name: 'submit_feedback',
    description:
      "Send the user's feedback/opinion about SafeCoBrowser to FlowStations. Works at any tab mode; the exact text is shown to the user for approval before sending — do NOT include private page content.",
    minMode: Mode.Blocked,
    risk: RiskLevel.Medium,
    requiresApproval: true,
    // Log that feedback was sent and its size, but not the body (the user approved it on screen).
    auditDetail: (input) => `feedback submitted (${input.message.length} chars)`,
    inputSchema: schema,
    async handler(input, ctx: ToolContext) {
      if (ctx.signal.aborted || !ctx.isLive()) {
        throw new BrokerError(DenyReason.Revoked, 'revoked before feedback was sent');
      }
      const res = await send(input);
      if (!res.ok) throw new Error(res.error ?? 'feedback submission failed');
      return { sent: true };
    },
  };
}
