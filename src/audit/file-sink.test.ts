import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AuditEvent } from '../core/audit';
import { FileAuditSink, verifyAuditFile } from './file-sink';

function tmpFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'safecobrowser-audit-'));
  return path.join(dir, 'audit-log.jsonl');
}

function ev(toolName: string, outcome: AuditEvent['outcome']): AuditEvent {
  return { ts: Date.now(), tabId: 'main', toolName, mode: 'read', epoch: 1, outcome };
}

test('events are persisted and survive a restart (seq continues)', () => {
  const file = tmpFile();
  try {
    const a = new FileAuditSink(file);
    a.record(ev('read_page', 'allowed'));
    a.record(ev('click', 'denied'));
    // A fresh sink reloads the file and continues the sequence.
    const b = new FileAuditSink(file);
    b.record(ev('run_js', 'allowed'));
    const recs = b.recentRecords();
    assert.equal(recs.length, 3);
    assert.deepEqual(
      recs.map((r) => r.seq),
      [1, 2, 3],
    );
    assert.equal(recs[2].event.toolName, 'run_js');
  } finally {
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  }
});

test('the hash chain verifies for an untampered log', () => {
  const file = tmpFile();
  try {
    const a = new FileAuditSink(file);
    for (let i = 0; i < 5; i++) a.record(ev(`tool${i}`, 'allowed'));
    const r = verifyAuditFile(file);
    assert.equal(r.ok, true);
    assert.equal(r.checked, 5);
  } finally {
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  }
});

test('tampering with a record is detected', () => {
  const file = tmpFile();
  try {
    const a = new FileAuditSink(file);
    a.record(ev('read_page', 'allowed'));
    a.record(ev('run_js', 'allowed')); // pretend this one is edited to hide it
    a.record(ev('click', 'allowed'));

    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    const rec = JSON.parse(lines[1]);
    rec.event.outcome = 'denied'; // tamper: rewrite history
    lines[1] = JSON.stringify(rec);
    fs.writeFileSync(file, lines.join('\n') + '\n');

    const r = verifyAuditFile(file);
    assert.equal(r.ok, false);
    assert.equal(r.brokenAt, 2);
  } finally {
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  }
});

test('deleting a record (breaking the chain) is detected', () => {
  const file = tmpFile();
  try {
    const a = new FileAuditSink(file);
    for (let i = 0; i < 4; i++) a.record(ev(`t${i}`, 'allowed'));
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    lines.splice(1, 1); // remove the 2nd record
    fs.writeFileSync(file, lines.join('\n') + '\n');
    assert.equal(verifyAuditFile(file).ok, false);
  } finally {
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  }
});

test('verify of a non-existent log is vacuously ok', () => {
  assert.deepEqual(verifyAuditFile('/no/such/safecobrowser-audit.jsonl'), { ok: true, checked: 0 });
});
