import { contextBridge, ipcRenderer } from 'electron';

/**
 * Preload for the top-bar UI. Exposes a minimal, explicit navigation API over
 * the context bridge — the renderer never gets direct ipcRenderer/node access.
 */

export interface PageState {
  url: string;
  title: string;
  canGoBack: boolean;
  canGoForward: boolean;
  isLoading: boolean;
}

export interface AiState {
  tabId: string;
  mode: string;
  epoch: number;
}

export interface ApprovalPreviewData {
  image: string; // base64 PNG
  w: number;
  h: number;
  x?: number; // crosshair point in image pixel space
  y?: number;
}

export interface ApprovalCard {
  id: number;
  toolName: string;
  risk: string;
  summary: string;
  input: unknown;
  preview?: ApprovalPreviewData;
  /** The target tab's (privacy-filtered) title — present ONLY when the call targets a tab other
   *  than the active one, so the card can warn the human it's about a background tab. */
  targetTab?: string;
}

export interface RecordState {
  recording: boolean;
  count: number;
}

export interface AgentEndpoint {
  url: string;
  mcpUrl: string;
  port: number;
  token: string;
  /** True when the server is bound for LAN access (0.0.0.0). */
  lan: boolean;
  /** The LAN MCP URL a remote PC should use, or '' when LAN access is off / no LAN IP. */
  lanUrl: string;
}

export interface RecipeSummary {
  name: string;
  description?: string;
  domain: string;
  createdAt: number;
  updatedAt: number;
  steps: number;
}

export interface RecipeState {
  domain: string;
  recipes: RecipeSummary[];
}

/** Per-step annotation supplied by the renderer when saving/editing (never the action itself). */
export interface StepAnnotation {
  name?: string;
  description?: string;
}

export interface RecipePayload {
  name: string;
  description?: string;
  stepAnnotations: StepAnnotation[];
}

export interface ContainerInfo {
  id: string;
  name: string;
  createdAt: number;
}

export interface ContainerState {
  current: string;
  containers: ContainerInfo[];
}

export interface TabInfo {
  id: string;
  containerId: string;
  containerName: string;
  title: string;
}

export interface TabState {
  activeId: string;
  tabs: TabInfo[];
}

export interface AuditRecord {
  seq: number;
  ts: number;
  tabId: string;
  toolName: string;
  mode: string;
  outcome: string;
  reason?: string;
  detail?: string;
}

export interface AutoApproveState {
  actions: boolean;
  runjs: boolean;
}

export interface PrivacyRule {
  match: string;
  label: string;
}

export interface PrivacyState {
  enabled: boolean;
  rules: PrivacyRule[];
}

export interface DownloadRecord {
  id: number;
  filename: string;
  savePath: string;
  container: string;
  state: 'progressing' | 'completed' | 'cancelled' | 'interrupted';
  receivedBytes: number;
  totalBytes: number;
  startedAt: number;
}

contextBridge.exposeInMainWorld('safecobrowser', {
  // Navigation
  go: (url: string): Promise<void> => ipcRenderer.invoke('nav:go', url),
  back: (): Promise<void> => ipcRenderer.invoke('nav:back'),
  forward: (): Promise<void> => ipcRenderer.invoke('nav:forward'),
  reload: (): Promise<void> => ipcRenderer.invoke('nav:reload'),
  onPageState: (cb: (state: PageState) => void): void => {
    ipcRenderer.on('page:state', (_e, state: PageState) => cb(state));
  },

  // Per-tab AI permission control (the user is the ONLY one who can set the mode).
  setMode: (mode: string): Promise<void> => ipcRenderer.invoke('ai:set-mode', mode),
  stopAi: (): Promise<void> => ipcRenderer.invoke('ai:stop'),
  getAiState: (): Promise<AiState> => ipcRenderer.invoke('ai:get-state'),
  onAiState: (cb: (state: AiState) => void): void => {
    ipcRenderer.on('ai:state', (_e, state: AiState) => cb(state));
  },

  // Approval action cards (Act/Develop tiers).
  onApprovalRequest: (cb: (card: ApprovalCard) => void): void => {
    ipcRenderer.on('ai:approval-request', (_e, card: ApprovalCard) => cb(card));
  },
  onApprovalClose: (cb: (payload: { id: number }) => void): void => {
    ipcRenderer.on('ai:approval-close', (_e, payload: { id: number }) => cb(payload));
  },
  respondApproval: (id: number, approved: boolean): Promise<void> =>
    ipcRenderer.invoke('ai:approval-response', { id, approved }),

  // Action recorder + recipes (user-owned; separate from AI access).
  recordStart: (): Promise<void> => ipcRenderer.invoke('record:start'),
  recordStop: (): Promise<void> => ipcRenderer.invoke('record:stop'),
  recordClear: (): Promise<void> => ipcRenderer.invoke('record:clear'),
  getRecordState: (): Promise<RecordState> => ipcRenderer.invoke('record:state'),
  getRecordBuffer: (): Promise<unknown[]> => ipcRenderer.invoke('record:buffer'),
  onRecordState: (cb: (state: RecordState) => void): void => {
    ipcRenderer.on('record:state', (_e, state: RecordState) => cb(state));
  },
  saveRecipe: (
    payload: RecipePayload,
  ): Promise<{ saved?: string; steps?: number; domain?: string; error?: string }> =>
    ipcRenderer.invoke('recipe:save', payload),
  listRecipes: (): Promise<RecipeState> => ipcRenderer.invoke('recipe:list'),
  getRecipe: (domain: string, name: string): Promise<unknown> => ipcRenderer.invoke('recipe:get', domain, name),
  updateRecipe: (
    domain: string,
    originalName: string,
    payload: RecipePayload,
  ): Promise<{ saved?: string; steps?: number; error?: string }> =>
    ipcRenderer.invoke('recipe:update', domain, originalName, payload),
  deleteRecipe: (domain: string, name: string): Promise<boolean> => ipcRenderer.invoke('recipe:delete', domain, name),
  replayRecipe: (
    domain: string,
    name: string,
  ): Promise<{ performed?: number; skipped?: number; failed?: number; error?: string }> =>
    ipcRenderer.invoke('recipe:replay', domain, name),
  onRecipeState: (cb: (state: RecipeState) => void): void => {
    ipcRenderer.on('recipe:state', (_e, state: RecipeState) => cb(state));
  },

  // Containers (isolated sessions).
  listContainers: (): Promise<ContainerState> => ipcRenderer.invoke('container:list'),
  switchContainer: (id: string): Promise<void> => ipcRenderer.invoke('container:switch', id),
  createContainer: (name: string): Promise<{ id?: string; name?: string; error?: string }> =>
    ipcRenderer.invoke('container:create', name),
  renameContainer: (id: string, name: string): Promise<{ id?: string; name?: string; error?: string }> =>
    ipcRenderer.invoke('container:rename', id, name),
  removeContainer: (id: string): Promise<{ ok?: boolean; error?: string }> =>
    ipcRenderer.invoke('container:remove', id),
  onContainerState: (cb: (state: ContainerState) => void): void => {
    ipcRenderer.on('container:state', (_e, state: ContainerState) => cb(state));
  },

  // Tabs.
  listTabs: (): Promise<TabState> => ipcRenderer.invoke('tab:list'),
  newTab: (containerId?: string): Promise<void> => ipcRenderer.invoke('tab:new', containerId),
  closeTab: (id: string): Promise<void> => ipcRenderer.invoke('tab:close', id),
  switchTab: (id: string): Promise<void> => ipcRenderer.invoke('tab:switch', id),
  onTabState: (cb: (state: TabState) => void): void => {
    ipcRenderer.on('tab:state', (_e, state: TabState) => cb(state));
  },

  // Downloads (user surface only — the agent never sees these).
  getDownloads: (): Promise<DownloadRecord[]> => ipcRenderer.invoke('downloads:recent'),
  onDownloadState: (cb: (list: DownloadRecord[]) => void): void => {
    ipcRenderer.on('download:state', (_e, list: DownloadRecord[]) => cb(list));
  },
  revealDownload: (savePath: string): Promise<void> => ipcRenderer.invoke('downloads:reveal', savePath),
  openDownload: (savePath: string): Promise<string> => ipcRenderer.invoke('downloads:open', savePath),
  clearDownloads: (): Promise<void> => ipcRenderer.invoke('downloads:clear'),

  // Privacy filter (user-owned redaction rules).
  getPrivacy: (): Promise<PrivacyState> => ipcRenderer.invoke('privacy:get'),
  setPrivacyEnabled: (on: boolean): Promise<void> => ipcRenderer.invoke('privacy:set-enabled', on),
  setPrivacyRules: (rules: PrivacyRule[]): Promise<void> => ipcRenderer.invoke('privacy:set-rules', rules),
  onPrivacyState: (cb: (state: PrivacyState) => void): void => {
    ipcRenderer.on('privacy:state', (_e, state: PrivacyState) => cb(state));
  },

  // Settings (User-Agent override + approval timeout + agent tab control).
  getSettings: (): Promise<{
    userAgent: string;
    defaultUserAgent: string;
    approvalTimeoutMs: number;
    agentTabControl: boolean;
  }> => ipcRenderer.invoke('settings:get'),
  setUserAgent: (ua: string): Promise<{ userAgent: string; defaultUserAgent: string }> =>
    ipcRenderer.invoke('settings:set-ua', ua),
  setApprovalTimeout: (ms: number): Promise<{ approvalTimeoutMs: number }> =>
    ipcRenderer.invoke('settings:set-approval-timeout', ms),
  setTabControl: (on: boolean): Promise<{ agentTabControl: boolean }> =>
    ipcRenderer.invoke('settings:set-tab-control', on),

  // Feedback (in-app box → same backend as the agent's submit_feedback tool).
  sendFeedback: (message: string, email?: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('feedback:send', { message, email }),

  // Agent connection (Settings → Agent panel).
  getAgentEndpoint: (): Promise<AgentEndpoint> => ipcRenderer.invoke('agent:get-endpoint'),
  regenerateAgentToken: (): Promise<AgentEndpoint> => ipcRenderer.invoke('agent:regenerate-token'),
  setAgentPort: (port: number): Promise<AgentEndpoint & { ok: boolean; error?: string }> =>
    ipcRenderer.invoke('agent:set-port', port),
  setAgentLan: (on: boolean): Promise<AgentEndpoint & { ok: boolean; error?: string }> =>
    ipcRenderer.invoke('agent:set-lan', on),

  // Activity log.
  getRecentAudit: (): Promise<AuditRecord[]> => ipcRenderer.invoke('audit:recent'),
  onAuditEvent: (cb: (rec: AuditRecord) => void): void => {
    ipcRenderer.on('audit:event', (_e, rec: AuditRecord) => cb(rec));
  },
  setActivityOpen: (open: boolean): Promise<void> => ipcRenderer.invoke('ui:activity', open),
  setModalOpen: (open: boolean): Promise<void> => ipcRenderer.invoke('ui:modal', open),

  // Per-tab auto-approve.
  getAutoApprove: (): Promise<AutoApproveState> => ipcRenderer.invoke('ui:get-auto-approve'),
  setAutoApprove: (patch: Partial<AutoApproveState>): Promise<void> =>
    ipcRenderer.invoke('ui:auto-approve', patch),
  onAutoApproveState: (cb: (state: AutoApproveState) => void): void => {
    ipcRenderer.on('auto-approve:state', (_e, state: AutoApproveState) => cb(state));
  },

  // Per-tab real input (real isTrusted sendInputEvent vs JS-synthesized events).
  getRealInput: (): Promise<boolean> => ipcRenderer.invoke('ui:get-real-input'),
  setRealInput: (on: boolean): Promise<void> => ipcRenderer.invoke('ui:set-real-input', on),
  onRealInputState: (cb: (on: boolean) => void): void => {
    ipcRenderer.on('real-input:state', (_e, on: boolean) => cb(on));
  },
});
