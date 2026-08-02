import { app, BaseWindow, WebContentsView, session, ipcMain } from 'electron';
import type { WebContents } from 'electron';
import * as path from 'path';
import { createCore } from '../core';
import { Mode } from '../core/modes';
import { RiskLevel } from '../core/tool';
import { ApprovalRequest } from '../core/approval';
import { createReadTools } from '../tools/read';
import { createStatusTools } from '../tools/status';
import { createTabTools, TabInfo } from '../tools/tabs';
import { attachPageContextMenu, attachChromeContextMenu } from './context-menu';
import { createInspectTools } from '../tools/inspect';
import { createLocateTool } from '../tools/locate';
import { createScrollToTool } from '../tools/scroll-to';
import { createActTools } from '../tools/act';
import { createCoordinateTools } from '../tools/coordinate';
import { createDevTools } from '../tools/dev';
import { ElectronPageController } from './page-controller';
import { UiApprovalProvider } from './ui-approval';
import { originOf, isWebOrigin } from './nav';
import { ControlServer } from '../server/control-server';
import { loadOrCreateToken, regenerateToken, writeEndpoint, safecobrowserDir } from '../server/endpoint';
import { FileAuditSink, AUDIT_FILENAME, SealedRecord } from '../audit/file-sink';
import { Recorder } from '../recorder/recorder';
import { RecipeStore, RecipeStep } from '../recorder/recipes';
import { createRecipeTools } from '../tools/recipes';
import { createFeedbackTool } from '../tools/feedback';
import { submitFeedback } from '../feedback/feedback';
import { replayActions } from '../recorder/replay';
import { domainForUrl } from '../recorder/domain';
import { RecordedAction } from '../recorder/actions';
import { ContainerManager, DEFAULT_CONTAINER } from '../container/containers';
import { DownloadManager } from './downloads';
import { PrivacyFilter } from '../privacy/filter';
import { SettingsStore } from '../settings/settings';
import { plainChromiumUa } from '../settings/user-agent';
import { TabModel } from '../tabs/tab-model';
import { saveTabs, loadTabs } from '../tabs/tab-store';
import * as fs from 'node:fs';
import * as os from 'node:os';

/**
 * One-time rename migration (FlowBrowse → SafeCoBrowser). Moves the previous app's on-disk
 * state to the new name so existing logged-in sessions, recorded recipes, the audit log, and
 * downloads survive the rebrand. All paths derive from the home dir (macOS-only app), so this
 * runs at module load — before the consts below read any of these files, and before Electron
 * creates the new userData dir. Each move is skipped if the destination already exists (never
 * clobbers newer state); failures are non-fatal.
 */
function migrateLegacyName(): void {
  const home = os.homedir();
  const moves: Array<[string, string]> = [
    [path.join(home, '.flowbrowse'), path.join(home, '.safecobrowser')],
    [path.join(home, 'Downloads', 'FlowBrowse'), path.join(home, 'Downloads', 'SafeCoBrowser')],
    // Electron userData (persistent Chromium profiles / logins) derives from productName on macOS.
    [
      path.join(home, 'Library', 'Application Support', 'FlowBrowse'),
      path.join(home, 'Library', 'Application Support', 'SafeCoBrowser'),
    ],
  ];
  for (const [from, to] of moves) {
    try {
      if (fs.existsSync(from) && !fs.existsSync(to)) {
        fs.renameSync(from, to);
        console.log(`[safecobrowser] migrated ${from} → ${to}`);
      }
    } catch (err) {
      console.warn(`[safecobrowser] migration skipped for ${from}:`, err);
    }
  }

  // Persistent sessions live at userData/Partitions/<name>. The default container's partition
  // was renamed persist:flowbrowse → persist:safecobrowser (and persist:flowbrowse-<id> for
  // named ones), so the on-disk folders must be renamed in lockstep or the saved logins won't
  // be found. Rename every `flowbrowse*` partition folder to `safecobrowser*`.
  try {
    const partitionsDir = path.join(home, 'Library', 'Application Support', 'SafeCoBrowser', 'Partitions');
    if (fs.existsSync(partitionsDir)) {
      for (const entry of fs.readdirSync(partitionsDir)) {
        if (!entry.startsWith('flowbrowse')) continue;
        const from = path.join(partitionsDir, entry);
        const to = path.join(partitionsDir, 'safecobrowser' + entry.slice('flowbrowse'.length));
        if (!fs.existsSync(to)) {
          fs.renameSync(from, to);
          console.log(`[safecobrowser] migrated partition ${entry} → ${path.basename(to)}`);
        }
      }
    }
  } catch (err) {
    console.warn('[safecobrowser] partition migration skipped:', err);
  }
}
migrateLegacyName();

/**
 * SafeCoBrowser main process. A BaseWindow holds the chrome (top-bar UI) over a stack of tab
 * page views — one visible at a time. Each tab belongs to a container (isolated session)
 * and has its own independent AI permission grant, keyed by tab id. New tabs default to
 * the active tab's container; a tab can be reassigned to another container.
 */

const CHROME_HEIGHT = 132; // three rows: tab strip, nav/address/AI, container/recorder
const HOME_URL = 'https://flowstations.net/safecobrowser/start';

interface TabEntry {
  view: WebContentsView;
  title: string;
  url: string;
}

let baseWindow: BaseWindow | null = null;
let chromeView: WebContentsView | null = null;
let approvalPending = false;
let activityOpen = false; // when true, the chrome view grows to show the Activity log panel
let modalOpen = false; // when true, the chrome view fills the window so a centered modal can overlay the page
let restoring = false; // true while restoring tabs on startup (suppresses persistence)

const TABS_FILE = () => path.join(safecobrowserDir(), 'tabs.json');

const tabModel = new TabModel();
const tabs = new Map<string, TabEntry>();
// Tabs opened from a popup (window.open / target=_blank) that haven't committed a navigation yet.
// A popup whose only purpose was to start a download lands here and is auto-closed (no blank tab).
const provisionalPopups = new Set<string>();

// Per-tab auto-approve: the user can let click/fill (and/or run_js) run without a card.
interface AutoApprove {
  actions: boolean;
  runjs: boolean;
}
const autoApproveByTab = new Map<string, AutoApprove>();
function getAutoApprove(tabId: string): AutoApprove {
  return autoApproveByTab.get(tabId) ?? { actions: false, runjs: false };
}
function autoApproveDecision(req: ApprovalRequest): boolean {
  const s = autoApproveByTab.get(req.tabId);
  if (!s) return false;
  // run_js is High-risk → its own switch; click/fill (Medium) → the actions switch.
  return req.risk === RiskLevel.High ? s.runjs : s.actions;
}

// Per-tab "real input": when on, click/fill drive the page with real isTrusted input
// (sendInputEvent) instead of JS-synthesized events. User-set, default off, and reset on every
// revoke path (mode→Off, Stop AI, tab close, container switch) so a fresh grant never inherits a
// prior tab's input mode. NOT a humanization layer — real input only changes event trust, never
// the permission ceiling (the broker, mode gate, and approval are unchanged).
const realInputByTab = new Map<string, boolean>();
function getRealInput(tabId: string): boolean {
  return realInputByTab.get(tabId) ?? false;
}

// App-wide user settings (UA override, approval timeout, MCP port). Created early so the approval
// provider and control server can read live values from it.
const settings = new SettingsStore(path.join(safecobrowserDir(), 'settings.json'));

const uiApproval = new UiApprovalProvider(
  () => chromeView?.webContents ?? null,
  (pending) => {
    approvalPending = pending;
    layout();
  },
  () => settings.getApprovalTimeoutMs(), // re-read per request, so a settings change applies live
  autoApproveDecision,
  () => tabModel.activeId(), // foreground tab at request time, to label a background-tab card
  (id) => privacy.redact(tabs.get(id)?.title || 'New Tab'), // same redaction list_tabs applies
);
const auditSink = new FileAuditSink(path.join(safecobrowserDir(), AUDIT_FILENAME));
const core = createCore({ approvals: uiApproval, audit: auditSink });
const containerManager = new ContainerManager(path.join(safecobrowserDir(), 'containers.json'));

// Downloads land in a per-container folder under ~/Downloads/SafeCoBrowser (no native Save dialog,
// no agent visibility). baseDir is lazy — app.getPath is only valid once the app is ready.
const downloads = new DownloadManager(
  () => path.join(app.getPath('downloads'), 'SafeCoBrowser'),
  () => chromeView?.webContents.send('download:state', downloads.list()),
  (wc) => closeIfDownloadOnlyPopup(wc),
  path.join(safecobrowserDir(), 'downloads.json'), // persist the list across restarts
);

// User-defined sensitive-data redaction (best-effort). When enabled, matching text is replaced in
// the page DOM — covering the screen, screenshots, and what the agent reads in one place.
const privacy = new PrivacyFilter(path.join(safecobrowserDir(), 'privacy-filter.json'));

// The global User-Agent override is applied to every container session via app.userAgentFallback
// (picked up by new WebContentsViews) and live-pushed to open tabs.
// The browser's built-in UA, captured before we ever override it, so "Default" can restore it.
let defaultUserAgent = '';
/** The UA that should be in force right now: the user's override, or the built-in default. */
function effectiveUserAgent(): string {
  return settings.getUserAgent() || defaultUserAgent;
}
/** Apply the current UA setting. Sets the fallback for new tabs; with reloadOpen, also re-applies
 *  to every open tab and reloads it so the change takes effect on the live page. */
function applyUserAgent(reloadOpen: boolean): void {
  const ua = effectiveUserAgent();
  app.userAgentFallback = ua;
  if (reloadOpen) {
    for (const [, t] of tabs) {
      t.view.webContents.setUserAgent(ua);
      t.view.webContents.reload();
    }
  }
}

/** Push the current privacy state to every page view and the chrome UI. */
function broadcastPrivacy(): void {
  const state = privacy.get();
  for (const [, t] of tabs) t.view.webContents.send('privacy:state', state);
  chromeView?.webContents.send('privacy:state', state);
}

/** A popup tab that fired a download before ever committing a navigation existed only to start
 *  that download — drop it so we don't leave a blank tab behind. */
function closeIfDownloadOnlyPopup(wc: WebContents): void {
  for (const [id, tab] of tabs) {
    if (tab.view.webContents === wc && provisionalPopups.has(id)) {
      provisionalPopups.delete(id);
      setTimeout(() => {
        if (tabs.has(id)) closeTab(id);
      }, 0); // defer so the DownloadItem fully detaches from the webContents first
      return;
    }
  }
}

// Tools resolve a tab id to its live page (per-tab). The agent only ever targets the
// active tab (activeTab() below), but the resolver works for any live tab.
const pageController = new ElectronPageController(
  (tabId) => tabs.get(tabId)?.view.webContents ?? null,
  {
    realInputFor: (id) => getRealInput(id),
    // Active = the foreground/attached tab, NOT OS window focus: the agent commonly acts while the
    // user's terminal is focused, and the app must never steal focus. Background tabs are detached
    // (showActiveTabOnly) so they genuinely can't receive sendInputEvent → honest JS fallback.
    isActiveTab: (id) => tabModel.activeId() === id,
  },
);
for (const tool of createReadTools(pageController)) core.registry.register(tool);
// Read-only "what mode am I in?" — off the ladder so the agent can always check (even at Off).
for (const tool of createStatusTools((id) => core.sessions.get(id).mode)) core.registry.register(tool);
// list_tabs / switch_tab — off the ladder, gated by the user's agentTabControl setting. Switching
// only re-targets the foreground; each tab is still gated by its own per-tab mode. Titles/URLs are
// privacy-redacted before they reach the agent (best-effort, like every other agent-facing read).
for (const tool of createTabTools({
  list: () => {
    const activeId = tabModel.activeId();
    const row = (id: string): TabInfo => {
      const e = tabs.get(id);
      return {
        tab: id,
        active: id === activeId,
        mode: core.sessions.get(id).mode,
        title: privacy.redact(e?.title || 'New Tab'),
        url: privacy.redact(e?.url || ''),
      };
    };
    // Setting off → fall back to the historical single-active-tab visibility.
    if (!settings.getAgentTabControl()) return [row(activeId)];
    return tabModel.list().map((t) => row(t.id));
  },
  switchTo: (id) => {
    if (!settings.getAgentTabControl()) return { switched: false, reason: 'tab switching is disabled in Settings' };
    if (!tabModel.get(id)) return { switched: false, reason: `no such tab: ${id}` };
    if (id === tabModel.activeId()) return { switched: true, tab: id }; // already foreground
    activateTab(id);
    return { switched: true, tab: id };
  },
})) {
  core.registry.register(tool);
}
for (const tool of createInspectTools(pageController)) core.registry.register(tool);
// locate — DOM → coordinates (Read-tier, no approval); lets an agent target click_at/move_to
// without a screenshot + vision pass, the slow half of the computer-use loop.
core.registry.register(createLocateTool(pageController));
for (const tool of createActTools(pageController)) core.registry.register(tool);
// scroll_to — bring a located element into view (Act-tier, approval); one targeted scroll instead
// of blind scroll-and-recheck when a locate match is off-viewport.
core.registry.register(createScrollToTool(pageController));
// Coordinate ("computer use") tools — real input at viewport coordinates; pageController is both
// the controller and the approval-preview source (screenshot + crosshair).
for (const tool of createCoordinateTools(pageController, pageController)) core.registry.register(tool);
for (const tool of createDevTools(pageController)) core.registry.register(tool);

core.sessions.onChange((state) => {
  // Only mirror the ACTIVE tab's grant to the indicator UI.
  if (state.tabId === tabModel.activeId()) chromeView?.webContents.send('ai:state', state);
});

const recorder = new Recorder();
const recipeStore = new RecipeStore(path.join(safecobrowserDir(), 'recipes'));
// Expose the user's recipes to the agent (read-only) — discoverable over MCP + CLI like any tool.
for (const tool of createRecipeTools({
  currentDomain: () => currentDomain(),
  list: (d) => recipeStore.list(d),
  get: (d, n) => recipeStore.get(d, n),
})) {
  core.registry.register(tool);
}

// Non-identifying app metadata attached to feedback (never page content).
function feedbackContext(): string {
  return `SafeCoBrowser ${app.getVersion()} / ${process.platform}`;
}
// Agent-facing feedback tool (Act-tier + approval — the user sees the exact text before it sends).
core.registry.register(
  createFeedbackTool((input) =>
    submitFeedback({ message: input.message, email: input.email, source: 'agent', context: feedbackContext() }),
  ),
);
recorder.onChange((state) => chromeView?.webContents.send('record:state', state));

function toUiAudit(rec: SealedRecord) {
  const e = rec.event;
  return {
    seq: rec.seq,
    ts: e.ts,
    tabId: e.tabId,
    toolName: e.toolName,
    mode: e.mode,
    outcome: e.outcome,
    reason: e.reason,
    detail: e.detail,
  };
}
// Stream each new AI decision to the in-app Activity panel.
auditSink.onRecord((rec) => chromeView?.webContents.send('audit:event', toUiAudit(rec)));

function validRecordedAction(a: unknown): a is RecordedAction {
  if (!a || typeof a !== 'object') return false;
  const x = a as Record<string, unknown>;
  if (x.type === 'click') return typeof x.selector === 'string' && typeof x.label === 'string';
  if (x.type === 'fill') {
    return (
      typeof x.selector === 'string' &&
      (x.value === null || typeof x.value === 'string') &&
      typeof x.masked === 'boolean'
    );
  }
  if (x.type === 'submit') return typeof x.selector === 'string' && typeof x.label === 'string';
  if (x.type === 'navigate') return typeof x.url === 'string';
  return false;
}

let controlServer: ControlServer | null = null;

function isMode(value: unknown): value is Mode {
  return typeof value === 'string' && (Object.values(Mode) as string[]).includes(value);
}

let currentToken = '';

/** The machine's non-internal IPv4 LAN addresses, for the Host allowlist + the shown LAN URL. */
function lanAddresses(): string[] {
  const out: string[] = [];
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === 'IPv4' && !a.internal) out.push(a.address);
    }
  }
  return out;
}

/** Bind a fresh control server on `port`; on success publishes the endpoint. Throws on bind error.
 *  With LAN access on, binds to all interfaces and allowlists the machine's LAN IPs. */
async function listenOn(port: number): Promise<void> {
  const lan = settings.getLanAccess();
  const server = new ControlServer({
    token: currentToken,
    port,
    host: lan ? '0.0.0.0' : '127.0.0.1',
    allowedHosts: lan ? lanAddresses() : [],
    registry: core.registry,
    broker: core.broker,
    activeTab: () => tabModel.activeId(),
    currentMode: () => core.sessions.get(tabModel.activeId()).mode,
    // A per-call `tab` override (see resolveTabTarget) is only ever valid for a tab that's
    // genuinely open right now — never let the broker default-Blocked a phantom id.
    isKnownTab: (id) => tabModel.get(id) !== null,
    allowTabTargeting: () => settings.getAgentTabControl(),
  });
  await server.start();
  controlServer = server;
  // Publish a loopback URL for the local CLI even when bound to 0.0.0.0 (0.0.0.0 isn't connectable).
  writeEndpoint({ url: `http://127.0.0.1:${server.port}`, token: currentToken });
}

async function startControlServer(): Promise<void> {
  currentToken = loadOrCreateToken();
  // An env override still wins (for dev/CI); otherwise the persisted setting drives the port.
  const port = Number(process.env.SAFECOBROWSER_PORT ?? settings.getMcpPort());
  await listenOn(port);
  console.log(`[safecobrowser] control server listening: ${controlServer?.url}/mcp`);
  console.log('[safecobrowser] endpoint + token written to ~/.safecobrowser/endpoint.json');
}

/** Current connection info for the Settings → Agent panel. */
function agentEndpoint(): {
  url: string;
  mcpUrl: string;
  port: number;
  token: string;
  lan: boolean;
  lanUrl: string;
} {
  const port = controlServer?.port ?? settings.getMcpPort();
  const url = `http://127.0.0.1:${port}`;
  const lan = settings.getLanAccess();
  const lanIp = lanAddresses()[0];
  // Only advertise a LAN URL when LAN access is actually on AND we found a routable address.
  const lanUrl = lan && lanIp ? `http://${lanIp}:${port}/mcp` : '';
  return { url, mcpUrl: `${url}/mcp`, port, token: currentToken, lan, lanUrl };
}

function activeTab(): TabEntry | null {
  return tabs.get(tabModel.activeId()) ?? null;
}

function layout(): void {
  if (!baseWindow || !chromeView) return;
  const { width, height } = baseWindow.getContentBounds();
  // An approval card can hold a long message (e.g. submit_feedback text), so give it more room;
  // the card itself is bounded + internally scrolls so its buttons are never clipped.
  const expandedH = approvalPending ? 560 : activityOpen ? 460 : 380;
  const chromeH = modalOpen
    ? height // full window so a centered modal can overlay the page
    : approvalPending || activityOpen
      ? Math.min(expandedH, height)
      : CHROME_HEIGHT;
  activeTab()?.view.setBounds({ x: 0, y: CHROME_HEIGHT, width, height: Math.max(0, height - CHROME_HEIGHT) });
  chromeView.setBounds({ x: 0, y: 0, width, height: chromeH });
}

function showActiveTabOnly(): void {
  const activeId = tabModel.activeId();
  for (const [id, tab] of tabs) tab.view.setVisible(id === activeId);
  layout();
}

function sendPageState(): void {
  const tab = activeTab();
  if (!tab || !chromeView) return;
  const wc = tab.view.webContents;
  chromeView.webContents.send('page:state', {
    url: wc.getURL(),
    title: wc.getTitle(),
    canGoBack: wc.navigationHistory.canGoBack(),
    canGoForward: wc.navigationHistory.canGoForward(),
    isLoading: wc.isLoading(),
  });
  // Recipes are domain-keyed — re-scope the recipe UI when the active page's domain changes.
  const domain = domainForUrl(wc.getURL());
  if (domain !== lastRecipeDomain) {
    lastRecipeDomain = domain;
    sendRecipeState();
  }
}

/** The registrable domain of the active tab — the recipe memory key (never the container). */
function currentDomain(): string {
  const tab = activeTab();
  return tab ? domainForUrl(tab.view.webContents.getURL()) : '';
}

let lastRecipeDomain: string | null = null;
function sendRecipeState(): void {
  // `domain` is the active site (where a new recording would save); `recipes` is EVERY recipe
  // across all domains so the manager is a single place to find them all.
  chromeView?.webContents.send('recipe:state', { domain: currentDomain(), recipes: recipeStore.listAll() });
}

function tabStatePayload() {
  return {
    activeId: tabModel.activeId(),
    tabs: tabModel.list().map((t) => ({
      id: t.id,
      containerId: t.containerId,
      containerName: containerManager.get(t.containerId)?.name ?? t.containerId,
      title: tabs.get(t.id)?.title || 'New Tab',
    })),
  };
}

function sendTabState(): void {
  chromeView?.webContents.send('tab:state', tabStatePayload());
}

function sendContainerState(): void {
  const active = tabModel.active();
  chromeView?.webContents.send('container:state', {
    current: active?.containerId ?? DEFAULT_CONTAINER,
    containers: containerManager.list(),
  });
}

function normalizeUrl(input: string): string {
  const s = input.trim();
  if (/^https?:\/\//i.test(s)) return s;
  if (/^[\w-]+(\.[\w-]+)+(\/.*)?$/.test(s) && !s.includes(' ')) return 'https://' + s;
  return 'https://duckduckgo.com/?q=' + encodeURIComponent(s);
}

function destroyWebContents(wc: WebContents): void {
  const d = wc as unknown as { destroy?: () => void; isDestroyed?: () => boolean; loadURL?: (u: string) => void };
  try {
    if (d.isDestroyed?.()) return;
    if (typeof d.destroy === 'function') d.destroy();
    else d.loadURL?.('about:blank');
  } catch {
    /* best effort */
  }
}

function makeTabView(id: string, containerId: string): WebContentsView {
  const partition = containerManager.partitionFor(containerId);
  const sess = session.fromPartition(partition);
  const view = new WebContentsView({
    webPreferences: {
      session: sess,
      preload: path.join(__dirname, '../preload/capture-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  // Route this container's downloads to its own folder (idempotent — one handler per session).
  downloads.attach(sess, partition, containerId);
  const wc = view.webContents;

  // Popups (window.open / target=_blank) open as a NEW TAB in the SAME container — never a
  // separate OS window — so they share this container's logged-in session. A popup that only
  // triggers a download leaves no real navigation and is cleaned up by closeIfDownloadOnlyPopup.
  wc.setWindowOpenHandler(({ url }) => {
    if (url && /^https?:/i.test(url)) {
      const newId = createTab(containerId, url);
      provisionalPopups.add(newId);
    }
    return { action: 'deny' };
  });
  // Right-click context menu (user-only UI; never an agent tool). Bound to THIS tab's wc so Save
  // routes through its session → the per-container download pipeline; Open-in-New-Tab opens in the
  // SAME container (an explicit user open → a normal tab, not a provisional download popup).
  attachPageContextMenu(wc, (url) => {
    createTab(containerId, url);
  });

  // Once a tab actually navigates it's a real page, not a throwaway download popup.
  wc.on('did-navigate', () => provisionalPopups.delete(id));
  // Re-send the privacy filter on every load so a fresh/navigated page redacts immediately.
  wc.on('did-finish-load', () => wc.send('privacy:state', privacy.get()));

  const onState = (): void => {
    const entry = tabs.get(id);
    if (entry) {
      entry.title = wc.getTitle();
      entry.url = wc.getURL();
    }
    if (tabModel.activeId() === id) sendPageState();
    sendTabState();
  };
  wc.on('did-navigate', onState);
  wc.on('did-navigate-in-page', onState);
  wc.on('page-title-updated', onState);
  wc.on('did-start-loading', onState);
  wc.on('did-stop-loading', onState);

  // Persist the tab set whenever a committed navigation changes this tab's URL.
  wc.on('did-navigate', () => persistTabs());
  wc.on('did-navigate-in-page', () => persistTabs());

  // The AI grant persists across navigation; it is only cleared by Stop AI or a mode
  // change. (No cross-origin auto-revoke.)
  return view;
}

function createTab(containerId: string, url: string = HOME_URL): string {
  const meta = tabModel.create(containerId);
  const view = makeTabView(meta.id, containerId);
  tabs.set(meta.id, { view, title: 'New Tab', url });
  baseWindow?.contentView.addChildView(view, 0); // below the chrome
  view.webContents.loadURL(url);
  pageController.attach(meta.id, view.webContents);
  activateTab(meta.id);
  return meta.id;
}

/** Save the open tabs (container + url) so they can be restored next launch. */
function persistTabs(): void {
  if (restoring) return;
  const list = tabModel.list();
  const activeIndex = list.findIndex((t) => t.id === tabModel.activeId());
  saveTabs(TABS_FILE(), {
    activeIndex: activeIndex < 0 ? 0 : activeIndex,
    tabs: list.map((t) => ({ containerId: t.containerId, url: tabs.get(t.id)?.url || HOME_URL })),
  });
}

/** Re-open the persisted tabs on startup, or a single default tab if none. */
function restoreTabsOrDefault(): void {
  const saved = loadTabs(TABS_FILE());
  if (!saved) {
    createTab(DEFAULT_CONTAINER);
    return;
  }
  restoring = true;
  for (const t of saved.tabs) {
    const cid = containerManager.has(t.containerId) ? t.containerId : DEFAULT_CONTAINER;
    createTab(cid, t.url || HOME_URL);
  }
  const list = tabModel.list();
  const active = list[saved.activeIndex] ?? list[list.length - 1];
  restoring = false;
  if (active) activateTab(active.id);
  persistTabs();
}

function activateTab(id: string): void {
  if (!tabModel.activate(id)) return;
  showActiveTabOnly();
  sendPageState();
  sendTabState();
  sendContainerState();
  chromeView?.webContents.send('ai:state', core.sessions.get(id));
  chromeView?.webContents.send('auto-approve:state', getAutoApprove(id));
  chromeView?.webContents.send('real-input:state', getRealInput(id));
  persistTabs();
}

function closeTab(id: string): void {
  const tab = tabs.get(id);
  const { newActiveId } = tabModel.close(id);
  if (tab) {
    try {
      baseWindow?.contentView.removeChildView(tab.view);
    } catch {
      /* gone */
    }
    destroyWebContents(tab.view.webContents);
    tabs.delete(id);
  }
  core.sessions.revoke(id); // kill any in-flight call for this tab…
  core.sessions.delete(id); // …then drop its (now-Blocked) session entry
  pageController.detach(id); // and its console/network buffers
  autoApproveByTab.delete(id); // and its auto-approve setting
  realInputByTab.delete(id); // and its real-input setting
  if (!newActiveId || tabModel.count() === 0) {
    createTab(DEFAULT_CONTAINER); // never zero tabs
  } else {
    activateTab(newActiveId);
  }
}

function setTabContainer(id: string, containerId: string): void {
  const tab = tabs.get(id);
  if (!tab || !containerManager.has(containerId)) return;
  tabModel.setContainer(id, containerId);
  // Recreate the tab's view on the new partition; AI grant resets.
  try {
    baseWindow?.contentView.removeChildView(tab.view);
  } catch {
    /* gone */
  }
  destroyWebContents(tab.view.webContents);
  const view = makeTabView(id, containerId);
  tabs.set(id, { view, title: 'New Tab', url: '' });
  baseWindow?.contentView.addChildView(view, 0);
  view.webContents.loadURL(HOME_URL);
  pageController.attach(id, view.webContents);
  core.sessions.revoke(id);
  // A container switch is a fresh session — drop per-tab grant-scoped state so it doesn't
  // carry the previous container's auto-approve / real-input toggles forward.
  autoApproveByTab.delete(id);
  realInputByTab.delete(id);
  if (tabModel.activeId() === id) {
    showActiveTabOnly();
    sendPageState();
    chromeView?.webContents.send('auto-approve:state', getAutoApprove(id));
    chromeView?.webContents.send('real-input:state', getRealInput(id));
  }
  sendTabState();
  sendContainerState();
  persistTabs();
}

function createWindow(): void {
  baseWindow = new BaseWindow({ width: 1280, height: 860, title: 'SafeCoBrowser' });

  chromeView = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, '../preload/chrome-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  chromeView.webContents.loadFile(path.join(__dirname, '../renderer/index.html'));
  baseWindow.contentView.addChildView(chromeView);
  // Clipboard/spellcheck right-click menu for the chrome UI inputs (URL bar, Settings, feedback).
  attachChromeContextMenu(chromeView.webContents);

  chromeView.webContents.on('did-finish-load', () => {
    sendTabState();
    sendContainerState();
    chromeView?.webContents.send('ai:state', core.sessions.get(tabModel.activeId()));
    sendPageState();
  });

  baseWindow.on('resize', layout);
  baseWindow.on('closed', () => {
    baseWindow = null;
    chromeView = null;
    tabs.clear();
  });

  // Capture the built-in UA once (before any override) so "Default" can restore it, then apply
  // the saved override as the fallback so restored tabs load with the right UA from the start.
  // Strip the Electron/<ver> and app-name tokens so the captured default presents as the plain
  // Chromium it actually is, even when no user ever sets a custom UA.
  if (!defaultUserAgent) defaultUserAgent = plainChromiumUa(app.userAgentFallback, app.getName());
  applyUserAgent(false);

  restoreTabsOrDefault(); // re-open last session's tabs, or one default tab
}

// --- Navigation IPC (operate on the active tab) ---
ipcMain.handle('nav:go', (_e, rawUrl: string) => {
  const tab = activeTab();
  if (!tab) return;
  const url = normalizeUrl(rawUrl);
  tab.view.webContents.loadURL(url);
  recorder.add({ type: 'navigate', url, ts: Date.now() });
});
ipcMain.handle('nav:back', () => activeTab()?.view.webContents.navigationHistory.goBack());
ipcMain.handle('nav:forward', () => activeTab()?.view.webContents.navigationHistory.goForward());
ipcMain.handle('nav:reload', () => activeTab()?.view.webContents.reload());

// --- Per-tab AI permission control (only the user, via this UI, sets the mode) ---
ipcMain.handle('ai:set-mode', (_e, mode: unknown) => {
  const id = tabModel.activeId();
  const tab = tabs.get(id);
  if (!tab) return;
  if (!isMode(mode)) {
    console.warn('[safecobrowser] ignored invalid ai:set-mode value:', mode);
    return;
  }
  if (mode === Mode.Blocked) {
    core.sessions.setMode(id, mode);
    autoApproveByTab.delete(id); // dropping to Off resets auto-approve
    realInputByTab.delete(id); // …and real input
    chromeView?.webContents.send('auto-approve:state', getAutoApprove(id));
    chromeView?.webContents.send('real-input:state', getRealInput(id));
    return;
  }
  // A grant can only attach to a committed http(s) page (not about:blank/opaque).
  const origin = originOf(tab.view.webContents.getURL());
  if (!isWebOrigin(origin)) {
    console.warn('[safecobrowser] cannot grant AI access without a committed http(s) origin; ignoring');
    chromeView?.webContents.send('ai:state', core.sessions.get(id));
    return;
  }
  core.sessions.setMode(id, mode);
});
ipcMain.handle('ai:stop', () => {
  const id = tabModel.activeId();
  core.sessions.revoke(id);
  autoApproveByTab.delete(id); // Stop AI resets auto-approve
  realInputByTab.delete(id); // …and real input
  chromeView?.webContents.send('auto-approve:state', getAutoApprove(id));
  chromeView?.webContents.send('real-input:state', getRealInput(id));
});
ipcMain.handle('ai:get-state', () => core.sessions.get(tabModel.activeId()));

// --- Per-tab auto-approve ---
ipcMain.handle('ui:get-auto-approve', () => getAutoApprove(tabModel.activeId()));
ipcMain.handle('ui:auto-approve', (_e, payload: unknown) => {
  const id = tabModel.activeId();
  const p = payload as { actions?: unknown; runjs?: unknown } | null;
  if (!p || typeof p !== 'object') return;
  const cur = getAutoApprove(id);
  const next: AutoApprove = {
    actions: typeof p.actions === 'boolean' ? p.actions : cur.actions,
    runjs: typeof p.runjs === 'boolean' ? p.runjs : cur.runjs,
  };
  autoApproveByTab.set(id, next);
  chromeView?.webContents.send('auto-approve:state', next);
});

// --- Per-tab real input (real isTrusted sendInputEvent vs JS-synthesized events) ---
ipcMain.handle('ui:get-real-input', () => getRealInput(tabModel.activeId()));
ipcMain.handle('ui:set-real-input', (_e, on: unknown) => {
  const id = tabModel.activeId();
  if (typeof on !== 'boolean') return;
  realInputByTab.set(id, on);
  chromeView?.webContents.send('real-input:state', getRealInput(id));
});

// --- Activity log ---
ipcMain.handle('audit:recent', () => auditSink.recentRecords(200).map(toUiAudit));
ipcMain.handle('ui:activity', (_e, open: unknown) => {
  activityOpen = !!open;
  layout();
});
ipcMain.handle('ui:modal', (_e, open: unknown) => {
  modalOpen = !!open;
  layout();
});

// --- Downloads (user surface only — never exposed to the agent) ---
ipcMain.handle('downloads:recent', () => downloads.list());
ipcMain.handle('downloads:reveal', (_e, p: unknown) => downloads.reveal(typeof p === 'string' ? p : ''));
ipcMain.handle('downloads:open', (_e, p: unknown) => downloads.open(typeof p === 'string' ? p : ''));
ipcMain.handle('downloads:clear', () => downloads.clear());

// --- Privacy filter (user-owned redaction rules) ---
ipcMain.on('privacy:request', (e) => e.sender.send('privacy:state', privacy.get())); // page preload pull
ipcMain.handle('privacy:get', () => privacy.get());
ipcMain.handle('privacy:set-enabled', (_e, on: unknown) => {
  privacy.setEnabled(!!on);
  broadcastPrivacy();
});
ipcMain.handle('privacy:set-rules', (_e, rules: unknown) => {
  privacy.setRules(rules);
  broadcastPrivacy();
});

// --- Settings ---
ipcMain.handle('settings:get', () => ({
  userAgent: settings.getUserAgent(),
  defaultUserAgent,
  approvalTimeoutMs: settings.getApprovalTimeoutMs(),
  agentTabControl: settings.getAgentTabControl(),
}));
ipcMain.handle('settings:set-ua', (_e, ua: unknown) => {
  settings.setUserAgent(ua);
  applyUserAgent(true); // live-apply + reload open tabs
  return { userAgent: settings.getUserAgent(), defaultUserAgent };
});
ipcMain.handle('settings:set-approval-timeout', (_e, ms: unknown) => {
  settings.setApprovalTimeoutMs(ms); // re-read live by the approval provider
  return { approvalTimeoutMs: settings.getApprovalTimeoutMs() };
});
ipcMain.handle('settings:set-tab-control', (_e, on: unknown) => {
  settings.setAgentTabControl(on); // read live by the list_tabs / switch_tab closures
  return { agentTabControl: settings.getAgentTabControl() };
});

// --- Feedback (in-app "Send feedback" box; same backend as the submit_feedback agent tool) ---
ipcMain.handle('feedback:send', async (_e, payload: unknown) => {
  const p = (payload ?? {}) as { message?: unknown; email?: unknown };
  return submitFeedback({ message: p.message, email: p.email, source: 'user', context: feedbackContext() });
});

// --- Agent connection (Settings → Agent panel; the chrome UI is trusted) ---
ipcMain.handle('agent:get-endpoint', () => agentEndpoint());
ipcMain.handle('agent:regenerate-token', () => {
  currentToken = regenerateToken();
  controlServer?.setToken(currentToken); // any agent on the old token is now rejected
  // agentEndpoint().url is always the loopback URL (never 0.0.0.0), which is what the local CLI needs.
  writeEndpoint({ url: agentEndpoint().url, token: currentToken });
  return agentEndpoint();
});
ipcMain.handle('agent:set-lan', async (_e, on: unknown) => {
  const prev = settings.getLanAccess();
  const next = Boolean(on);
  if (next === prev) return { ...agentEndpoint(), ok: true };
  settings.setLanAccess(next);
  const port = controlServer?.port ?? settings.getMcpPort();
  try {
    await controlServer?.stop();
    await listenOn(port); // rebinds loopback-only ↔ 0.0.0.0 + LAN allowlist
    return { ...agentEndpoint(), ok: true };
  } catch (err) {
    settings.setLanAccess(prev); // revert on failure and restore the prior binding
    try {
      await listenOn(port);
    } catch {
      /* port may be momentarily occupied; next launch retries */
    }
    const detail = err instanceof Error ? err.message : 'bind failed';
    return { ...agentEndpoint(), ok: false, error: `Could not switch LAN access — ${detail}.` };
  }
});
ipcMain.handle('agent:set-port', async (_e, port: unknown) => {
  const prev = controlServer?.port ?? settings.getMcpPort();
  settings.setMcpPort(port);
  const next = settings.getMcpPort();
  if (next === prev) return { ...agentEndpoint(), ok: true };
  try {
    await controlServer?.stop();
    await listenOn(next); // rebinds on the new port
    return { ...agentEndpoint(), ok: true };
  } catch {
    settings.setMcpPort(prev); // revert the persisted setting and the live server
    try {
      await listenOn(prev);
    } catch {
      /* old port may now be momentarily occupied; next launch retries */
    }
    return { ...agentEndpoint(), ok: false, error: `Port ${next} unavailable — kept ${prev}.` };
  }
});

// --- Tabs ---
ipcMain.handle('tab:list', () => tabStatePayload());
ipcMain.handle('tab:new', (_e, containerId: unknown) => {
  const cid =
    typeof containerId === 'string' && containerManager.has(containerId)
      ? containerId
      : (tabModel.active()?.containerId ?? DEFAULT_CONTAINER);
  createTab(cid);
});
ipcMain.handle('tab:close', (_e, id: unknown) => {
  if (typeof id === 'string') closeTab(id);
});
ipcMain.handle('tab:switch', (_e, id: unknown) => {
  if (typeof id === 'string') activateTab(id);
});

// --- Containers (the dropdown reassigns the ACTIVE tab's container) ---
ipcMain.handle('container:list', () => ({
  current: tabModel.active()?.containerId ?? DEFAULT_CONTAINER,
  containers: containerManager.list(),
}));
ipcMain.handle('container:switch', (_e, id: unknown) => {
  if (typeof id === 'string' && containerManager.has(id)) setTabContainer(tabModel.activeId(), id);
});
ipcMain.handle('container:create', (_e, name: unknown) => {
  if (typeof name !== 'string' || name.trim() === '') return { error: 'name required' };
  const info = containerManager.create(name);
  setTabContainer(tabModel.activeId(), info.id); // open the active tab in the new container
  return { id: info.id, name: info.name };
});

ipcMain.handle('container:rename', (_e, id: unknown, name: unknown) => {
  if (typeof id !== 'string' || typeof name !== 'string' || name.trim() === '') return { error: 'name required' };
  const info = containerManager.rename(id, name);
  if (!info) return { error: 'Cannot rename this container.' };
  sendContainerState();
  sendTabState(); // tab badges show the container name
  return { id: info.id, name: info.name };
});

ipcMain.handle('container:remove', async (_e, id: unknown) => {
  if (typeof id !== 'string') return { error: 'id required' };
  if (id === DEFAULT_CONTAINER) return { error: 'The Default container cannot be deleted.' };
  const openTabs = tabModel.list().filter((t) => t.containerId === id).length;
  if (openTabs > 0) return { error: `Close its ${openTabs} open tab(s) first.` };
  const partition = containerManager.partitionFor(id);
  if (!containerManager.remove(id)) return { error: 'Cannot delete this container.' };
  // Wipe the isolated session off disk — an "isolated" container must not leave logins behind.
  try {
    await session.fromPartition(partition).clearStorageData();
  } catch {
    /* best effort — the container is already forgotten */
  }
  sendContainerState();
  return { ok: true };
});

// --- Action recorder + recipes ---
let replaying = false; // true while a replay runs — its synthetic DOM events must NOT be recorded
ipcMain.on('record:action', (e, action: unknown) => {
  if (replaying) return; // don't capture the replay's own clicks/fills into the recording
  const tab = activeTab();
  if (!tab || e.sender !== tab.view.webContents) return; // only the active tab's page may record
  if (validRecordedAction(action)) recorder.add(action);
});
ipcMain.handle('record:start', () => recorder.start());
ipcMain.handle('record:stop', () => recorder.stop());
ipcMain.handle('record:clear', () => recorder.clear());
ipcMain.handle('record:state', () => recorder.state());
ipcMain.handle('record:buffer', () => recorder.actions()); // the user's own captured actions, for the save editor
// The renderer only ever supplies per-step ANNOTATIONS (name + description) — never the actions
// themselves. The actions stay server-authoritative (from the recorder buffer or the saved
// recipe), so the page can't inject arbitrary selectors/urls that replay would then execute.
interface StepAnnotation {
  name?: string;
  description?: string;
}
function sanitizeAnnotations(raw: unknown): StepAnnotation[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((a) => {
    const o = (a && typeof a === 'object' ? a : {}) as Record<string, unknown>;
    return {
      ...(typeof o.name === 'string' ? { name: o.name.slice(0, 200) } : {}),
      ...(typeof o.description === 'string' ? { description: o.description.slice(0, 2000) } : {}),
    };
  });
}
function zipSteps(actions: RecordedAction[], annos: StepAnnotation[]): RecipeStep[] {
  return actions.map((action, i) => ({ action, ...(annos[i] ?? {}) }));
}

ipcMain.handle('recipe:save', (_e, payload: unknown) => {
  const p = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>;
  if (typeof p.name !== 'string' || p.name.trim() === '') return { error: 'name required' };
  const domain = currentDomain();
  if (!domain) return { error: 'Recipes can only be saved on a website.' };
  const steps = zipSteps(recorder.actions(), sanitizeAnnotations(p.stepAnnotations));
  const saved = recipeStore.save(domain, {
    name: p.name,
    ...(typeof p.description === 'string' ? { description: p.description } : {}),
    steps,
  });
  sendRecipeState();
  return { saved: saved.name, steps: saved.steps.length, domain };
});
ipcMain.handle('recipe:list', () => ({ domain: currentDomain(), recipes: recipeStore.listAll() }));
ipcMain.handle('recipe:get', (_e, domain: unknown, name: unknown) =>
  typeof domain === 'string' && typeof name === 'string' ? recipeStore.get(domain, name) : null,
);
ipcMain.handle('recipe:update', (_e, domain: unknown, originalName: unknown, payload: unknown) => {
  if (typeof domain !== 'string' || typeof originalName !== 'string') return { error: 'name required' };
  const p = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>;
  if (typeof p.name !== 'string' || p.name.trim() === '') return { error: 'name required' };
  const existing = recipeStore.get(domain, originalName);
  if (!existing) return { error: 'not found' };
  // Re-zip the EXISTING actions with the new annotations — actions are never taken from the renderer.
  const steps = zipSteps(
    existing.steps.map((s) => s.action),
    sanitizeAnnotations(p.stepAnnotations),
  );
  const saved = recipeStore.update(domain, originalName, {
    name: p.name,
    ...(typeof p.description === 'string' ? { description: p.description } : {}),
    steps,
  });
  if (!saved) return { error: 'not found' };
  sendRecipeState();
  return { saved: saved.name, steps: saved.steps.length };
});
ipcMain.handle('recipe:delete', (_e, domain: unknown, name: unknown) => {
  if (typeof domain !== 'string' || typeof name !== 'string') return false;
  const ok = recipeStore.delete(domain, name);
  if (ok) sendRecipeState();
  return ok;
});
ipcMain.handle('recipe:replay', async (_e, domain: unknown, name: unknown) => {
  if (typeof domain !== 'string' || typeof name !== 'string') return { error: 'name required' };
  const recipe = recipeStore.get(domain, name);
  if (!recipe) return { error: 'not found' };
  replaying = true; // suppress recording of the replay's synthetic events
  try {
    const result = await replayActions(
      recipe.steps.map((s) => s.action),
      {
        act: pageController,
        tabId: tabModel.activeId(),
        delayMs: 700, // pause between steps so the user can watch the replay
        navSettleMs: 1800, // give a submitted search / navigation time to load the next page
        navigate: (url) => {
          activeTab()?.view.webContents.loadURL(url);
        },
      },
    );
    return { performed: result.performed, skipped: result.skipped, failed: result.failed };
  } finally {
    // Small grace period so any in-flight record:action events from the last step are dropped too.
    setTimeout(() => {
      replaying = false;
    }, 150);
  }
});

app.whenReady().then(async () => {
  createWindow();
  try {
    await startControlServer();
  } catch (err) {
    console.error('[safecobrowser] failed to start control server:', err);
  }
});

app.on('will-quit', () => {
  void controlServer?.stop();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BaseWindow.getAllWindows().length === 0) createWindow();
});
