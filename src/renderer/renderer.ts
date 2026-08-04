// Top-bar UI logic. Runs in the chrome WebContentsView with context isolation; talks to
// the main process only through the `safecobrowser` bridge (see preload). No imports/exports —
// this compiles to a plain browser script.

interface PageState {
  url: string;
  title: string;
  canGoBack: boolean;
  canGoForward: boolean;
  isLoading: boolean;
}

interface AiState {
  tabId: string;
  mode: string;
  epoch: number;
}

interface ApprovalPreviewData {
  image: string;
  w: number;
  h: number;
  x?: number;
  y?: number;
}
interface ApprovalCard {
  id: number;
  toolName: string;
  risk: string;
  summary: string;
  input: unknown;
  preview?: ApprovalPreviewData;
  /** Present only when the call targets a tab other than the active one. */
  targetTab?: string;
}

interface RecordState {
  recording: boolean;
  count: number;
}

interface RecipeSummary {
  name: string;
  description?: string;
  domain: string;
  createdAt: number;
  updatedAt: number;
  steps: number;
}

interface RecipeState {
  domain: string;
  recipes: RecipeSummary[];
}

// A captured action (mirrors src/recorder/actions.ts — only the fields the UI reads).
interface RecordedAction {
  type: 'click' | 'fill' | 'submit' | 'navigate';
  selector?: string;
  label?: string;
  value?: string | null;
  masked?: boolean;
  url?: string;
}

interface RecipeStep {
  action: RecordedAction;
  name?: string;
  description?: string;
}

interface Recipe {
  name: string;
  description?: string;
  domain: string;
  createdAt: number;
  updatedAt: number;
  steps: RecipeStep[];
}

interface StepAnnotation {
  name?: string;
  description?: string;
}

interface RecipePayload {
  name: string;
  description?: string;
  stepAnnotations: StepAnnotation[];
}

interface ContainerInfo {
  id: string;
  name: string;
  createdAt: number;
}

interface ContainerState {
  current: string;
  containers: ContainerInfo[];
}

interface TabInfo {
  id: string;
  containerId: string;
  containerName: string;
  title: string;
}

interface TabState {
  activeId: string;
  tabs: TabInfo[];
}

interface AuditRecord {
  seq: number;
  ts: number;
  tabId: string;
  toolName: string;
  mode: string;
  outcome: string;
  reason?: string;
  detail?: string;
}

interface UrlSuggestion {
  url: string;
  title: string;
}

interface SafeCoBrowserApi {
  go(url: string): Promise<void>;
  suggest(query: string): Promise<UrlSuggestion[]>;
  setSuggestOpen(open: boolean): Promise<void>;
  historyCount(): Promise<number>;
  clearHistory(): Promise<number>;
  back(): Promise<void>;
  forward(): Promise<void>;
  reload(): Promise<void>;
  toggleDevTools(): Promise<void>;
  onPageState(cb: (state: PageState) => void): void;
  setMode(mode: string): Promise<void>;
  stopAi(): Promise<void>;
  getAiState(): Promise<AiState>;
  onAiState(cb: (state: AiState) => void): void;
  onApprovalRequest(cb: (card: ApprovalCard) => void): void;
  onApprovalClose(cb: (payload: { id: number }) => void): void;
  respondApproval(id: number, approved: boolean): Promise<void>;
  recordStart(): Promise<void>;
  recordStop(): Promise<void>;
  recordClear(): Promise<void>;
  getRecordState(): Promise<RecordState>;
  getRecordBuffer(): Promise<RecordedAction[]>;
  onRecordState(cb: (state: RecordState) => void): void;
  saveRecipe(payload: RecipePayload): Promise<{ saved?: string; steps?: number; domain?: string; error?: string }>;
  listRecipes(): Promise<RecipeState>;
  getRecipe(domain: string, name: string): Promise<Recipe | null>;
  updateRecipe(
    domain: string,
    originalName: string,
    payload: RecipePayload,
  ): Promise<{ saved?: string; steps?: number; error?: string }>;
  deleteRecipe(domain: string, name: string): Promise<boolean>;
  replayRecipe(
    domain: string,
    name: string,
  ): Promise<{ performed?: number; skipped?: number; failed?: number; error?: string }>;
  onRecipeState(cb: (state: RecipeState) => void): void;
  listContainers(): Promise<ContainerState>;
  switchContainer(id: string): Promise<void>;
  createContainer(name: string): Promise<{ id?: string; name?: string; error?: string }>;
  renameContainer(id: string, name: string): Promise<{ id?: string; name?: string; error?: string }>;
  removeContainer(id: string): Promise<{ ok?: boolean; error?: string }>;
  onContainerState(cb: (state: ContainerState) => void): void;
  listTabs(): Promise<TabState>;
  newTab(containerId?: string): Promise<void>;
  closeTab(id: string): Promise<void>;
  switchTab(id: string): Promise<void>;
  onTabState(cb: (state: TabState) => void): void;
  getRecentAudit(): Promise<AuditRecord[]>;
  onAuditEvent(cb: (rec: AuditRecord) => void): void;
  setActivityOpen(open: boolean): Promise<void>;
  setModalOpen(open: boolean): Promise<void>;
  getAutoApprove(): Promise<{ actions: boolean; runjs: boolean }>;
  setAutoApprove(patch: { actions?: boolean; runjs?: boolean }): Promise<void>;
  onAutoApproveState(cb: (state: { actions: boolean; runjs: boolean }) => void): void;
  getRealInput(): Promise<boolean>;
  setRealInput(on: boolean): Promise<void>;
  onRealInputState(cb: (on: boolean) => void): void;
  getDownloads(): Promise<DownloadRecord[]>;
  onDownloadState(cb: (list: DownloadRecord[]) => void): void;
  revealDownload(savePath: string): Promise<void>;
  openDownload(savePath: string): Promise<string>;
  clearDownloads(): Promise<void>;
  getPrivacy(): Promise<PrivacyState>;
  setPrivacyEnabled(on: boolean): Promise<void>;
  setPrivacyRules(rules: PrivacyRule[]): Promise<void>;
  onPrivacyState(cb: (state: PrivacyState) => void): void;
  getSettings(): Promise<SettingsState>;
  setUserAgent(ua: string): Promise<{ userAgent: string; defaultUserAgent: string }>;
  setApprovalTimeout(ms: number): Promise<{ approvalTimeoutMs: number }>;
  setTabControl(on: boolean): Promise<{ agentTabControl: boolean }>;
  getAgentEndpoint(): Promise<AgentEndpoint>;
  regenerateAgentToken(): Promise<AgentEndpoint>;
  setAgentPort(port: number): Promise<AgentEndpoint & { ok: boolean; error?: string }>;
  setAgentLan(on: boolean): Promise<AgentEndpoint & { ok: boolean; error?: string }>;
  sendFeedback(message: string, email?: string): Promise<{ ok: boolean; error?: string }>;
}

interface SettingsState {
  userAgent: string;
  defaultUserAgent: string;
  approvalTimeoutMs: number;
  agentTabControl: boolean;
}

interface AgentEndpoint {
  url: string;
  mcpUrl: string;
  port: number;
  token: string;
  lan: boolean;
  lanUrl: string;
}

interface PrivacyRule {
  match: string;
  label: string;
}
interface PrivacyState {
  enabled: boolean;
  rules: PrivacyRule[];
}

interface DownloadRecord {
  id: number;
  filename: string;
  savePath: string;
  container: string;
  state: 'progressing' | 'completed' | 'cancelled' | 'interrupted';
  receivedBytes: number;
  totalBytes: number;
  startedAt: number;
}

const jt: SafeCoBrowserApi = (window as unknown as { safecobrowser: SafeCoBrowserApi }).safecobrowser;

const el = (id: string): HTMLElement => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing element #${id}`);
  return node;
};

// --- navigation ---
const addr = el('addr') as HTMLInputElement;
const backBtn = el('back') as HTMLButtonElement;
const forwardBtn = el('forward') as HTMLButtonElement;

backBtn.addEventListener('click', () => jt.back());
forwardBtn.addEventListener('click', () => jt.forward());
el('reload').addEventListener('click', () => jt.reload());
el('devtools-btn').addEventListener('click', () => void jt.toggleDevTools());
let realUrl = ''; // the true address; the bar shows a redacted version when the filter is on + unfocused
function paintAddress(): void {
  if (document.activeElement !== addr) addr.value = redactDisplay(realUrl);
}
// --- URL-bar autocomplete (from local history; human-only — the agent never sees history) ---
const suggestBox = el('addr-suggest');
let suggestions: UrlSuggestion[] = [];
let suggestActive = -1; // -1 = use the typed text as-is; >=0 indexes `suggestions`
let suggestTimer: number | undefined;

// Bold the matched substring using text nodes only — page titles/URLs are untrusted, never innerHTML.
function fillHighlighted(node: HTMLElement, text: string, query: string): void {
  node.textContent = '';
  const q = query.trim();
  const idx = q ? text.toLowerCase().indexOf(q.toLowerCase()) : -1;
  if (idx < 0) {
    node.textContent = text;
    return;
  }
  node.appendChild(document.createTextNode(text.slice(0, idx)));
  const b = document.createElement('b');
  b.textContent = text.slice(idx, idx + q.length);
  node.appendChild(b);
  node.appendChild(document.createTextNode(text.slice(idx + q.length)));
}

function closeSuggest(): void {
  if (suggestBox.hidden) return;
  suggestBox.hidden = true;
  suggestBox.textContent = '';
  suggestions = [];
  suggestActive = -1;
  void jt.setSuggestOpen(false); // let the chrome view shrink back to the toolbar
}

function setSuggestActive(i: number): void {
  suggestActive = i;
  [...suggestBox.children].forEach((child, idx) => {
    const on = idx === i;
    (child as HTMLElement).classList.toggle('active', on);
    if (on) (child as HTMLElement).scrollIntoView({ block: 'nearest' });
  });
}

function renderSuggest(query: string): void {
  suggestBox.textContent = '';
  suggestions.forEach((s, i) => {
    const item = document.createElement('div');
    item.className = 'suggest-item';
    item.setAttribute('role', 'option');
    const title = document.createElement('div');
    title.className = 's-title';
    fillHighlighted(title, redactDisplay(s.title || s.url), query); // display redacted; navigate to the real URL
    const url = document.createElement('div');
    url.className = 's-url';
    fillHighlighted(url, redactDisplay(s.url), query);
    item.append(title, url);
    item.addEventListener('mousedown', (e) => e.preventDefault()); // don't blur the input on click
    item.addEventListener('click', () => selectSuggestion(i));
    item.addEventListener('mouseenter', () => setSuggestActive(i));
    suggestBox.appendChild(item);
  });
  suggestBox.hidden = false;
  setSuggestActive(-1);
  void jt.setSuggestOpen(true); // grow the chrome view so the list shows over the page
}

function selectSuggestion(i: number): void {
  const s = suggestions[i];
  if (!s) return;
  closeSuggest();
  addr.blur();
  void jt.go(s.url); // navigate to the exact stored URL, never the redacted display text
}

async function refreshSuggest(): Promise<void> {
  const query = addr.value;
  if (!query.trim()) {
    closeSuggest();
    return;
  }
  const results = await jt.suggest(query);
  // The field may have changed (or lost focus) while we awaited — only show results for the live text.
  if (addr.value !== query || document.activeElement !== addr) return;
  suggestions = results;
  if (!results.length) {
    closeSuggest();
    return;
  }
  renderSuggest(query);
}

addr.addEventListener('input', () => {
  window.clearTimeout(suggestTimer);
  suggestTimer = window.setTimeout(() => void refreshSuggest(), 80);
});

addr.addEventListener('keydown', (e: KeyboardEvent) => {
  const open = !suggestBox.hidden && suggestions.length > 0;
  if (e.key === 'ArrowDown' && open) {
    e.preventDefault();
    setSuggestActive((suggestActive + 1) % suggestions.length);
  } else if (e.key === 'ArrowUp' && open) {
    e.preventDefault();
    setSuggestActive(suggestActive <= 0 ? suggestions.length - 1 : suggestActive - 1);
  } else if (e.key === 'Enter') {
    if (open && suggestActive >= 0) {
      selectSuggestion(suggestActive);
    } else {
      closeSuggest();
      jt.go(addr.value);
    }
  } else if (e.key === 'Escape' && open) {
    e.preventDefault();
    closeSuggest();
  }
});
addr.addEventListener('focus', () => {
  addr.value = realUrl; // reveal the real URL so it stays editable
  addr.select();
});
addr.addEventListener('blur', () => {
  closeSuggest();
  paintAddress();
});
jt.onPageState((s: PageState) => {
  realUrl = s.url || '';
  paintAddress();
  backBtn.disabled = !s.canGoBack;
  forwardBtn.disabled = !s.canGoForward;
});

// --- AI permission control ---
const indicator = el('ai-indicator');
const modeSelect = el('mode') as HTMLSelectElement;
const stopBtn = el('stop-ai') as HTMLButtonElement;

const MODE_LABELS: Record<string, string> = {
  blocked: 'AI Off',
  read: 'AI Read-Only',
  inspect: 'AI Inspect',
  act: 'AI Assist',
  develop: 'AI Developer',
};

function renderAiState(state: AiState): void {
  const mode = state.mode || 'blocked';
  indicator.textContent = MODE_LABELS[mode] ?? `AI ${mode}`;
  indicator.className = `mode-${mode}`;
  modeSelect.value = mode;
  stopBtn.disabled = mode === 'blocked';
}

modeSelect.addEventListener('change', () => {
  void jt.setMode(modeSelect.value);
});
stopBtn.addEventListener('click', () => {
  void jt.stopAi();
});
jt.onAiState((state) => renderAiState(state));
void jt.getAiState().then((state) => renderAiState(state));

// --- approval cards (plumbing; Act/Develop tiers in Phase 4) ---
const approval = el('approval');
const approvalRisk = el('approval-risk');
const approvalSummary = el('approval-summary');
const approvalTab = el('approval-tab');
const approvalDetail = el('approval-detail');
const approvalPreview = el('approval-preview');
const approvalPreviewImg = el('approval-preview-img') as HTMLImageElement;
const approvalCrosshair = el('approval-crosshair');
let currentApprovalId: number | null = null;

// Show a screenshot + crosshair for coordinate ("computer use") actions so the human approves
// WHAT is about to be acted on, not a bare (x,y). The crosshair is positioned proportionally so it
// stays correct as the image scales to the card width.
function renderApprovalPreview(preview: ApprovalPreviewData | undefined): void {
  if (!preview || !preview.image) {
    approvalPreview.classList.remove('show');
    approvalPreviewImg.removeAttribute('src');
    return;
  }
  approvalPreviewImg.src = `data:image/png;base64,${preview.image}`;
  if (typeof preview.x === 'number' && typeof preview.y === 'number' && preview.w > 0 && preview.h > 0) {
    approvalCrosshair.style.left = `${(preview.x / preview.w) * 100}%`;
    approvalCrosshair.style.top = `${(preview.y / preview.h) * 100}%`;
    approvalCrosshair.classList.add('show');
  } else {
    approvalCrosshair.classList.remove('show');
  }
  approvalPreview.classList.add('show');
}

// Render the concrete effect the user is approving (e.g. the exact run_js script).
function approvalDetailText(input: unknown): string {
  if (input && typeof input === 'object') {
    const script = (input as { script?: unknown }).script;
    if (typeof script === 'string') return script;
    return JSON.stringify(input, null, 2);
  }
  return '';
}

function closeApproval(approved: boolean): void {
  if (currentApprovalId === null) return;
  const id = currentApprovalId;
  currentApprovalId = null;
  approval.classList.remove('show');
  renderApprovalPreview(undefined); // drop the screenshot from the DOM
  void jt.respondApproval(id, approved);
}

jt.onApprovalRequest((card) => {
  currentApprovalId = card.id;
  approvalRisk.textContent = `${card.risk} risk`;
  approvalSummary.textContent = `AI wants to: ${card.summary}`;
  // Only shown when the call targets a tab other than the one on screen — makes a background-tab
  // action legible instead of the human assuming it's about the tab they're looking at.
  approvalTab.textContent = card.targetTab ? `Tab: ${card.targetTab}` : '';
  approvalTab.classList.toggle('show', Boolean(card.targetTab));
  const detail = approvalDetailText(card.input);
  approvalDetail.textContent = detail;
  approvalDetail.classList.toggle('show', detail.length > 0);
  renderApprovalPreview(card.preview);
  approval.classList.add('show');
});
el('approve').addEventListener('click', () => closeApproval(true));
el('reject').addEventListener('click', () => closeApproval(false));

// Main settled the request elsewhere (timeout, or revoke) — just hide the card.
jt.onApprovalClose((p) => {
  if (currentApprovalId === p.id) {
    currentApprovalId = null;
    approval.classList.remove('show');
    approvalDetail.classList.remove('show');
  }
});

// --- recorder + recipes (domain-keyed tutorials) ---
const recordBtn = el('record') as HTMLButtonElement;
const recClear = el('rec-clear') as HTMLButtonElement;
const recSave = el('rec-save') as HTMLButtonElement;
const recipesBtn = el('recipes-btn') as HTMLButtonElement;
const recStatus = el('rec-status');

// recipe manager modal
const rcModal = el('recipe-modal');
const rcTitle = el('rc-title');
const rcSub = el('rc-sub');
const rcList = el('rc-list');
const rcError = el('rc-error');
const rcClose = el('rc-close') as HTMLButtonElement;

// recipe editor modal
const edModal = el('editor-modal');
const edTitle = el('ed-title');
const edName = el('ed-name') as HTMLInputElement;
const edDesc = el('ed-desc') as HTMLTextAreaElement;
const edSteps = el('ed-steps');
const edError = el('ed-error');
const edSave = el('ed-save') as HTMLButtonElement;
const edCancel = el('ed-cancel') as HTMLButtonElement;

let recState: RecordState = { recording: false, count: 0 };
let recipeDomain = ''; // registrable domain of the active page; '' = recipes unavailable
let currentRecipes: RecipeSummary[] = [];
let managerRecipesOpen = false;
let armedDeleteRecipe: string | null = null; // composite "domain\nname" key (names repeat across domains)
let editorOriginalName: string | null = null; // null = saving a new recording; else editing
let editorDomain = ''; // the domain the editor saves to (current site for new; the recipe's for edit)
let editorSteps: RecipeStep[] = [];

const recipeKey = (domain: string, name: string): string => `${domain}\n${name}`;

function describeAction(a: RecordedAction): string {
  if (a.type === 'click') return `click ${a.label ? `“${a.label}”` : a.selector ?? ''}`;
  if (a.type === 'fill') {
    const target = a.label || a.selector || '';
    return a.masked ? `fill ${target} — sensitive (skipped on replay)` : `fill ${target}`;
  }
  if (a.type === 'submit') return `press Enter ${a.label ? `in “${a.label}”` : ''}`.trim();
  if (a.type === 'navigate') return `go ${a.url ?? ''}`;
  return a.type;
}

function updateRecorderAvailability(): void {
  recordBtn.textContent = recState.recording ? `■ Stop (${recState.count})` : '● Record';
  recordBtn.classList.toggle('on', recState.recording);
  recordBtn.disabled = !recipeDomain && !recState.recording;
  recordBtn.title = recipeDomain ? 'Record your actions on this site' : 'Open a website to record';
  recClear.disabled = recState.count === 0;
  recSave.disabled = recState.count === 0 || !recipeDomain;
  recipesBtn.classList.toggle('on', managerRecipesOpen);
}

function renderRecState(s: RecordState): void {
  recState = s;
  updateRecorderAvailability();
}

function setRecipeState(s: RecipeState): void {
  recipeDomain = s.domain;
  currentRecipes = s.recipes;
  updateRecorderAvailability();
  renderRecipeManager();
}

// ---- recipe manager (all recipes, grouped by domain) ----
function renderRecipeManager(): void {
  if (!managerRecipesOpen) return;
  rcTitle.textContent = 'All recipes';
  rcSub.textContent = 'Every saved tutorial, grouped by site. ▶ Replay runs on the current page.';
  rcList.replaceChildren();
  if (currentRecipes.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'mg-row';
    empty.style.color = 'color-mix(in srgb, CanvasText 45%, transparent)';
    empty.textContent = 'No recipes yet — open a site and press ● Record to make one.';
    rcList.appendChild(empty);
    return;
  }

  // Group by domain so a forgotten recipe is easy to find under its site.
  const byDomain = new Map<string, RecipeSummary[]>();
  for (const r of currentRecipes) {
    const list = byDomain.get(r.domain) ?? [];
    list.push(r);
    byDomain.set(r.domain, list);
  }
  for (const domain of [...byDomain.keys()].sort()) {
    const head = document.createElement('div');
    head.className = 'rc-domain-head';
    head.textContent = domain || 'unknown';
    if (domain && domain === recipeDomain) head.classList.add('current'); // highlight the active site
    rcList.appendChild(head);

    for (const r of byDomain.get(domain)!) {
      const row = document.createElement('div');
      row.className = 'mg-row';

      const name = document.createElement('span');
      name.className = 'mg-name';
      name.textContent = r.name;
      name.title = r.description || r.name;
      row.appendChild(name);

      const cnt = document.createElement('span');
      cnt.className = 'mg-count';
      cnt.textContent = r.steps === 1 ? '1 step' : `${r.steps} steps`;
      row.appendChild(cnt);

      const replay = document.createElement('button');
      replay.textContent = '▶ Replay';
      replay.title = 'Replay this recipe on the current page';
      replay.addEventListener('click', () => void doReplay(r.domain, r.name));
      row.appendChild(replay);

      const edit = document.createElement('button');
      edit.textContent = 'Edit';
      edit.addEventListener('click', () => void openEditorForExisting(r.domain, r.name));
      row.appendChild(edit);

      const key = recipeKey(r.domain, r.name);
      const del = document.createElement('button');
      del.className = 'danger';
      del.textContent = armedDeleteRecipe === key ? 'Confirm?' : 'Delete';
      del.addEventListener('click', () => {
        rcError.style.color = '#ff453a';
        if (armedDeleteRecipe !== key) {
          armedDeleteRecipe = key;
          renderRecipeManager();
          return;
        }
        void doDeleteRecipe(r.domain, r.name);
      });
      row.appendChild(del);

      rcList.appendChild(row);
    }
  }
}

async function doReplay(domain: string, name: string): Promise<void> {
  closeRecipeManager(); // get the full-window overlay out of the way so the page is visible during replay
  let wasRecording = false;
  if (recState.recording) {
    wasRecording = true;
    await jt.recordStop(); // can't record and replay at once — pause recording first (buffer is kept)
  }
  recStatus.textContent = `▶ Replaying “${name}”…${wasRecording ? ' (recording paused)' : ''}`;
  const res = await jt.replayRecipe(domain, name);
  if (res.error) {
    recStatus.textContent = `Replay failed: ${res.error}`;
    return;
  }
  let msg = `Replayed “${name}”: ${res.performed} done, ${res.skipped} skipped, ${res.failed} failed.`;
  if (domain && recipeDomain && domain !== recipeDomain) {
    msg += ` (recipe is for ${domain} — open that site for it to match.)`;
  }
  recStatus.textContent = msg;
}

async function doDeleteRecipe(domain: string, name: string): Promise<void> {
  const ok = await jt.deleteRecipe(domain, name);
  armedDeleteRecipe = null;
  if (!ok) {
    rcError.style.color = '#ff453a';
    rcError.textContent = 'Delete failed.';
    return;
  }
  // recipe:state push refreshes the list
}

function openRecipeManager(): void {
  managerRecipesOpen = true;
  armedDeleteRecipe = null;
  rcError.textContent = '';
  rcModal.classList.add('show');
  void jt.setModalOpen(true);
  recipesBtn.classList.add('on');
  renderRecipeManager(); // paint immediately from cache…
  // …then refresh from disk so the list can't go stale (recipes may have changed underneath us).
  void jt.listRecipes().then((s) => {
    if (managerRecipesOpen) setRecipeState(s);
  });
}
function closeRecipeManager(): void {
  managerRecipesOpen = false;
  rcModal.classList.remove('show');
  recipesBtn.classList.remove('on');
  if (!edModal.classList.contains('show')) void jt.setModalOpen(false);
}

// ---- recipe editor (used for both new-save and edit) ----
function openEditor(
  domain: string,
  originalName: string | null,
  name: string,
  description: string,
  steps: RecipeStep[],
): void {
  editorDomain = domain;
  editorOriginalName = originalName;
  editorSteps = steps;
  edTitle.textContent = originalName === null ? `Save recipe — ${domain}` : `Edit recipe — ${domain}`;
  edName.value = name;
  edDesc.value = description;
  edError.textContent = '';
  renderEditorSteps();
  edModal.classList.add('show');
  void jt.setModalOpen(true);
  edName.focus();
}

function renderEditorSteps(): void {
  edSteps.replaceChildren();
  editorSteps.forEach((step, i) => {
    const row = document.createElement('div');
    row.className = 'ed-step';

    const head = document.createElement('div');
    head.className = 'ed-step-head';
    const num = document.createElement('span');
    num.className = 'ed-step-num';
    num.textContent = `${i + 1}.`;
    const act = document.createElement('span');
    act.className = 'ed-step-action';
    act.textContent = describeAction(step.action);
    head.append(num, act);
    row.appendChild(head);

    const nameInput = document.createElement('input');
    nameInput.placeholder = 'Step name (optional)';
    nameInput.maxLength = 200;
    nameInput.value = step.name ?? '';
    nameInput.dataset.idx = String(i);
    nameInput.dataset.field = 'name';

    const descInput = document.createElement('input');
    descInput.placeholder = 'What this step does (optional)';
    descInput.maxLength = 2000;
    descInput.value = step.description ?? '';
    descInput.dataset.idx = String(i);
    descInput.dataset.field = 'desc';

    row.append(nameInput, descInput);
    edSteps.appendChild(row);
  });
}

function collectAnnotations(): StepAnnotation[] {
  const annos: StepAnnotation[] = editorSteps.map(() => ({}));
  edSteps.querySelectorAll('input').forEach((node) => {
    const inp = node as HTMLInputElement;
    const idx = Number(inp.dataset.idx);
    const v = inp.value.trim();
    if (!v || Number.isNaN(idx) || !annos[idx]) return;
    if (inp.dataset.field === 'name') annos[idx].name = v;
    else if (inp.dataset.field === 'desc') annos[idx].description = v;
  });
  return annos;
}

function closeEditor(): void {
  edModal.classList.remove('show');
  if (!managerRecipesOpen) void jt.setModalOpen(false); // keep expanded if the manager is underneath
}

async function submitEditor(): Promise<void> {
  const name = edName.value.trim();
  if (!name) {
    edError.textContent = 'Enter a recipe name.';
    edName.focus();
    return;
  }
  const dup = currentRecipes.some(
    (r) =>
      r.domain === editorDomain &&
      r.name.toLowerCase() === name.toLowerCase() &&
      r.name.toLowerCase() !== (editorOriginalName ?? '').toLowerCase(),
  );
  if (dup) {
    edError.textContent = `A recipe named “${name}” already exists for ${editorDomain}.`;
    edName.focus();
    return;
  }
  const payload: RecipePayload = { name, stepAnnotations: collectAnnotations() };
  const desc = edDesc.value.trim();
  if (desc) payload.description = desc;

  edSave.disabled = true;
  // New recordings save to the current site (server uses currentDomain); edits target the recipe's own domain.
  const res =
    editorOriginalName === null ? await jt.saveRecipe(payload) : await jt.updateRecipe(editorDomain, editorOriginalName, payload);
  edSave.disabled = false;
  if (res.error) {
    edError.textContent = res.error;
    return;
  }
  recStatus.textContent = `saved “${res.saved}” (${res.steps} steps)`;
  closeEditor(); // recipe:state push refreshes the manager list
}

async function openEditorForExisting(domain: string, name: string): Promise<void> {
  const recipe = await jt.getRecipe(domain, name);
  if (!recipe) {
    rcError.style.color = '#ff453a';
    rcError.textContent = `“${name}” no longer exists — refreshing the list.`;
    void jt.listRecipes().then((s) => setRecipeState(s)); // drop the stale row
    return;
  }
  openEditor(recipe.domain, recipe.name, recipe.name, recipe.description ?? '', recipe.steps);
}

// ---- wiring ----
recordBtn.addEventListener('click', () => {
  if (recState.recording) void jt.recordStop();
  else void jt.recordStart();
});
recClear.addEventListener('click', () => void jt.recordClear());
recSave.addEventListener('click', async () => {
  const buffer = await jt.getRecordBuffer();
  openEditor(recipeDomain, null, '', '', buffer.map((action) => ({ action })));
});
recipesBtn.addEventListener('click', () => (managerRecipesOpen ? closeRecipeManager() : openRecipeManager()));
rcClose.addEventListener('click', closeRecipeManager);
rcModal.addEventListener('mousedown', (e) => {
  if (e.target === rcModal) closeRecipeManager();
});
edSave.addEventListener('click', () => void submitEditor());
edCancel.addEventListener('click', closeEditor);
edModal.addEventListener('mousedown', (e) => {
  if (e.target === edModal) closeEditor();
});
edName.addEventListener('keydown', (e: KeyboardEvent) => {
  if (e.key === 'Escape') closeEditor();
});

jt.onRecordState((s) => renderRecState(s));
jt.onRecipeState((s) => setRecipeState(s));
void jt.getRecordState().then((s) => renderRecState(s));
void jt.listRecipes().then((s) => setRecipeState(s));

// --- containers (isolated sessions) ---
const containerSel = el('container') as HTMLSelectElement;
const containerNew = el('container-new') as HTMLButtonElement;
const cmModal = el('container-modal');
const cmName = el('cm-name') as HTMLInputElement;
const cmError = el('cm-error');
const cmCreate = el('cm-create') as HTMLButtonElement;
const cmCancel = el('cm-cancel') as HTMLButtonElement;

let containers: ContainerInfo[] = []; // latest known list — for duplicate-name checks
let latestTabs: TabInfo[] = []; // latest tab list — for per-container tab counts in the manager

function renderContainers(state: ContainerState): void {
  containers = state.containers;
  containerSel.replaceChildren();
  for (const c of state.containers) {
    const o = document.createElement('option');
    o.value = c.id;
    o.textContent = c.name;
    if (c.id === state.current) o.selected = true;
    containerSel.appendChild(o);
  }
  renderManager(); // keep the manager modal in sync if it's open
}

containerSel.addEventListener('change', () => void jt.switchContainer(containerSel.value));

function openContainerModal(): void {
  cmName.value = '';
  cmError.textContent = '';
  cmModal.classList.add('show');
  void jt.setModalOpen(true); // expand the chrome view to full window so the modal can center over the page
  cmName.focus();
}
function closeContainerModal(): void {
  cmModal.classList.remove('show');
  void jt.setModalOpen(false);
}
async function submitContainerModal(): Promise<void> {
  const name = cmName.value.trim();
  if (!name) {
    cmError.textContent = 'Enter a name.';
    cmName.focus();
    return;
  }
  if (containers.some((c) => c.name.toLowerCase() === name.toLowerCase())) {
    cmError.textContent = `A container named “${name}” already exists.`;
    cmName.focus();
    return;
  }
  cmCreate.disabled = true;
  const res = await jt.createContainer(name);
  cmCreate.disabled = false;
  if (res.error) {
    cmError.textContent = res.error;
    return;
  }
  closeContainerModal(); // the container:state push refreshes + switches the dropdown
}

containerNew.addEventListener('click', openContainerModal);
cmCreate.addEventListener('click', () => void submitContainerModal());
cmCancel.addEventListener('click', closeContainerModal);
cmModal.addEventListener('mousedown', (e) => {
  if (e.target === cmModal) closeContainerModal(); // backdrop click
});
cmName.addEventListener('input', () => {
  cmError.textContent = '';
});
cmName.addEventListener('keydown', (e: KeyboardEvent) => {
  if (e.key === 'Enter') void submitContainerModal();
  else if (e.key === 'Escape') closeContainerModal();
});

jt.onContainerState((s) => renderContainers(s));
void jt.listContainers().then((s) => renderContainers(s));

// --- container manager (rename / delete) ---
const containerManage = el('container-manage') as HTMLButtonElement;
const mgModal = el('manage-modal');
const mgList = el('mg-list');
const mgError = el('mg-error');
const mgClose = el('mg-close') as HTMLButtonElement;
let managerOpen = false;
let armedDeleteId: string | null = null; // a delete button waiting for its confirm click

const tabCount = (id: string): number => latestTabs.filter((t) => t.containerId === id).length;

function renderManager(): void {
  if (!managerOpen) return;
  mgList.replaceChildren();
  for (const c of containers) {
    const isDefault = c.id === 'default';
    const count = tabCount(c.id);
    const row = document.createElement('div');
    row.className = 'mg-row';

    const name = document.createElement('span');
    name.className = 'mg-name';
    name.textContent = c.name;
    row.appendChild(name);

    const cnt = document.createElement('span');
    cnt.className = 'mg-count';
    cnt.textContent = count === 1 ? '1 tab' : `${count} tabs`;
    row.appendChild(cnt);

    const rename = document.createElement('button');
    rename.textContent = 'Rename';
    rename.disabled = isDefault;
    rename.title = isDefault ? 'The Default container can’t be renamed' : 'Rename this container';
    rename.addEventListener('click', () => beginRename(row, c.id, c.name));
    row.appendChild(rename);

    const del = document.createElement('button');
    del.className = 'danger';
    const armed = armedDeleteId === c.id;
    del.textContent = armed ? 'Confirm?' : 'Delete';
    del.disabled = isDefault;
    del.title = isDefault ? 'The Default container can’t be deleted' : 'Delete this container (wipes its session)';
    del.addEventListener('click', () => {
      mgError.textContent = '';
      if (count > 0) {
        mgError.textContent = `“${c.name}” has ${count} open tab(s) — close them first.`;
        return;
      }
      if (armedDeleteId !== c.id) {
        armedDeleteId = c.id; // first click arms; second click (below) confirms
        renderManager();
        return;
      }
      void doDelete(c.id);
    });
    row.appendChild(del);

    mgList.appendChild(row);
  }
}

function beginRename(row: HTMLDivElement, id: string, current: string): void {
  armedDeleteId = null;
  mgError.textContent = '';
  const input = document.createElement('input');
  input.className = 'mg-name-input';
  input.value = current;
  input.maxLength = 40;
  const save = document.createElement('button');
  save.textContent = 'Save';
  const cancel = document.createElement('button');
  cancel.textContent = 'Cancel';
  row.replaceChildren(input, save, cancel);
  input.focus();
  input.select();

  const commit = async (): Promise<void> => {
    const next = input.value.trim();
    if (!next) {
      mgError.textContent = 'Enter a name.';
      input.focus();
      return;
    }
    if (containers.some((c) => c.id !== id && c.name.toLowerCase() === next.toLowerCase())) {
      mgError.textContent = `A container named “${next}” already exists.`;
      input.focus();
      return;
    }
    if (next === current) {
      renderManager();
      return;
    }
    save.disabled = true;
    const res = await jt.renameContainer(id, next);
    if (res.error) {
      save.disabled = false;
      mgError.textContent = res.error;
      return;
    }
    // the container:state push re-renders the manager
  };
  save.addEventListener('click', () => void commit());
  cancel.addEventListener('click', renderManager);
  input.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Enter') void commit();
    else if (e.key === 'Escape') renderManager();
  });
}

async function doDelete(id: string): Promise<void> {
  const res = await jt.removeContainer(id);
  armedDeleteId = null;
  if (res.error) {
    mgError.textContent = res.error;
    renderManager();
    return;
  }
  // the container:state push re-renders the manager
}

function openManager(): void {
  managerOpen = true;
  armedDeleteId = null;
  mgError.textContent = '';
  mgModal.classList.add('show');
  void jt.setModalOpen(true);
  renderManager();
}
function closeManager(): void {
  managerOpen = false;
  mgModal.classList.remove('show');
  void jt.setModalOpen(false);
}

containerManage.addEventListener('click', openManager);
mgClose.addEventListener('click', closeManager);
mgModal.addEventListener('mousedown', (e) => {
  if (e.target === mgModal) closeManager(); // backdrop click
});

// --- downloads ---
const downloadsBtn = el('downloads-btn') as HTMLButtonElement;
const dlModal = el('downloads-modal');
const dlList = el('dl-list');
const dlClose = el('dl-close') as HTMLButtonElement;
const dlClear = el('dl-clear') as HTMLButtonElement;
let downloadsOpen = false;
let latestDownloads: DownloadRecord[] = [];

function fmtBytes(n: number): string {
  if (!n || n < 0) return '';
  const u = ['B', 'KB', 'MB', 'GB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${i === 0 || v >= 10 ? Math.round(v) : v.toFixed(1)} ${u[i]}`;
}

function dlStatus(d: DownloadRecord): string {
  if (d.state === 'completed') return fmtBytes(d.receivedBytes) || 'Done';
  if (d.state === 'progressing') {
    if (d.totalBytes > 0) return `${Math.round((d.receivedBytes / d.totalBytes) * 100)}% · ${fmtBytes(d.receivedBytes)}`;
    return `${fmtBytes(d.receivedBytes)}…`;
  }
  return d.state === 'cancelled' ? 'Cancelled' : 'Interrupted';
}

function renderDownloads(): void {
  if (!downloadsOpen) return;
  dlList.replaceChildren();
  if (latestDownloads.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'dl-empty';
    empty.textContent = 'No downloads yet. Files you download land in this container’s folder.';
    dlList.appendChild(empty);
    return;
  }
  for (const d of latestDownloads) {
    const row = document.createElement('div');
    row.className = 'mg-row';

    const name = document.createElement('span');
    name.className = 'mg-name';
    name.textContent = redactDisplay(d.filename); // display redacted; Reveal/Open still use the real path
    name.title = redactDisplay(d.savePath);
    row.appendChild(name);

    const meta = document.createElement('span');
    meta.className = 'dl-meta';
    meta.textContent = dlStatus(d);
    row.appendChild(meta);

    const reveal = document.createElement('button');
    reveal.textContent = 'Reveal';
    reveal.disabled = d.state !== 'completed';
    reveal.addEventListener('click', () => void jt.revealDownload(d.savePath));
    row.appendChild(reveal);

    const open = document.createElement('button');
    open.textContent = 'Open';
    open.disabled = d.state !== 'completed';
    open.addEventListener('click', () => void jt.openDownload(d.savePath));
    row.appendChild(open);

    dlList.appendChild(row);
  }
}

async function openDownloads(): Promise<void> {
  downloadsOpen = true;
  latestDownloads = await jt.getDownloads();
  dlModal.classList.add('show');
  void jt.setModalOpen(true);
  renderDownloads();
}
function closeDownloads(): void {
  downloadsOpen = false;
  dlModal.classList.remove('show');
  void jt.setModalOpen(false);
}

downloadsBtn.addEventListener('click', () => void openDownloads());
dlClose.addEventListener('click', closeDownloads);
dlClear.addEventListener('click', () => void jt.clearDownloads());
dlModal.addEventListener('mousedown', (e) => {
  if (e.target === dlModal) closeDownloads(); // backdrop click
});
jt.onDownloadState((list) => {
  latestDownloads = list;
  // Live signal on the toolbar button even when the panel is closed.
  downloadsBtn.textContent = list.some((d) => d.state === 'progressing') ? '⬇ Downloading…' : '⬇ Downloads';
  renderDownloads();
});

// --- privacy filter ---
const privacyToggle = el('privacy-toggle') as HTMLInputElement;
const privacyLabel = el('privacy-label');
const pvModal = el('privacy-modal');
const pvEnabled = el('pv-enabled') as HTMLInputElement;
const pvList = el('pv-list');
const pvMatch = el('pv-match') as HTMLInputElement;
const pvReplace = el('pv-replace') as HTMLInputElement;
const pvAddBtn = el('pv-add') as HTMLButtonElement;
const pvClose = el('pv-close') as HTMLButtonElement;
const pvError = el('pv-error');
let privacyState: PrivacyState = { enabled: false, rules: [] };
let privacyManagerOpen = false;

/** Redact chrome-UI text (URL bar, download names) the same way the page DOM is redacted — these
 *  live outside the page, so they need the same rules applied here. Best-effort, literal. */
function redactDisplay(text: string): string {
  if (!privacyState.enabled || !text) return text;
  const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let out = text;
  for (const r of [...privacyState.rules].filter((r) => r.match).sort((a, b) => b.match.length - a.match.length)) {
    out = out.replace(new RegExp(esc(r.match), 'gi'), r.label || '[Filtered]');
  }
  return out;
}

function applyPrivacyToUi(s: PrivacyState): void {
  privacyState = { enabled: s.enabled, rules: s.rules };
  privacyToggle.checked = s.enabled;
  privacyLabel.classList.toggle('on', s.enabled);
  privacyLabel.title = `${s.rules.length} rule(s) · ${s.enabled ? 'redacting' : 'off'}`;
  if (privacyManagerOpen) renderPrivacyRules();
  paintAddress(); // re-redact the URL bar
  if (downloadsOpen) renderDownloads(); // re-redact the downloads list
  if (latestTabs.length) renderTabs({ activeId: activeTabId, tabs: latestTabs }); // re-redact tab titles
  if (activityShown) void refreshActivity(); // re-redact the activity log
}

function renderPrivacyRules(): void {
  pvEnabled.checked = privacyState.enabled;
  pvList.replaceChildren();
  if (privacyState.rules.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'dl-empty';
    empty.textContent = 'No rules yet — add the text you want hidden (your name, address…).';
    pvList.appendChild(empty);
    return;
  }
  for (const r of privacyState.rules) {
    const row = document.createElement('div');
    row.className = 'mg-row';

    const match = document.createElement('span');
    match.className = 'mg-name';
    match.textContent = r.match;
    row.appendChild(match);

    const arrow = document.createElement('span');
    arrow.className = 'pv-label';
    arrow.textContent = `→ ${r.label}`;
    row.appendChild(arrow);

    const del = document.createElement('button');
    del.className = 'danger';
    del.textContent = 'Remove';
    del.addEventListener('click', () => {
      const next = privacyState.rules.filter((x) => x.match.toLowerCase() !== r.match.toLowerCase());
      void jt.setPrivacyRules(next); // privacy:state push re-renders
    });
    row.appendChild(del);

    pvList.appendChild(row);
  }
}

function addPrivacyRule(): void {
  pvError.textContent = '';
  const match = pvMatch.value.trim();
  const label = pvReplace.value.trim() || '[Filtered]';
  if (!match) {
    pvError.textContent = 'Enter the text to hide.';
    pvMatch.focus();
    return;
  }
  if (privacyState.rules.some((r) => r.match.toLowerCase() === match.toLowerCase())) {
    pvError.textContent = 'That text already has a rule.';
    return;
  }
  void jt.setPrivacyRules([...privacyState.rules, { match, label }]);
  pvMatch.value = '';
  pvReplace.value = '';
  pvMatch.focus();
}

function openPrivacyManager(): void {
  privacyManagerOpen = true;
  pvError.textContent = '';
  pvModal.classList.add('show');
  void jt.setModalOpen(true);
  renderPrivacyRules();
}
function closePrivacyManager(): void {
  privacyManagerOpen = false;
  pvModal.classList.remove('show');
  void jt.setModalOpen(false);
}

privacyToggle.addEventListener('change', () => void jt.setPrivacyEnabled(privacyToggle.checked));
pvEnabled.addEventListener('change', () => void jt.setPrivacyEnabled(pvEnabled.checked));
el('privacy-manage').addEventListener('click', openPrivacyManager);
pvAddBtn.addEventListener('click', addPrivacyRule);
pvMatch.addEventListener('keydown', (e: KeyboardEvent) => {
  if (e.key === 'Enter') pvReplace.focus();
});
pvReplace.addEventListener('keydown', (e: KeyboardEvent) => {
  if (e.key === 'Enter') addPrivacyRule();
});
pvClose.addEventListener('click', closePrivacyManager);
pvModal.addEventListener('mousedown', (e) => {
  if (e.target === pvModal) closePrivacyManager();
});
jt.onPrivacyState((s) => applyPrivacyToUi(s));
void jt.getPrivacy().then((s) => applyPrivacyToUi(s));

// --- settings: global User-Agent override ---
interface UaPreset {
  id: string;
  label: string;
  ua: string; // '' = browser default
}
const UA_PRESETS: UaPreset[] = [
  { id: 'default', label: 'Default (this browser)', ua: '' },
  {
    id: 'chrome-win',
    label: 'Chrome — Windows',
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  },
  {
    id: 'chrome-mac',
    label: 'Chrome — macOS',
    ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  },
  {
    id: 'safari-ios',
    label: 'Safari — iPhone',
    ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  },
  {
    id: 'chrome-android',
    label: 'Chrome — Android',
    ua: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36',
  },
];

const setModal = el('settings-modal');
const uaList = el('ua-list');
const uaCustom = el('ua-custom') as HTMLInputElement;
const uaCurrent = el('ua-current');
const uaError = el('ua-error');
const apTimeout = el('ap-timeout') as HTMLInputElement;
const apTimeoutVal = el('ap-timeout-val');
const tabControl = el('tab-control') as HTMLInputElement;
const agMcpUrl = el('ag-mcpurl') as HTMLInputElement;
const agToken = el('ag-token') as HTMLInputElement;
const agReveal = el('ag-reveal') as HTMLButtonElement;
const agStatus = el('ag-status');
const agPort = el('ag-port') as HTMLInputElement;
const agLan = el('ag-lan') as HTMLInputElement;
const agLanRow = el('ag-lan-row');
const agLanUrl = el('ag-lanurl') as HTMLInputElement;
let settingsState: SettingsState = {
  userAgent: '',
  defaultUserAgent: '',
  approvalTimeoutMs: 120000,
  agentTabControl: true,
};
let agentEndpoint: AgentEndpoint = { url: '', mcpUrl: '', port: 0, token: '', lan: false, lanUrl: '' };
let tokenRevealed = false;

/** Which preset (if any) the current override matches; '' override → the default preset. */
function selectedPresetId(): string {
  const ua = settingsState.userAgent;
  if (!ua) return 'default';
  const hit = UA_PRESETS.find((p) => p.ua && p.ua === ua);
  return hit ? hit.id : 'custom';
}

function renderSettings(): void {
  uaError.textContent = '';
  const sel = selectedPresetId();
  uaList.replaceChildren();
  for (const p of UA_PRESETS) {
    const row = document.createElement('label');
    row.className = 'ua-opt';
    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = 'ua-preset';
    radio.value = p.id;
    radio.checked = sel === p.id;
    radio.addEventListener('change', () => {
      uaCustom.disabled = true;
      void applyUserAgentChoice(p.ua);
    });
    const text = document.createElement('span');
    text.className = 'ua-opt-label';
    text.textContent = p.label;
    row.append(radio, text);
    if (p.id === 'default' && settingsState.defaultUserAgent) {
      const hint = document.createElement('span');
      hint.className = 'ua-opt-hint';
      hint.textContent = settingsState.defaultUserAgent;
      hint.title = settingsState.defaultUserAgent;
      row.appendChild(hint);
    }
    uaList.appendChild(row);
  }
  // Custom row
  const customRow = document.createElement('label');
  customRow.className = 'ua-opt';
  const customRadio = document.createElement('input');
  customRadio.type = 'radio';
  customRadio.name = 'ua-preset';
  customRadio.value = 'custom';
  customRadio.checked = sel === 'custom';
  customRadio.addEventListener('change', () => {
    uaCustom.disabled = false;
    uaCustom.focus();
  });
  const customLabel = document.createElement('span');
  customLabel.className = 'ua-opt-label';
  customLabel.textContent = 'Custom';
  customRow.append(customRadio, customLabel);
  uaList.appendChild(customRow);

  uaCustom.disabled = sel !== 'custom';
  uaCustom.value = sel === 'custom' ? settingsState.userAgent : '';
  uaCurrent.textContent = settingsState.userAgent || `${settingsState.defaultUserAgent} (default)`;

  const secs = Math.round(settingsState.approvalTimeoutMs / 1000);
  apTimeout.value = String(secs);
  apTimeoutVal.textContent = `${secs}s`;
  tabControl.checked = settingsState.agentTabControl;
}

function maskedToken(): string {
  const t = agentEndpoint.token;
  if (!t) return '—';
  return tokenRevealed ? t : `${t.slice(0, 6)}${'•'.repeat(20)}${t.slice(-4)}`;
}

function renderAgent(): void {
  agMcpUrl.value = agentEndpoint.mcpUrl;
  agToken.value = maskedToken();
  agReveal.textContent = tokenRevealed ? 'Hide' : 'Reveal';
  agPort.value = String(agentEndpoint.port || '');
  agLan.checked = agentEndpoint.lan;
  // Show the LAN URL row only when LAN access is on; '' means bound wide but no routable LAN IP.
  agLanRow.style.display = agentEndpoint.lan ? '' : 'none';
  agLanUrl.value = agentEndpoint.lanUrl || '(no LAN address found)';
}

/** The one-line command a user pastes to connect Claude Code. */
function mcpAddCommand(): string {
  return `claude mcp add --transport http safecobrowser ${agentEndpoint.mcpUrl} --header "Authorization: Bearer ${agentEndpoint.token}"`;
}

async function applyUserAgentChoice(ua: string): Promise<void> {
  uaError.textContent = '';
  const r = await jt.setUserAgent(ua);
  settingsState = { ...settingsState, userAgent: r.userAgent, defaultUserAgent: r.defaultUserAgent };
  renderSettings();
}

function applyCustomUa(): void {
  const ua = uaCustom.value.trim();
  if (!ua) {
    uaError.textContent = 'Enter a User-Agent string, or pick Default.';
    uaCustom.focus();
    return;
  }
  void applyUserAgentChoice(ua);
}

function openSettings(): void {
  setModal.classList.add('show');
  void jt.setModalOpen(true);
  agStatus.textContent = '';
  tokenRevealed = false;
  void jt.getSettings().then((s) => {
    settingsState = s;
    renderSettings();
  });
  void jt.getAgentEndpoint().then((ep) => {
    agentEndpoint = ep;
    renderAgent();
  });
  void refreshHistoryCount();
}

const historyCountEl = el('history-count');
const historyClearBtn = el('history-clear') as HTMLButtonElement;
let historyClearArmed = false;
let historyClearTimer: number | undefined;

// Two-click arm (matches container/recipe delete): first click asks to confirm, second click clears.
function resetHistoryClear(): void {
  historyClearArmed = false;
  historyClearBtn.textContent = 'Clear history';
  historyClearBtn.classList.remove('danger');
  window.clearTimeout(historyClearTimer);
}
async function refreshHistoryCount(): Promise<void> {
  historyCountEl.textContent = String(await jt.historyCount());
  resetHistoryClear(); // re-opening Settings always starts disarmed
}
historyClearBtn.addEventListener('click', () => {
  if (!historyClearArmed) {
    historyClearArmed = true;
    historyClearBtn.textContent = 'Confirm clear?';
    historyClearBtn.classList.add('danger');
    historyClearTimer = window.setTimeout(resetHistoryClear, 4000); // auto-disarm if ignored
    return;
  }
  void jt.clearHistory().then((n) => {
    historyCountEl.textContent = String(n);
    resetHistoryClear();
  });
});
function closeSettings(): void {
  setModal.classList.remove('show');
  void jt.setModalOpen(false);
}

async function copyToClipboard(text: string, note: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    agStatus.textContent = note;
  } catch {
    agStatus.textContent = 'Copy failed — select the field and copy manually.';
  }
}

el('settings-btn').addEventListener('click', openSettings);
el('ua-apply').addEventListener('click', applyCustomUa);
el('ua-reset').addEventListener('click', () => void applyUserAgentChoice(''));
el('set-close').addEventListener('click', closeSettings);
uaCustom.addEventListener('keydown', (e: KeyboardEvent) => {
  if (e.key === 'Enter') applyCustomUa();
});

// Approval timeout — live as the slider moves; persisted on release.
apTimeout.addEventListener('input', () => {
  apTimeoutVal.textContent = `${apTimeout.value}s`;
});
apTimeout.addEventListener('change', () => {
  const ms = Math.round(Number(apTimeout.value) * 1000);
  void jt.setApprovalTimeout(ms).then((r) => {
    settingsState = { ...settingsState, approvalTimeoutMs: r.approvalTimeoutMs };
    renderSettings();
  });
});

// Agent tab control — whether the agent may list/switch tabs (default on).
tabControl.addEventListener('change', () => {
  void jt.setTabControl(tabControl.checked).then((r) => {
    settingsState = { ...settingsState, agentTabControl: r.agentTabControl };
    renderSettings();
  });
});

// Agent connection.
agReveal.addEventListener('click', () => {
  tokenRevealed = !tokenRevealed;
  renderAgent();
});
el('ag-copy-url').addEventListener('click', () => void copyToClipboard(agentEndpoint.mcpUrl, 'Endpoint URL copied.'));
el('ag-copy-cmd').addEventListener('click', () => void copyToClipboard(mcpAddCommand(), 'Connect command copied — paste it in your terminal.'));
el('ag-regen').addEventListener('click', () => {
  agStatus.textContent = 'Regenerating…';
  void jt.regenerateAgentToken().then((ep) => {
    agentEndpoint = ep;
    tokenRevealed = false;
    renderAgent();
    agStatus.textContent = 'New token issued — any connected agent must reconnect.';
  });
});
agLan.addEventListener('change', () => {
  const on = agLan.checked;
  agLan.disabled = true;
  agStatus.textContent = on ? 'Opening LAN access…' : 'Closing LAN access…';
  void jt.setAgentLan(on).then((ep) => {
    agLan.disabled = false;
    agentEndpoint = { ...agentEndpoint, ...ep };
    renderAgent();
    if (!ep.ok) {
      agStatus.textContent = ep.error ?? 'Could not change LAN access.';
    } else if (ep.lan) {
      agStatus.textContent = ep.lanUrl
        ? `LAN access on — remote PCs can connect at ${ep.lanUrl}. Plaintext: trusted networks only.`
        : 'LAN access on, but no LAN address was found on this machine.';
    } else {
      agStatus.textContent = 'LAN access off — loopback only.';
    }
  });
});
el('ag-copy-lanurl').addEventListener('click', () =>
  void copyToClipboard(agentEndpoint.lanUrl, 'LAN endpoint URL copied.'),
);
el('ag-port-apply').addEventListener('click', () => {
  const port = Math.round(Number(agPort.value));
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    agStatus.textContent = 'Enter a port between 1 and 65535.';
    return;
  }
  agStatus.textContent = 'Switching port…';
  void jt.setAgentPort(port).then((ep) => {
    agentEndpoint = { url: ep.url, mcpUrl: ep.mcpUrl, port: ep.port, token: ep.token, lan: ep.lan, lanUrl: ep.lanUrl };
    renderAgent();
    agStatus.textContent = ep.ok ? `Now listening on port ${ep.port}.` : (ep.error ?? 'Port change failed.');
  });
});

// Feedback box.
const fbMessage = el('fb-message') as HTMLTextAreaElement;
const fbEmail = el('fb-email') as HTMLInputElement;
const fbSend = el('fb-send') as HTMLButtonElement;
const fbStatus = el('fb-status');
fbSend.addEventListener('click', () => {
  const message = fbMessage.value.trim();
  if (message.length < 2) {
    fbStatus.textContent = 'Please enter your feedback first.';
    fbMessage.focus();
    return;
  }
  const email = fbEmail.value.trim() || undefined;
  fbSend.disabled = true;
  fbStatus.textContent = 'Sending…';
  void jt.sendFeedback(message, email).then((r) => {
    fbSend.disabled = false;
    if (r.ok) {
      fbMessage.value = '';
      fbEmail.value = '';
      fbStatus.textContent = 'Thanks — your feedback was sent.';
    } else {
      fbStatus.textContent = r.error ? `Could not send: ${r.error}` : 'Could not send — try again.';
    }
  });
});

setModal.addEventListener('mousedown', (e) => {
  if (e.target === setModal) closeSettings();
});

// --- tab strip ---
const tabstrip = el('tabstrip');
const tabNew = el('tab-new');
let activeTabId = '';

function renderTabs(state: TabState): void {
  activeTabId = state.activeId;
  latestTabs = state.tabs;
  renderManager(); // tab counts may have changed
  tabstrip.replaceChildren();
  for (const t of state.tabs) {
    const chip = document.createElement('div');
    chip.className = t.id === state.activeId ? 'tab active' : 'tab';
    chip.title = `${redactDisplay(t.title)} — container: ${t.containerName}`;
    chip.addEventListener('click', () => void jt.switchTab(t.id));

    const label = document.createElement('span');
    label.className = 'tab-label';
    label.textContent = redactDisplay(t.title || 'New Tab');
    chip.appendChild(label);

    // Show the container badge only for non-default containers.
    if (t.containerId !== 'default') {
      const badge = document.createElement('span');
      badge.className = 'tab-badge';
      badge.textContent = t.containerName;
      chip.appendChild(badge);
    }

    const close = document.createElement('button');
    close.className = 'tab-close';
    close.textContent = '×';
    close.title = 'Close tab';
    close.addEventListener('click', (e) => {
      e.stopPropagation();
      void jt.closeTab(t.id);
    });
    chip.appendChild(close);

    tabstrip.appendChild(chip);
  }
}

tabNew.addEventListener('click', () => void jt.newTab());
jt.onTabState((s) => renderTabs(s));
void jt.listTabs().then((s) => renderTabs(s));

// --- activity log panel ---
const activityBtn = el('activity-btn');
const activityPanel = el('activity');
const activityList = el('activity-list');
const filtTab = el('act-filter-tab');
const filtAll = el('act-filter-all');
let activityShown = false;
let activityFilter: 'tab' | 'all' = 'tab';

function fmtTime(ts: number): string {
  return new Date(ts).toTimeString().slice(0, 8);
}
function outcomeIcon(o: string): string {
  return o === 'allowed' ? '✓' : o === 'error' ? '⚠' : '✗';
}
function matchesFilter(rec: AuditRecord): boolean {
  return activityFilter === 'all' || rec.tabId === activeTabId;
}

function makeRow(rec: AuditRecord): HTMLElement {
  const row = document.createElement('div');
  row.className = `act-row ${rec.outcome}`;
  const time = document.createElement('span');
  time.className = 'act-time';
  time.textContent = fmtTime(rec.ts);
  const out = document.createElement('span');
  out.className = 'act-out';
  out.textContent = outcomeIcon(rec.outcome);
  const tool = document.createElement('span');
  tool.className = 'act-tool';
  tool.textContent = rec.toolName;
  const meta = document.createElement('span');
  meta.className = 'act-meta';
  const bits = [`[${rec.mode}]`];
  if (rec.reason) bits.push(rec.reason);
  if (rec.detail) bits.push(`— ${redactDisplay(rec.detail.slice(0, 80))}`);
  meta.textContent = bits.join(' ');
  row.append(time, out, tool, meta);
  return row;
}

function renderActivity(records: AuditRecord[]): void {
  activityList.replaceChildren();
  const filtered = records.filter(matchesFilter);
  if (filtered.length === 0) {
    const empty = document.createElement('div');
    empty.id = 'activity-empty';
    empty.textContent = activityFilter === 'tab' ? 'No AI actions on this tab yet.' : 'No AI actions yet.';
    activityList.appendChild(empty);
    return;
  }
  for (const rec of filtered.slice().reverse()) activityList.appendChild(makeRow(rec)); // newest first
}

async function refreshActivity(): Promise<void> {
  renderActivity(await jt.getRecentAudit());
}

function setActivity(open: boolean): void {
  activityShown = open;
  activityPanel.classList.toggle('show', open);
  void jt.setActivityOpen(open);
  if (open) void refreshActivity();
}

activityBtn.addEventListener('click', () => setActivity(!activityShown));
el('activity-close').addEventListener('click', () => setActivity(false));
filtTab.addEventListener('click', () => {
  activityFilter = 'tab';
  filtTab.classList.add('active');
  filtAll.classList.remove('active');
  void refreshActivity();
});
filtAll.addEventListener('click', () => {
  activityFilter = 'all';
  filtAll.classList.add('active');
  filtTab.classList.remove('active');
  void refreshActivity();
});

jt.onAuditEvent((rec) => {
  if (!activityShown || !matchesFilter(rec)) return;
  document.getElementById('activity-empty')?.remove();
  activityList.insertBefore(makeRow(rec), activityList.firstChild);
});

// When the active tab changes while the panel is open and filtered to "this tab", refresh.
jt.onTabState(() => {
  if (activityShown && activityFilter === 'tab') void refreshActivity();
});

// --- per-tab auto-approve toggles ---
const autoActionsBtn = el('auto-actions');
const autoRunjsBtn = el('auto-runjs');
let autoState = { actions: false, runjs: false };

function renderAuto(s: { actions: boolean; runjs: boolean }): void {
  autoState = s;
  autoActionsBtn.classList.toggle('on', s.actions);
  autoRunjsBtn.classList.toggle('on', s.runjs);
}

autoActionsBtn.addEventListener('click', () => void jt.setAutoApprove({ actions: !autoState.actions }));
autoRunjsBtn.addEventListener('click', () => void jt.setAutoApprove({ runjs: !autoState.runjs }));
jt.onAutoApproveState((s) => renderAuto(s));
void jt.getAutoApprove().then((s) => renderAuto(s));

// --- per-tab real input toggle ---
const realInputBtn = el('real-input');
let realInputOn = false;

function renderRealInput(on: boolean): void {
  realInputOn = on;
  realInputBtn.classList.toggle('on', on);
}

realInputBtn.addEventListener('click', () => void jt.setRealInput(!realInputOn));
jt.onRealInputState((on) => renderRealInput(on));
void jt.getRealInput().then((on) => renderRealInput(on));
