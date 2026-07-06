import test from 'node:test';
import assert from 'node:assert/strict';
import { replayActions } from './replay';
import { RecordedAction } from './actions';
import { ActController, ClickResult, FillResult, SubmitResult } from '../tools/act';

function fakeAct(): ActController & { clicks: string[]; fills: Array<[string, string]>; submits: string[] } {
  const clicks: string[] = [];
  const fills: Array<[string, string]> = [];
  const submits: string[] = [];
  return {
    clicks,
    fills,
    submits,
    async click(_t, selector): Promise<ClickResult> {
      clicks.push(selector);
      return { clicked: true, matched: selector };
    },
    async fill(_t, selector, value): Promise<FillResult> {
      fills.push([selector, value]);
      return { filled: true, matched: selector };
    },
    async submit(_t, selector): Promise<SubmitResult> {
      submits.push(selector);
      return { submitted: true, matched: selector };
    },
  };
}

const seq: RecordedAction[] = [
  { type: 'click', selector: '#login', label: 'Log in', ts: 1 },
  { type: 'fill', selector: '#email', label: 'Email', value: 'a@b.c', masked: false, ts: 2 },
  { type: 'fill', selector: '#pw', label: 'Password', value: null, masked: true, ts: 3 },
  { type: 'click', selector: '#submit', label: 'Submit', ts: 4 },
];

test('replay performs clicks + non-sensitive fills and SKIPS masked fills', async () => {
  const act = fakeAct();
  const r = await replayActions(seq, { act });
  assert.equal(r.performed, 3); // click, fill email, click submit
  assert.equal(r.skipped, 1); // masked password
  assert.equal(r.failed, 0);
  assert.deepEqual(act.clicks, ['#login', '#submit']);
  assert.deepEqual(act.fills, [['#email', 'a@b.c']]); // password never replayed
  const skipped = r.steps.find((s) => s.status === 'skipped');
  assert.match(String(skipped?.detail), /sensitive/);
});

test('a failing action is recorded but does not abort the rest', async () => {
  const act = fakeAct();
  act.click = async (_t, sel) => {
    if (sel === '#login') throw new Error('not found');
    return { clicked: true, matched: sel };
  };
  const r = await replayActions(seq, { act });
  assert.equal(r.failed, 1);
  assert.equal(act.clicks.includes('#submit') || r.steps.some((s) => s.status === 'done'), true);
});

test('a click/fill whose element is not found is reported as failed (not silently "done")', async () => {
  const act = fakeAct();
  act.click = async (_t, sel) => ({ clicked: sel === '#submit', matched: '' }); // #login misses
  act.fill = async () => ({ filled: false, matched: '' }); // email field misses
  const r = await replayActions(seq, { act });
  assert.equal(r.failed, 2); // #login click + email fill both unmatched
  assert.equal(r.performed, 1); // only #submit clicked
  assert.equal(r.skipped, 1); // masked password
  const failed = r.steps.filter((s) => s.status === 'failed');
  assert.match(String(failed[0].detail), /no element matched/);
});

test('shouldContinue=false stops replay early', async () => {
  const act = fakeAct();
  const r = await replayActions(seq, { act, shouldContinue: () => false });
  assert.equal(r.performed, 0);
  assert.equal(act.clicks.length, 0);
});

test('submit actions press Enter / submit the field', async () => {
  const act = fakeAct();
  const withSubmit: RecordedAction[] = [
    { type: 'fill', selector: '#q', label: 'Search', value: 'askmingli.com', masked: false, ts: 1 },
    { type: 'submit', selector: '#q', label: 'Search', ts: 2 },
  ];
  const r = await replayActions(withSubmit, { act });
  assert.equal(r.performed, 2);
  assert.deepEqual(act.submits, ['#q']);
});

test('a submit whose field is not found is reported as failed', async () => {
  const act = fakeAct();
  act.submit = async () => ({ submitted: false, matched: '' });
  const r = await replayActions([{ type: 'submit', selector: '#gone', label: 'Search', ts: 1 }], { act });
  assert.equal(r.failed, 1);
  assert.equal(r.performed, 0);
});

test('navigate actions use the navigator when provided', async () => {
  const act = fakeAct();
  const navs: string[] = [];
  const withNav: RecordedAction[] = [{ type: 'navigate', url: 'https://x.test', ts: 1 }];
  const r = await replayActions(withNav, { act, navigate: (u) => void navs.push(u) });
  assert.equal(r.performed, 1);
  assert.deepEqual(navs, ['https://x.test']);
});
