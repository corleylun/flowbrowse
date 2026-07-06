import { Mode } from '../core/modes';
import { RiskLevel, Tool, Parser } from '../core/tool';

export interface PageLink {
  href: string;
  text: string;
}
export interface PageExtract {
  url: string;
  title: string;
  text: string;
  links: PageLink[];
}
export interface Screenshot {
  mimeType: string;
  base64: string;
  /** Set when the capture came back empty — typically a hidden/backgrounded tab (capturePage on
   *  a non-visible WebContentsView can legitimately return nothing). Never engineered around by
   *  forcing visibility; this is an honest note, not a fix. */
  note?: string;
}

/**
 * Brokered access to the active page. Implemented by the main process (Electron); kept
 * as an interface here so the read tools stay Electron-free and unit-testable, and so
 * tool handlers never touch raw `webContents` directly.
 *
 * NO-RETROACTIVE-LEAK: every method reads the page LIVE, on demand. Nothing is buffered
 * while a tab is Blocked, so granting Read never hands over anything the page showed
 * earlier (e.g. a login) — the AI only ever sees the current state at call time.
 */
export interface PageController {
  extract(tabId: string): Promise<PageExtract>;
  screenshot(tabId: string): Promise<Screenshot>;
}

/** Read tools take no arguments; reject any non-empty/garbage input (fail closed). */
const noArgs: Parser<Record<string, never>> = {
  parse(raw) {
    if (raw !== undefined && raw !== null && typeof raw !== 'object') {
      throw new Error('this tool takes no arguments');
    }
    return {};
  },
};

/**
 * The Read-tier tools: `read_page` and `screenshot`. Both are pure introspection — no
 * approval, no mutation — and require the tab to be at least in Read mode.
 */
export function createReadTools(page: PageController): Tool[] {
  const readPage: Tool<Record<string, never>, PageExtract> = {
    name: 'read_page',
    description: 'Read the current page: URL, title, visible text, and links.',
    minMode: Mode.Read,
    risk: RiskLevel.Low,
    requiresApproval: false,
    inputSchema: noArgs,
    handler: (_input, ctx) => page.extract(ctx.tabId),
  };

  const screenshot: Tool<Record<string, never>, Screenshot> = {
    name: 'screenshot',
    description: 'Capture a screenshot of the current page (PNG, base64).',
    minMode: Mode.Read,
    risk: RiskLevel.Low,
    requiresApproval: false,
    inputSchema: noArgs,
    handler: (_input, ctx) => page.screenshot(ctx.tabId),
  };

  return [readPage, screenshot];
}
