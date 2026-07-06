import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { AuditEvent, AuditSink } from '../core/audit';

export const AUDIT_FILENAME = 'audit-log.jsonl';
const GENESIS = 'GENESIS';

/** One sealed audit record: the event plus a hash chain link for tamper-evidence. */
export interface SealedRecord {
  seq: number;
  prevHash: string;
  hash: string;
  event: AuditEvent;
}

function hashRecord(seq: number, prevHash: string, event: AuditEvent): string {
  return createHash('sha256').update(`${seq}\n${prevHash}\n${JSON.stringify(event)}`).digest('hex');
}

/**
 * Durable, append-only audit sink. Every brokered decision is written as one JSON line to
 * disk, surviving restart, and chained by hash.
 *
 * TAMPER-EVIDENCE — honest guarantee: `verifyAuditFile` detects accidental corruption and
 * naive in-place edits, deletions, and reordering. It does NOT resist a determined local
 * attacker who can rewrite the whole file (there is no external anchor or signature, so a
 * forged log can be re-sealed from GENESIS), and it does NOT detect tail truncation
 * (dropping the most recent records leaves a self-consistent prefix). The enterprise
 * governance layer this seeds will need an external anchor (signed checkpoints / SIEM).
 */
export class FileAuditSink implements AuditSink {
  private seq = 0;
  private prevHash = GENESIS;
  private failures = 0;
  private readonly recent: SealedRecord[] = [];
  private readonly recentCap = 500;
  private readonly listeners = new Set<(rec: SealedRecord) => void>();

  constructor(private readonly file: string) {
    this.load();
  }

  /** Subscribe to each newly-persisted record (drives the in-app activity log). */
  onRecord(cb: (rec: SealedRecord) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private load(): void {
    try {
      const lines = fs.readFileSync(this.file, 'utf8').split('\n').filter((l) => l.length > 0);
      for (const line of lines) {
        const rec = JSON.parse(line) as SealedRecord;
        this.seq = rec.seq;
        this.prevHash = rec.hash;
        this.recent.push(rec);
      }
      if (this.recent.length > this.recentCap) {
        this.recent.splice(0, this.recent.length - this.recentCap);
      }
    } catch {
      /* no log yet — start fresh */
    }
  }

  record(event: AuditEvent): void {
    const seq = this.seq + 1;
    const prevHash = this.prevHash;
    const hash = hashRecord(seq, prevHash, event);
    const rec: SealedRecord = { seq, prevHash, hash, event };

    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
      fs.appendFileSync(this.file, `${JSON.stringify(rec)}\n`, { mode: 0o600 });
    } catch (err) {
      // An audit write failure must NOT break the broker (a completed call would be
      // mislabeled an error) and must NOT desync the chain. Leave seq/prevHash untouched
      // so the next write retries cleanly. Surface loudly — never swallow silently.
      this.failures++;
      console.error(
        '[safecobrowser] AUDIT WRITE FAILED — decision not persisted:',
        err instanceof Error ? err.message : err,
      );
      return;
    }

    // Commit in-memory chain state only after the disk write succeeded.
    this.seq = seq;
    this.prevHash = hash;
    this.recent.push(rec);
    if (this.recent.length > this.recentCap) this.recent.shift();

    for (const l of this.listeners) {
      try {
        l(rec);
      } catch {
        /* a listener must never break the sink */
      }
    }
  }

  /** Count of decisions that failed to persist (disk error). Surfaced, never silent. */
  get writeFailures(): number {
    return this.failures;
  }

  /** Recent records for the UI activity log / CLI. */
  recentRecords(limit = 100): SealedRecord[] {
    return this.recent.slice(-limit);
  }
}

export interface VerifyResult {
  ok: boolean;
  checked: number;
  brokenAt?: number;
}

/** Re-walk the hash chain on disk; reports the first broken link (tamper detection). */
export function verifyAuditFile(file: string): VerifyResult {
  let lines: string[];
  try {
    lines = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.length > 0);
  } catch {
    return { ok: true, checked: 0 }; // no log = nothing to tamper with
  }
  let prevHash = GENESIS;
  let checked = 0;
  for (const line of lines) {
    let rec: SealedRecord;
    try {
      rec = JSON.parse(line) as SealedRecord;
    } catch {
      return { ok: false, checked, brokenAt: checked + 1 };
    }
    checked++;
    const expected = hashRecord(rec.seq, prevHash, rec.event);
    if (rec.prevHash !== prevHash || rec.hash !== expected) {
      return { ok: false, checked, brokenAt: rec.seq };
    }
    prevHash = rec.hash;
  }
  return { ok: true, checked };
}
