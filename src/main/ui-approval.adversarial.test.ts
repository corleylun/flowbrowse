import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import Module from 'node:module';

// ui-approval.ts imports `electron` (ipcMain, WebContents). Under `node --test` the
// real `electron` require resolves to a path string, not the API — so we stub it in
// the CJS cache BEFORE loading the compiled module, then exercise the real settle /
// timeout / double-settle logic against a fake chrome WebContents + ipc bus.

interface FakeIpc {
  handlers: Map<string, (...a: unknown[]) => void>;
  handle(ch: string, cb: (...a: unknown[]) => void): void;
  invoke(ch: string, payload: unknown): void;
}
function makeIpc(): FakeIpc {
  const handlers = new Map<string, (...a: unknown[]) => void>();
  return {
    handlers,
    handle(ch, cb) {
      handlers.set(ch, cb);
    },
    invoke(ch, payload) {
      handlers.get(ch)?.({}, payload);
    },
  };
}

function makeChrome() {
  const sent: Array<{ ch: string; payload: unknown }> = [];
  return {
    destroyed: false,
    sent,
    isDestroyed() {
      return this.destroyed;
    },
    send(ch: string, payload: unknown) {
      sent.push({ ch, payload });
    },
  };
}

// Load the compiled UiApprovalProvider with a stubbed `electron`.
function loadProvider(ipc: FakeIpc) {
  const req = createRequire(__filename);
  // Resolve the real path the compiled test would use, then stub `electron`.
  const electronStub = { ipcMain: ipc, __esModule: true };
  // Patch Module._load so any `require('electron')` returns our stub.
  const ModuleAny = Module as unknown as {
    _load: (request: string, parent: unknown, isMain: boolean) => unknown;
  };
  const orig = ModuleAny._load;
  ModuleAny._load = function (request: string, parent: unknown, isMain: boolean) {
    if (request === 'electron') return electronStub;
    return orig.call(this, request, parent, isMain);
  };
  try {
    // dist/main/ui-approval.js relative to dist/main/ (this test compiles to dist/main/).
    const mod = req('./ui-approval.js') as {
      UiApprovalProvider: new (
        chrome: () => unknown,
        onPendingChange?: (p: boolean) => void,
        timeoutMs?: number,
        autoApprove?: (req: unknown) => boolean,
        activeTabId?: () => string,
        tabTitle?: (tabId: string) => string,
      ) => { request: (req: unknown) => Promise<{ approved: boolean; available?: boolean }> };
    };
    return mod.UiApprovalProvider;
  } finally {
    ModuleAny._load = orig;
  }
}

const ipc = makeIpc();
const UiApprovalProvider = loadProvider(ipc);

const baseReq = {
  tabId: 'm',
  epoch: 1,
  toolName: 'click',
  risk: 'medium',
  summary: 'do thing',
  input: { selector: '#x' },
};

test('UIAPPROVAL: no chrome -> available:false (fail closed)', async () => {
  const p = new UiApprovalProvider(() => null);
  const d = await p.request(baseReq);
  assert.equal(d.approved, false);
  assert.equal(d.available, false);
});

test('UIAPPROVAL: a normal approve resolves once and closes the card', async () => {
  const chrome = makeChrome();
  const p = new UiApprovalProvider(() => chrome);
  const pending = p.request(baseReq);
  // The request was sent to the UI with an id.
  const sent = chrome.sent.find((s) => s.ch === 'ai:approval-request')!;
  const id = (sent.payload as { id: number }).id;
  ipc.invoke('ai:approval-response', { id, approved: true });
  const d = await pending;
  assert.equal(d.approved, true);
  assert.equal(d.available, true);
  assert.ok(chrome.sent.some((s) => s.ch === 'ai:approval-close'));
});

test('UIAPPROVAL: a LATE response after auto-reject does not double-settle', async () => {
  const chrome = makeChrome();
  // Tiny timeout so it auto-rejects fast.
  const p = new UiApprovalProvider(() => chrome, undefined, 10);
  const pending = p.request(baseReq);
  const id = (chrome.sent.find((s) => s.ch === 'ai:approval-request')!.payload as { id: number }).id;
  const d = await pending; // resolves via timeout
  assert.equal(d.approved, false, 'auto-rejected by timeout');
  assert.equal(d.available, true);
  // Now the user clicks Approve LATE; this must be a no-op (no throw, no change).
  ipc.invoke('ai:approval-response', { id, approved: true });
  // Settling again would have re-sent a close or thrown; assert exactly one close for this id.
  const closesForId = chrome.sent.filter(
    (s) => s.ch === 'ai:approval-close' && (s.payload as { id: number }).id === id,
  );
  assert.equal(closesForId.length, 1, 'card closed exactly once; late response ignored');
});

test('UIAPPROVAL: a duplicate response for the same id settles only once', async () => {
  const chrome = makeChrome();
  const p = new UiApprovalProvider(() => chrome);
  const pending = p.request(baseReq);
  const id = (chrome.sent.find((s) => s.ch === 'ai:approval-request')!.payload as { id: number }).id;
  ipc.invoke('ai:approval-response', { id, approved: true });
  ipc.invoke('ai:approval-response', { id, approved: false }); // duplicate / conflicting
  const d = await pending;
  assert.equal(d.approved, true, 'first decision wins; duplicate ignored');
});

test('UIAPPROVAL: concurrent cards are independent (id-routed)', async () => {
  const chrome = makeChrome();
  const events: boolean[] = [];
  const p = new UiApprovalProvider(() => chrome, (pendingNow) => events.push(pendingNow));
  const p1 = p.request({ ...baseReq, toolName: 'click' });
  const p2 = p.request({ ...baseReq, toolName: 'fill' });
  const reqs = chrome.sent.filter((s) => s.ch === 'ai:approval-request');
  const id1 = (reqs[0].payload as { id: number }).id;
  const id2 = (reqs[1].payload as { id: number }).id;
  assert.notEqual(id1, id2, 'distinct ids');
  // Resolve the SECOND first; the first must remain pending.
  ipc.invoke('ai:approval-response', { id: id2, approved: false });
  ipc.invoke('ai:approval-response', { id: id1, approved: true });
  const [d1, d2] = await Promise.all([p1, p2]);
  assert.equal(d1.approved, true);
  assert.equal(d2.approved, false);
  // onPendingChange: true when first opened, false only when the LAST closed.
  assert.equal(events[0], true, 'first card => pending true');
  assert.equal(events.at(-1), false, 'last card closed => pending false');
});

test('UIAPPROVAL: a response for an UNKNOWN id is harmless', async () => {
  const chrome = makeChrome();
  const p = new UiApprovalProvider(() => chrome);
  const pending = p.request(baseReq);
  const id = (chrome.sent.find((s) => s.ch === 'ai:approval-request')!.payload as { id: number }).id;
  ipc.invoke('ai:approval-response', { id: id + 99999, approved: true }); // stale/unknown
  // Real response still works.
  ipc.invoke('ai:approval-response', { id, approved: true });
  const d = await pending;
  assert.equal(d.approved, true);
});

test('UIAPPROVAL: a non-true approved field is coerced to a rejection (fail closed)', async () => {
  const chrome = makeChrome();
  const p = new UiApprovalProvider(() => chrome);
  const pending = p.request(baseReq);
  const id = (chrome.sent.find((s) => s.ch === 'ai:approval-request')!.payload as { id: number }).id;
  // A malformed/spoofed payload where approved is truthy-but-not-true.
  ipc.invoke('ai:approval-response', { id, approved: 'yes' as unknown as boolean });
  const d = await pending;
  assert.equal(d.approved, false, 'only strict boolean true approves');
});

test('UIAPPROVAL: a background-tab call is labeled "targetTab" on the card', async () => {
  const chrome = makeChrome();
  const p = new UiApprovalProvider(
    () => chrome,
    undefined,
    undefined,
    undefined,
    () => 'main', // active tab
    (tabId) => `title-of-${tabId}`,
  );
  const pending = p.request({ ...baseReq, tabId: 'bg' }); // targets a DIFFERENT tab than active
  const id = (chrome.sent.find((s) => s.ch === 'ai:approval-request')!.payload as { id: number }).id;
  ipc.invoke('ai:approval-response', { id, approved: true });
  await pending;
  const sent = chrome.sent.find((s) => s.ch === 'ai:approval-request')!;
  assert.equal((sent.payload as { targetTab?: string }).targetTab, 'title-of-bg');
});

test('UIAPPROVAL: an active-tab call carries NO targetTab label', async () => {
  const chrome = makeChrome();
  const p = new UiApprovalProvider(
    () => chrome,
    undefined,
    undefined,
    undefined,
    () => 'm', // matches baseReq.tabId
    (tabId) => `title-of-${tabId}`,
  );
  const pending = p.request(baseReq); // baseReq.tabId === 'm' === active
  const id = (chrome.sent.find((s) => s.ch === 'ai:approval-request')!.payload as { id: number }).id;
  ipc.invoke('ai:approval-response', { id, approved: true });
  await pending;
  const sent = chrome.sent.find((s) => s.ch === 'ai:approval-request')!;
  assert.equal((sent.payload as { targetTab?: string }).targetTab, undefined);
});

test('UIAPPROVAL: no activeTabId/tabTitle hooks -> never labeled (backward compatible)', async () => {
  const chrome = makeChrome();
  const p = new UiApprovalProvider(() => chrome); // old-style construction, no new hooks
  const pending = p.request({ ...baseReq, tabId: 'bg' });
  const id = (chrome.sent.find((s) => s.ch === 'ai:approval-request')!.payload as { id: number }).id;
  ipc.invoke('ai:approval-response', { id, approved: true });
  await pending;
  const sent = chrome.sent.find((s) => s.ch === 'ai:approval-request')!;
  assert.equal((sent.payload as { targetTab?: string }).targetTab, undefined);
});

test('UIAPPROVAL: auto-approve applies on the FOREGROUND tab (no card)', async () => {
  const chrome = makeChrome();
  const p = new UiApprovalProvider(
    () => chrome,
    undefined,
    undefined,
    () => true, // user has auto-approve on for this tab
    () => 'm', // matches baseReq.tabId → foreground call
    (tabId) => `title-of-${tabId}`,
  );
  const d = await p.request(baseReq);
  assert.equal(d.approved, true);
  assert.equal(chrome.sent.length, 0, 'auto-approved without a card');
});

test('UIAPPROVAL: auto-approve is HONORED for a background-tab call (no card)', async () => {
  // Auto-approve is a deliberate per-tab opt-in on top of a mode grant — "I trust this tab,
  // don't ask." We honor it on ANY tab, foreground or background: a background-tab call on an
  // auto-approved tab runs card-less (the record lives in the audit log), per the product owner's
  // decision. It is NOT an escalation — the user set both the mode and the auto-approve.
  const chrome = makeChrome();
  const p = new UiApprovalProvider(
    () => chrome,
    undefined,
    undefined,
    () => true, // auto-approve on for the target tab…
    () => 'main', // …and the foreground is a different tab — no longer matters
    (tabId) => `title-of-${tabId}`,
  );
  const d = await p.request({ ...baseReq, tabId: 'bg' });
  assert.equal(d.approved, true);
  assert.equal(chrome.sent.length, 0, 'auto-approved without a card, even for a background tab');
});

test('UIAPPROVAL: auto-approve does not depend on the activeTabId hook', async () => {
  // Auto-approve is honored whether or not the foreground hook is wired — it keys only on the
  // user's per-tab auto-approve setting, not on which tab is in front.
  const chrome = makeChrome();
  const p = new UiApprovalProvider(() => chrome, undefined, undefined, () => true);
  const d = await p.request(baseReq);
  assert.equal(d.approved, true);
  assert.equal(chrome.sent.length, 0, 'auto-approved without a card (no activeTabId hook needed)');
});
