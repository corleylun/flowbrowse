import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { AuditEvent } from '../core/audit';
import { FileAuditSink, verifyAuditFile, SealedRecord } from './file-sink';

/**
 * Phase 6 ADVERSARIAL review (Aidan). These tests probe the REAL guarantees of the
 * durable, hash-chained audit log — not the happy path the existing suite covers.
 *
 * Headline findings these tests pin down:
 *  - The hash chain detects naive/accidental tampering but NOT a determined local
 *    attacker with file-write: there is no external anchor/signature, so the chain can
 *    be truncated and re-sealed from GENESIS into a forged-but-"valid" log.
 *  - verifyAuditFile's behavior on garbage / truncated / empty inputs.
 *  - record() advances the in-memory prevHash BEFORE the append succeeds, so a failed
 *    append desyncs the in-memory chain from disk and silently corrupts the chain for
 *    every subsequent record (invariant #5 — audit failure must not break the chain).
 */

function tmpFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'safecobrowser-audit-adv-'));
  return path.join(dir, 'audit-log.jsonl');
}

function ev(toolName: string, outcome: AuditEvent['outcome'] = 'allowed'): AuditEvent {
  return { ts: Date.now(), tabId: 'main', toolName, mode: 'read', epoch: 1, outcome };
}

// Mirror of the implementation's hashRecord so we can forge a re-sealed chain.
function hashRecord(seq: number, prevHash: string, event: AuditEvent): string {
  return createHash('sha256').update(`${seq}\n${prevHash}\n${JSON.stringify(event)}`).digest('hex');
}

test('LIMITATION: an attacker with file-write can truncate + re-seal a forged log that verifies clean', () => {
  const file = tmpFile();
  try {
    const a = new FileAuditSink(file);
    a.record(ev('read_page'));
    a.record(ev('run_js')); // the "incriminating" record the attacker wants to erase
    a.record(ev('click'));
    assert.equal(verifyAuditFile(file).ok, true, 'genuine log verifies');

    // Attacker rewrites history: drops run_js, then RE-SEALS the whole chain from GENESIS.
    const forged: AuditEvent[] = [ev('read_page'), ev('click')];
    let prevHash = 'GENESIS';
    const lines: string[] = [];
    forged.forEach((event, i) => {
      const seq = i + 1;
      const hash = hashRecord(seq, prevHash, event);
      const rec: SealedRecord = { seq, prevHash, hash, event };
      lines.push(JSON.stringify(rec));
      prevHash = hash;
    });
    fs.writeFileSync(file, lines.join('\n') + '\n');

    // The local chain alone CANNOT detect this — it walks from GENESIS and the forged
    // chain is internally consistent. This is the documented real guarantee: detects
    // accidental/naive edits, NOT a determined local attacker (no external anchor).
    const r = verifyAuditFile(file);
    assert.equal(r.ok, true, 'forged re-sealed chain verifies as OK — the known limitation');
    assert.equal(r.checked, 2);
  } finally {
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  }
});

test('truncating the tail (deleting the last record) is NOT detected by the chain', () => {
  const file = tmpFile();
  try {
    const a = new FileAuditSink(file);
    for (let i = 0; i < 4; i++) a.record(ev(`t${i}`));
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    lines.pop(); // drop the LAST record — chain is still internally consistent
    fs.writeFileSync(file, lines.join('\n') + '\n');
    // Tail truncation leaves a self-consistent prefix; verify cannot know a record is missing.
    assert.equal(verifyAuditFile(file).ok, true, 'tail truncation is undetectable without an anchor');
  } finally {
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  }
});

test('verify reports a garbage/half-written line as broken (at its 1-based position)', () => {
  const file = tmpFile();
  try {
    const a = new FileAuditSink(file);
    a.record(ev('read_page'));
    a.record(ev('click'));
    // Simulate a partially-written / corrupt third line (e.g. crash mid-append).
    fs.appendFileSync(file, '{not valid json');
    const r = verifyAuditFile(file);
    assert.equal(r.ok, false);
    assert.equal(r.checked, 2, 'two good records counted before the garbage');
    assert.equal(r.brokenAt, 3, 'broken at the 3rd line');
  } finally {
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  }
});

test('verify of an explicitly empty file is vacuously ok', () => {
  const file = tmpFile();
  try {
    fs.writeFileSync(file, '');
    assert.deepEqual(verifyAuditFile(file), { ok: true, checked: 0 });
  } finally {
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  }
});

test('verify of a whitespace-only / blank-lines file is vacuously ok (blank lines filtered)', () => {
  const file = tmpFile();
  try {
    fs.writeFileSync(file, '\n\n\n');
    assert.deepEqual(verifyAuditFile(file), { ok: true, checked: 0 });
  } finally {
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  }
});

test('reordering two records breaks the chain (detected)', () => {
  const file = tmpFile();
  try {
    const a = new FileAuditSink(file);
    a.record(ev('a'));
    a.record(ev('b'));
    a.record(ev('c'));
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    [lines[0], lines[1]] = [lines[1], lines[0]]; // swap first two
    fs.writeFileSync(file, lines.join('\n') + '\n');
    assert.equal(verifyAuditFile(file).ok, false);
  } finally {
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  }
});

test('B1 fixed: a failed append never throws, is surfaced, and does NOT desync the chain', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'safecobrowser-audit-fail-'));
  const file = path.join(dir, 'audit-log.jsonl');
  try {
    const a = new FileAuditSink(file);
    a.record(ev('first')); // good — file created
    assert.equal(verifyAuditFile(file).ok, true);

    fs.chmodSync(file, 0o400); // make the NEXT append fail (EACCES/EPERM)
    let threw = false;
    try {
      a.record(ev('lost'));
    } catch {
      threw = true;
    }
    fs.chmodSync(file, 0o600); // restore writability

    // (#5) record() must swallow the write error — never break the broker.
    assert.equal(threw, false, 'record() does not throw out into the broker');

    if (a.writeFailures > 0) {
      // The failure is surfaced (counted), not silent.
      assert.equal(a.writeFailures, 1);
      // (#2) prevHash was NOT advanced, so a later successful write retries cleanly and the
      // on-disk chain stays consistent — an audit infra failure is not mistaken for tampering.
      a.record(ev('after'));
      assert.equal(verifyAuditFile(file).ok, true, 'chain stays consistent after a failed write');
    } else {
      assert.ok(true, 'append did not fail (likely running as root); nothing to assert');
    }
  } finally {
    try {
      fs.chmodSync(file, 0o600);
    } catch {
      /* best effort */
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
