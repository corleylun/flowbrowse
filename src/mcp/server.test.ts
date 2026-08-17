import test from 'node:test';
import assert from 'node:assert/strict';
import { toMcpContent } from './server';

test('image-shaped output becomes a viewable MCP image block (not a base64 text blob)', () => {
  const out = toMcpContent({ mimeType: 'image/png', base64: 'iVBORw0KGgo=' });
  assert.deepEqual(out, [{ type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' }]);
});

test('empty capture (hidden tab) returns the honest note as text, never a blank image', () => {
  const out = toMcpContent({ mimeType: 'image/png', base64: '', note: 'tab not visible' });
  assert.deepEqual(out, [{ type: 'text', text: 'tab not visible' }]);
});

test('empty capture without a note falls back to a generic text note', () => {
  const out = toMcpContent({ mimeType: 'image/png', base64: '' });
  assert.deepEqual(out, [{ type: 'text', text: 'empty capture' }]);
});

test('string output passes through verbatim as text', () => {
  assert.deepEqual(toMcpContent('hello world'), [{ type: 'text', text: 'hello world' }]);
});

test('object output is JSON-stringified as text (non-image objects unchanged)', () => {
  const out = toMcpContent({ matched: true, x: 12, y: 34 });
  assert.deepEqual(out, [{ type: 'text', text: '{"matched":true,"x":12,"y":34}' }]);
});

test('a partial image shape (non-string base64) is treated as a plain object, not an image', () => {
  const out = toMcpContent({ mimeType: 'image/png', base64: 123 });
  assert.deepEqual(out, [{ type: 'text', text: '{"mimeType":"image/png","base64":123}' }]);
});

test("undefined output yields an empty text block, never a non-string text", () => {
  assert.deepEqual(toMcpContent(undefined), [{ type: "text", text: "" }]);
});
