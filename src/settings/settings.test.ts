import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  SettingsStore,
  sanitizeUserAgent,
  sanitizeApprovalTimeout,
  sanitizePort,
  sanitizeLanAccess,
  DEFAULT_APPROVAL_TIMEOUT_MS,
  DEFAULT_MCP_PORT,
} from './settings';

function tmpFile(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'scb-settings-')), 'settings.json');
}

test('sanitizeUserAgent: trims, strips CR/LF + control chars, caps length', () => {
  assert.equal(sanitizeUserAgent('  Mozilla/5.0  '), 'Mozilla/5.0');
  assert.equal(sanitizeUserAgent('UA\r\nHost: evil'), 'UA Host: evil', 'newlines collapse to a space (no header smuggling)');
  assert.equal(sanitizeUserAgent('a\x00b\x07c'), 'abc');
  assert.equal(sanitizeUserAgent(123 as unknown), '');
  assert.equal(sanitizeUserAgent(undefined), '');
  assert.equal(sanitizeUserAgent('x'.repeat(1000)).length, 512);
});

test('sanitizeApprovalTimeout: clamps to [5s, 600s], defaults on garbage', () => {
  assert.equal(sanitizeApprovalTimeout(30_000), 30_000);
  assert.equal(sanitizeApprovalTimeout(1_000), 5_000, 'floor');
  assert.equal(sanitizeApprovalTimeout(999_999), 600_000, 'ceil');
  assert.equal(sanitizeApprovalTimeout('nope' as unknown), DEFAULT_APPROVAL_TIMEOUT_MS);
  assert.equal(sanitizeApprovalTimeout(NaN), DEFAULT_APPROVAL_TIMEOUT_MS);
});

test('sanitizePort: accepts valid ports, defaults otherwise', () => {
  assert.equal(sanitizePort(9000), 9000);
  assert.equal(sanitizePort(1), 1);
  assert.equal(sanitizePort(65535), 65535);
  assert.equal(sanitizePort(0), DEFAULT_MCP_PORT);
  assert.equal(sanitizePort(70000), DEFAULT_MCP_PORT);
  assert.equal(sanitizePort(80.5), DEFAULT_MCP_PORT, 'non-integer');
  assert.equal(sanitizePort('8676' as unknown), DEFAULT_MCP_PORT);
});

test('sanitizeLanAccess: only a real boolean passes; garbage/absent → false (fail-closed)', () => {
  assert.equal(sanitizeLanAccess(true), true);
  assert.equal(sanitizeLanAccess(false), false);
  assert.equal(sanitizeLanAccess('true' as unknown), false, 'a truthy string must not open LAN');
  assert.equal(sanitizeLanAccess(1 as unknown), false);
  assert.equal(sanitizeLanAccess(undefined), false);
});

test('SettingsStore: defaults when no file', () => {
  const s = new SettingsStore(tmpFile());
  assert.equal(s.getUserAgent(), '');
  assert.equal(s.getApprovalTimeoutMs(), DEFAULT_APPROVAL_TIMEOUT_MS);
  assert.equal(s.getMcpPort(), DEFAULT_MCP_PORT);
  assert.equal(s.getLanAccess(), false, 'LAN access is off by default');
});

test('SettingsStore: LAN access persists across instances', () => {
  const file = tmpFile();
  const s = new SettingsStore(file);
  s.setLanAccess(true);
  assert.equal(new SettingsStore(file).getLanAccess(), true);
  s.setLanAccess(false);
  assert.equal(new SettingsStore(file).getLanAccess(), false);
});

test('SettingsStore: approval timeout + port persist across instances (sanitised)', () => {
  const file = tmpFile();
  const s = new SettingsStore(file);
  s.setApprovalTimeoutMs(45_000);
  s.setMcpPort(9100);
  s.setApprovalTimeoutMs(1); // below floor → clamps
  const reloaded = new SettingsStore(file);
  assert.equal(reloaded.getApprovalTimeoutMs(), 5_000);
  assert.equal(reloaded.getMcpPort(), 9100);
});

test('SettingsStore: set + persist across instances', () => {
  const file = tmpFile();
  const s = new SettingsStore(file);
  s.setUserAgent('  CustomAgent/1.0\n ');
  assert.equal(s.getUserAgent(), 'CustomAgent/1.0', 'sanitised on set');

  const reloaded = new SettingsStore(file);
  assert.equal(reloaded.getUserAgent(), 'CustomAgent/1.0', 'persisted to disk');
});

test('SettingsStore: setting empty clears the override', () => {
  const file = tmpFile();
  const s = new SettingsStore(file);
  s.setUserAgent('CustomAgent/1.0');
  s.setUserAgent('   ');
  assert.equal(s.getUserAgent(), '');
  assert.equal(new SettingsStore(file).getUserAgent(), '');
});

test('SettingsStore: malformed file falls back to empty', () => {
  const file = tmpFile();
  fs.writeFileSync(file, 'not json');
  assert.equal(new SettingsStore(file).getUserAgent(), '');
});
