import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCoordinateTools, CoordinateController, CoordPreviewer, CoordResult, ALLOWED_KEYS } from './coordinate';
import { Mode } from '../core/modes';
import { RiskLevel } from '../core/tool';

const okResult: CoordResult = { done: true, realInput: true };
const ctrl: CoordinateController = {
  moveTo: async () => okResult,
  clickAt: async () => okResult,
  scrollAt: async () => okResult,
  pressKey: async () => okResult,
  typeText: async () => okResult,
};
const previewer: CoordPreviewer = { previewAt: async () => ({ image: 'x', w: 10, h: 10 }) };

const tools = createCoordinateTools(ctrl, previewer);
const byName = Object.fromEntries(tools.map((t) => [t.name, t]));

test('registers the five computer-use tools, all Act-tier + approval-required', () => {
  assert.deepEqual(
    tools.map((t) => t.name).sort(),
    ['click_at', 'move_to', 'press_key', 'scroll', 'type_text'],
  );
  for (const t of tools) {
    assert.equal(t.minMode, Mode.Act, `${t.name} minMode`);
    assert.equal(t.risk, RiskLevel.Medium, `${t.name} risk`);
    assert.equal(t.requiresApproval, true, `${t.name} approval`);
    assert.equal(typeof t.preview, 'function', `${t.name} has a preview hook`);
  }
});

test('click_at schema: coords + optional button', () => {
  assert.deepEqual(byName.click_at.inputSchema.parse({ x: 12, y: 34 }), { x: 12, y: 34, button: 'left' });
  assert.deepEqual(byName.click_at.inputSchema.parse({ x: 1, y: 2, button: 'right' }), { x: 1, y: 2, button: 'right' });
  assert.throws(() => byName.click_at.inputSchema.parse({ x: 1, y: 2, button: 'middle' }), /left.*right/);
  assert.throws(() => byName.click_at.inputSchema.parse({ x: -1, y: 2 }), /out of range/);
  assert.throws(() => byName.click_at.inputSchema.parse({ x: 'a', y: 2 }), /finite number/);
  assert.throws(() => byName.click_at.inputSchema.parse({ y: 2 }), /finite number/);
});

test('scroll schema: dy required, dx optional default 0', () => {
  assert.deepEqual(byName.scroll.inputSchema.parse({ x: 5, y: 6, dy: 100 }), { x: 5, y: 6, dy: 100, dx: 0 });
  assert.throws(() => byName.scroll.inputSchema.parse({ x: 5, y: 6 }), /dy must be/);
});

test('press_key schema: allowlist only — no modifier chords or F-keys', () => {
  assert.deepEqual(byName.press_key.inputSchema.parse({ key: 'Enter' }), { key: 'Enter' });
  assert.deepEqual(byName.press_key.inputSchema.parse({ key: 'ArrowDown' }), { key: 'ArrowDown' });
  for (const bad of ['a', 'Cmd+W', 'Control+A', 'F12', 'Meta', 'Tab+Shift', '']) {
    assert.throws(() => byName.press_key.inputSchema.parse({ key: bad }), /key must be one of/, `rejects ${bad}`);
  }
  assert.ok(!ALLOWED_KEYS.has('F12') && !ALLOWED_KEYS.has('Meta'));
});

test('type_text schema: non-empty, capped', () => {
  assert.deepEqual(byName.type_text.inputSchema.parse({ text: 'hi' }), { text: 'hi' });
  assert.throws(() => byName.type_text.inputSchema.parse({ text: '' }), /not be empty/);
  assert.throws(() => byName.type_text.inputSchema.parse({ text: 'x'.repeat(10_001) }), /too large/);
});

test('audit detail: coordinates shown; type_text value HIDDEN', () => {
  assert.equal(byName.click_at.auditDetail!({ x: 412, y: 308, button: 'left' }), 'left (412, 308)');
  assert.equal(byName.move_to.auditDetail!({ x: 1, y: 2 }), '(1, 2)');
  assert.equal(byName.scroll.auditDetail!({ x: 1, y: 2, dy: 50, dx: 0 }), '(1, 2) dy=50 dx=0');
  assert.equal(byName.press_key.auditDetail!({ key: 'Enter' }), 'Enter');
  // never the text — only a character count
  assert.equal(byName.type_text.auditDetail!({ text: 'hunter2 secret' }), '14 chars (value hidden)');
});

test('auditResult tags real input when the action ran', () => {
  assert.equal(byName.click_at.auditResult!({ done: true, realInput: true }), 'real input');
  assert.equal(byName.click_at.auditResult!({ done: false }), undefined);
});
