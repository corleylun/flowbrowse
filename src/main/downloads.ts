import { shell } from 'electron';
import type { Session, DownloadItem, WebContents } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Routes browser downloads into a per-container folder, bypassing the native Save-As dialog,
 * and keeps a short in-memory list for the chrome UI.
 *
 * Security model: this is a USER surface only. There is deliberately NO download tool and NO
 * way for the agent to learn that a download happened or to read the file — the agent can click
 * a page's "Download" button (Act + approval) but the bytes land on the user's disk, brokered by
 * nothing the agent can reach. Downloads stay inside each container's own folder, mirroring the
 * session isolation boundary.
 */

export type DownloadState = 'progressing' | 'completed' | 'cancelled' | 'interrupted';

export interface DownloadRecord {
  id: number;
  filename: string;
  savePath: string;
  container: string; // container id — the folder the file went into
  state: DownloadState;
  receivedBytes: number;
  totalBytes: number;
  startedAt: number;
}

/** Pick a non-colliding path inside `dir` for `filename` (appends " (n)" before the extension). */
export function uniqueSavePath(dir: string, filename: string, exists: (p: string) => boolean): string {
  const safe = path.basename(filename) || 'download'; // never let a filename escape the folder
  const ext = path.extname(safe);
  const stem = path.basename(safe, ext);
  let candidate = path.join(dir, safe);
  let n = 1;
  while (exists(candidate)) {
    candidate = path.join(dir, `${stem} (${n})${ext}`);
    n++;
  }
  return candidate;
}

export class DownloadManager {
  private records: DownloadRecord[] = [];
  private seq = 0;
  private wired = new Set<string>(); // partitions already given a will-download handler

  /** @param baseDir lazy so it can read app.getPath('downloads') after the app is ready.
   *  @param onChange notify the UI a record changed.
   *  @param onStartedFrom optional hook with the WebContents that initiated each download — lets
   *         the caller clean up a popup tab that existed only to kick off a download.
   *  @param storeFile optional path to persist the list across restarts (e.g. ~/.safecobrowser/downloads.json). */
  constructor(
    private readonly baseDir: () => string,
    private readonly onChange: () => void,
    private readonly onStartedFrom?: (wc: WebContents) => void,
    private readonly storeFile?: string,
  ) {
    this.load();
  }

  /** Restore the list from disk so the Downloads panel survives a restart. Best-effort: an
   *  unfinished download (the app quit mid-transfer) is marked interrupted, and a record whose
   *  file no longer exists is dropped. */
  private load(): void {
    if (!this.storeFile) return;
    try {
      const raw = JSON.parse(fs.readFileSync(this.storeFile, 'utf8')) as DownloadRecord[];
      if (!Array.isArray(raw)) return;
      this.records = raw
        .filter((r) => r && typeof r.savePath === 'string' && fs.existsSync(r.savePath))
        .map((r) => (r.state === 'progressing' ? { ...r, state: 'interrupted' as const } : r));
      this.seq = this.records.reduce((m, r) => Math.max(m, r.id || 0), 0);
    } catch {
      /* no history yet */
    }
  }

  private persist(): void {
    if (!this.storeFile) return;
    try {
      fs.mkdirSync(path.dirname(this.storeFile), { recursive: true, mode: 0o700 });
      fs.writeFileSync(this.storeFile, JSON.stringify(this.records, null, 2), { mode: 0o600 });
    } catch {
      /* best effort */
    }
  }

  /** Persist, then notify the UI. */
  private changed(): void {
    this.persist();
    this.onChange();
  }

  /** Route a container session's downloads into `<baseDir>/<container>/`. Idempotent per partition
   *  (one session is shared by every tab in a container, so we attach the handler exactly once). */
  attach(sess: Session, partition: string, container: string): void {
    if (this.wired.has(partition)) return;
    this.wired.add(partition);
    sess.on('will-download', (_event, item: DownloadItem, webContents: WebContents) => {
      this.handle(item, container);
      if (webContents) this.onStartedFrom?.(webContents);
    });
  }

  private handle(item: DownloadItem, container: string): void {
    const dir = path.join(this.baseDir(), container);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const savePath = uniqueSavePath(dir, item.getFilename(), fs.existsSync);
    item.setSavePath(savePath); // skips the native Save-As dialog

    const rec: DownloadRecord = {
      id: ++this.seq,
      filename: path.basename(savePath),
      savePath,
      container,
      state: 'progressing',
      receivedBytes: 0,
      totalBytes: item.getTotalBytes(),
      startedAt: Date.now(),
    };
    this.records.unshift(rec);
    if (this.records.length > 50) this.records.length = 50;
    this.changed();

    item.on('updated', () => {
      rec.receivedBytes = item.getReceivedBytes();
      rec.totalBytes = item.getTotalBytes();
      this.onChange(); // progress ticks: notify UI but don't thrash the disk
    });
    item.once('done', (_e, state) => {
      rec.state = state === 'completed' ? 'completed' : state === 'cancelled' ? 'cancelled' : 'interrupted';
      rec.receivedBytes = item.getReceivedBytes();
      this.changed();
    });
  }

  list(): DownloadRecord[] {
    return [...this.records];
  }

  /** True only for a path we actually downloaded — guards reveal/open against arbitrary paths. */
  private known(p: string): boolean {
    return this.records.some((r) => r.savePath === p);
  }

  reveal(savePath: string): void {
    if (this.known(savePath)) shell.showItemInFolder(savePath);
  }

  open(savePath: string): Promise<string> {
    return this.known(savePath) ? shell.openPath(savePath) : Promise.resolve('unknown path');
  }

  /** Forget finished entries from the list (does NOT delete the files on disk). */
  clear(): void {
    this.records = this.records.filter((r) => r.state === 'progressing');
    this.changed();
  }
}
