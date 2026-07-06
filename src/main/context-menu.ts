import { Menu, clipboard } from 'electron';
import type { WebContents } from 'electron';
import { contextMenuTemplate, chromeContextMenuTemplate } from './context-menu-template';

/**
 * Wire a right-click context menu onto a single page tab's `webContents`.
 *
 * This is **user-only UI** in the main process — it is never registered as a broker `Tool`, so the
 * agent cannot reach or observe it. It is bound **per-tab** to `wc` so that Save actions use THIS
 * tab's session/cookies (correct container) via `wc.downloadURL` → the existing per-container
 * download pipeline (no native Save dialog, agent-invisible, shown in the Downloads panel).
 *
 * `openInNewTab` must open in the SAME container (the caller passes `createTab(containerId, …)`),
 * never an OS window.
 */
export function attachPageContextMenu(wc: WebContents, openInNewTab: (url: string) => void): void {
  wc.on('context-menu', (_event, params) => {
    if (wc.isDestroyed()) return;
    const template = contextMenuTemplate(params, {
      saveUrl: (url) => wc.downloadURL(url),
      copyImageAt: (x, y) => wc.copyImageAt(x, y),
      copyText: (text) => clipboard.writeText(text),
      openInNewTab,
      replaceMisspelling: (word) => wc.replaceMisspelling(word),
      back: () => wc.navigationHistory.goBack(),
      forward: () => wc.navigationHistory.goForward(),
      reload: () => wc.reload(),
      canGoBack: wc.navigationHistory.canGoBack(),
      canGoForward: wc.navigationHistory.canGoForward(),
      pageUrl: wc.getURL(),
    });
    Menu.buildFromTemplate(template).popup();
  });
}

/**
 * Wire a minimal clipboard/spellcheck context menu onto the **chrome UI** webContents (the URL bar,
 * Settings inputs, the feedback box). This is the app's own trusted local UI — no page/save/
 * navigation items, so it stays clear of the page-menu concerns Aidan flagged for chromeView.
 * Nothing here is a broker tool; the agent never sees it.
 */
export function attachChromeContextMenu(wc: WebContents): void {
  wc.on('context-menu', (_event, params) => {
    if (wc.isDestroyed()) return;
    const template = chromeContextMenuTemplate(params, (word) => wc.replaceMisspelling(word));
    if (template.length) Menu.buildFromTemplate(template).popup();
  });
}
