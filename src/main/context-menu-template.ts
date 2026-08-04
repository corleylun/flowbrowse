import type { ContextMenuParams, MenuItemConstructorOptions } from 'electron';

/**
 * Pure builder for the page right-click menu — decides *which* items appear for a given
 * `context-menu` event and wires each to an injected action. No Electron runtime import (types
 * only), so it is unit-testable under `node --test`. The Electron glue (Menu.popup, the real
 * actions) lives in context-menu.ts.
 *
 * Security/model notes baked in here:
 *  - Save Image / Save Link As only appear for **http(s)** URLs — `downloadURL` is unreliable on
 *    `blob:`/`data:` (the blob lives in the renderer), so we don't offer a no-op item.
 *  - Open in New Tab only appears for http(s) and goes through `openInNewTab` (the same-container
 *    popup path), never an OS window.
 *  - **Inspect element** opens the real Chrome DevTools (Elements/Console/Network) for THIS tab.
 *    It is a human-only debugging affordance — DevTools attaches no `webContents.debugger`, so it
 *    never collides with the agent's CDP-free inspect/console/network tools, and it grants the
 *    agent nothing (the agent can't reach or observe this menu).
 *  - A saved image is raw network bytes — the DOM privacy filter does NOT redact it (saving is a
 *    user action on their own disk, not an agent capability).
 */

export interface MenuActions {
  /** wc.downloadURL → the existing per-container download pipeline (no native dialog). */
  saveUrl: (url: string) => void;
  copyImageAt: (x: number, y: number) => void;
  copyText: (text: string) => void;
  /** createTab(containerId, url) — same container, never an OS window. */
  openInNewTab: (url: string) => void;
  replaceMisspelling: (word: string) => void;
  back: () => void;
  forward: () => void;
  reload: () => void;
  /** Open DevTools focused on the element under the cursor (wc.inspectElement). */
  inspectElement: (x: number, y: number) => void;
  canGoBack: boolean;
  canGoForward: boolean;
  pageUrl: string;
}

const isHttp = (u: string | undefined): u is string => !!u && /^https?:\/\//i.test(u);

/**
 * Clipboard items for an editable field or a text selection — shared by the page menu and the
 * chrome-UI menu (the URL bar, Settings inputs, the feedback box). Uses built-in `role:` items so
 * the OS clipboard + undo stack behave correctly, plus spellcheck suggestions when present.
 * Returns `[]` when there's nothing editable and no selection.
 */
function clipboardItems(
  params: ContextMenuParams,
  replaceMisspelling: (word: string) => void,
): MenuItemConstructorOptions[] {
  const t: MenuItemConstructorOptions[] = [];
  if (params.isEditable) {
    if (params.misspelledWord && params.dictionarySuggestions.length) {
      for (const s of params.dictionarySuggestions.slice(0, 5)) {
        t.push({ label: s, click: () => replaceMisspelling(s) });
      }
      t.push({ type: 'separator' });
    }
    t.push({ role: 'cut', enabled: params.editFlags.canCut });
    t.push({ role: 'copy', enabled: params.editFlags.canCopy });
    t.push({ role: 'paste', enabled: params.editFlags.canPaste });
    t.push({ role: 'selectAll' });
  } else if (params.selectionText) {
    t.push({ role: 'copy' });
  }
  return t;
}

/**
 * Minimal menu for the trusted chrome UI (URL bar / Settings / feedback inputs): clipboard +
 * spellcheck only — no page/save/navigation items (those make no sense over the app's own UI).
 * Empty when there's nothing to act on, so the caller can skip popping a menu.
 */
export function chromeContextMenuTemplate(
  params: ContextMenuParams,
  replaceMisspelling: (word: string) => void,
): MenuItemConstructorOptions[] {
  return clipboardItems(params, replaceMisspelling);
}

export function contextMenuTemplate(params: ContextMenuParams, a: MenuActions): MenuItemConstructorOptions[] {
  const t: MenuItemConstructorOptions[] = [];
  // Push a separator only if it would sit between two real groups (no leading/double separators).
  const sep = (): void => {
    if (t.length && t[t.length - 1].type !== 'separator') t.push({ type: 'separator' });
  };

  if (params.mediaType === 'image') {
    if (isHttp(params.srcURL)) t.push({ label: 'Save Image', click: () => a.saveUrl(params.srcURL) });
    t.push({ label: 'Copy Image', click: () => a.copyImageAt(params.x, params.y) });
    if (params.srcURL) t.push({ label: 'Copy Image Address', click: () => a.copyText(params.srcURL) });
    if (isHttp(params.srcURL)) t.push({ label: 'Open Image in New Tab', click: () => a.openInNewTab(params.srcURL) });
  }

  if (params.linkURL) {
    sep();
    if (isHttp(params.linkURL)) t.push({ label: 'Open Link in New Tab', click: () => a.openInNewTab(params.linkURL) });
    t.push({ label: 'Copy Link', click: () => a.copyText(params.linkURL) });
    if (isHttp(params.linkURL)) t.push({ label: 'Save Link As', click: () => a.saveUrl(params.linkURL) });
  }

  const clip = clipboardItems(params, a.replaceMisspelling);
  if (clip.length) {
    sep();
    t.push(...clip);
  }

  // Always available: navigation + the page URL.
  sep();
  t.push({ label: 'Back', enabled: a.canGoBack, click: a.back });
  t.push({ label: 'Forward', enabled: a.canGoForward, click: a.forward });
  t.push({ label: 'Reload', click: a.reload });
  sep();
  t.push({ label: 'Copy Page URL', click: () => a.copyText(a.pageUrl) });

  // Human debugging: open the real DevTools at the clicked node (Elements/Console/Network).
  sep();
  t.push({ label: 'Inspect element', click: () => a.inspectElement(params.x, params.y) });

  return t;
}
