import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ContextMenuParams } from 'electron';
import { contextMenuTemplate, chromeContextMenuTemplate, MenuActions } from './context-menu-template';

function spyActions() {
  const calls: Record<string, unknown[]> = {};
  const rec = (k: string) => (...args: unknown[]) => {
    calls[k] = args;
  };
  const a: MenuActions = {
    saveUrl: rec('saveUrl'),
    copyImageAt: rec('copyImageAt'),
    copyText: rec('copyText'),
    openInNewTab: rec('openInNewTab'),
    replaceMisspelling: rec('replaceMisspelling'),
    back: rec('back'),
    forward: rec('forward'),
    reload: rec('reload'),
    canGoBack: true,
    canGoForward: false,
    pageUrl: 'https://example.com/page',
  };
  return { a, calls };
}

function editFlags(over: Partial<ContextMenuParams['editFlags']> = {}): ContextMenuParams['editFlags'] {
  return {
    canUndo: false,
    canRedo: false,
    canCut: false,
    canCopy: false,
    canPaste: false,
    canDelete: false,
    canSelectAll: true,
    canEditRichly: false,
    ...over,
  };
}

function params(over: Partial<ContextMenuParams>): ContextMenuParams {
  return {
    mediaType: 'none',
    srcURL: '',
    linkURL: '',
    x: 0,
    y: 0,
    isEditable: false,
    misspelledWord: '',
    dictionarySuggestions: [],
    selectionText: '',
    editFlags: editFlags(),
    ...over,
  } as unknown as ContextMenuParams;
}

/** Readable tokens for each item: its label, or `@role`, or `---` for a separator. */
function tokens(over: Partial<ContextMenuParams>, a: MenuActions): string[] {
  return contextMenuTemplate(params(over), a).map((i) =>
    i.type === 'separator' ? '---' : (i.label ?? `@${i.role}`),
  );
}

test('plain page → just navigation + page URL', () => {
  const { a } = spyActions();
  assert.deepEqual(tokens({}, a), ['Back', 'Forward', 'Reload', '---', 'Copy Page URL']);
});

test('http image → save/copy/address/open', () => {
  const { a } = spyActions();
  const tk = tokens({ mediaType: 'image', srcURL: 'https://cdn.example.com/cat.png' }, a);
  for (const label of ['Save Image', 'Copy Image', 'Copy Image Address', 'Open Image in New Tab']) {
    assert.ok(tk.includes(label), `missing ${label}`);
  }
});

test('data:/blob: image → no Save Image / Open in New Tab (downloadURL would no-op)', () => {
  const { a } = spyActions();
  const tk = tokens({ mediaType: 'image', srcURL: 'data:image/png;base64,AAAA' }, a);
  assert.ok(tk.includes('Copy Image'), 'Copy Image should still work');
  assert.ok(tk.includes('Copy Image Address'));
  assert.ok(!tk.includes('Save Image'), 'Save Image must be omitted for data: URLs');
  assert.ok(!tk.includes('Open Image in New Tab'), 'Open in New Tab must be omitted for data: URLs');
});

test('http link → open/copy/save', () => {
  const { a } = spyActions();
  const tk = tokens({ linkURL: 'https://example.com/file.pdf' }, a);
  for (const label of ['Open Link in New Tab', 'Copy Link', 'Save Link As']) {
    assert.ok(tk.includes(label), `missing ${label}`);
  }
});

test('non-http link (javascript:) → no Open/Save, only Copy Link', () => {
  const { a } = spyActions();
  const tk = tokens({ linkURL: 'javascript:alert(1)' }, a);
  assert.ok(tk.includes('Copy Link'));
  assert.ok(!tk.includes('Open Link in New Tab'));
  assert.ok(!tk.includes('Save Link As'));
});

test('editable with misspelling → suggestions + clipboard roles', () => {
  const { a } = spyActions();
  const tk = tokens(
    {
      isEditable: true,
      misspelledWord: 'teh',
      dictionarySuggestions: ['the', 'tech'],
      editFlags: editFlags({ canCut: true, canCopy: true, canPaste: true }),
    },
    a,
  );
  assert.ok(tk.includes('the') && tk.includes('tech'), 'suggestions missing');
  for (const role of ['@cut', '@copy', '@paste', '@selectAll']) assert.ok(tk.includes(role), `missing ${role}`);
});

test('selection (non-editable) → Copy role', () => {
  const { a } = spyActions();
  const tk = tokens({ selectionText: 'hello' }, a);
  assert.ok(tk.includes('@copy'));
  assert.ok(!tk.includes('@paste'), 'no paste outside editable');
});

test('click wiring routes to the right actions', () => {
  const { a, calls } = spyActions();
  const t = contextMenuTemplate(
    params({ mediaType: 'image', srcURL: 'https://x.com/a.png', x: 12, y: 34 }),
    a,
  );
  const click = (label: string) => (t.find((i) => i.label === label)!.click as () => void)();
  click('Save Image');
  assert.deepEqual(calls.saveUrl, ['https://x.com/a.png']);
  click('Open Image in New Tab');
  assert.deepEqual(calls.openInNewTab, ['https://x.com/a.png']);
  click('Copy Page URL');
  assert.deepEqual(calls.copyText, ['https://example.com/page']);
});

// --- chrome UI menu (URL bar / Settings / feedback): clipboard + spellcheck only ---

const chromeTokens = (over: Partial<ContextMenuParams>): string[] =>
  chromeContextMenuTemplate(params(over), () => {}).map((i) =>
    i.type === 'separator' ? '---' : (i.label ?? `@${i.role}`),
  );

test('chrome editable → clipboard roles only, no page/nav items', () => {
  const tk = chromeTokens({
    isEditable: true,
    editFlags: editFlags({ canCut: true, canCopy: true, canPaste: true }),
  });
  assert.deepEqual(tk, ['@cut', '@copy', '@paste', '@selectAll']);
  for (const banned of ['Back', 'Forward', 'Reload', 'Copy Page URL', 'Save Image']) {
    assert.ok(!tk.includes(banned), `chrome menu must not include ${banned}`);
  }
});

test('chrome selection → copy only; chrome plain → empty (no menu pops)', () => {
  assert.deepEqual(chromeTokens({ selectionText: 'hi' }), ['@copy']);
  assert.deepEqual(chromeTokens({}), []);
});

test('no leading or doubled separators', () => {
  const { a } = spyActions();
  const tk = tokens({ mediaType: 'image', srcURL: 'https://x.com/a.png', linkURL: 'https://x.com/b' }, a);
  assert.notEqual(tk[0], '---', 'no leading separator');
  for (let i = 1; i < tk.length; i++) {
    assert.ok(!(tk[i] === '---' && tk[i - 1] === '---'), 'no doubled separators');
  }
});
