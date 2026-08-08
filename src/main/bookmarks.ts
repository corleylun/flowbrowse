import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * User bookmarks — the human's own saved links, same as any browser's bookmarks.
 *
 * This is a HUMAN-only convenience, NEVER exposed to the agent (no tool reads it; it lives only
 * behind the `bookmarks:*` IPC the chrome renderer calls — same invisibility class as Browsing
 * History / Downloads). Global (not per-container): a bookmark is just a saved URL, not tied to a
 * logged-in identity. Keyed by exact URL (so the same page is bookmarked at most once); only real
 * http(s) pages are bookmarkable (the star never shows on the internal shell / blank pages).
 */

export interface Bookmark {
  url: string;
  title: string;
  /** Epoch ms when the bookmark was created. */
  createdAt: number;
}

const MAX_TITLE_LEN = 300;
const MAX_URL_LEN = 2048;

/** Only real, navigable web pages can be bookmarked (never about:blank, data:, the internal shell). */
export function isBookmarkableUrl(url: unknown): url is string {
  return typeof url === 'string' && /^https?:\/\//i.test(url) && url.length <= MAX_URL_LEN;
}

export class BookmarkStore {
  // Keyed by URL — a page is bookmarked at most once. Insertion order is preserved by Map; `list`
  // returns newest-first so a freshly-saved link is at the top for quick reopening.
  private entries = new Map<string, Bookmark>();

  constructor(
    private readonly file: string,
    private readonly clock: () => number = () => Date.now(),
  ) {
    this.load();
  }

  private load(): void {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8')) as unknown;
      if (!Array.isArray(raw)) return;
      for (const item of raw) {
        const e = item as Partial<Bookmark>;
        if (!isBookmarkableUrl(e.url)) continue;
        this.entries.set(e.url, {
          url: e.url,
          title: typeof e.title === 'string' ? e.title.slice(0, MAX_TITLE_LEN) : '',
          createdAt: typeof e.createdAt === 'number' && Number.isFinite(e.createdAt) ? e.createdAt : 0,
        });
      }
    } catch {
      /* none yet / unreadable — start empty */
    }
  }

  private save(): void {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
      fs.writeFileSync(this.file, JSON.stringify([...this.entries.values()]), { mode: 0o600 });
    } catch {
      /* best effort — a bookmark is a convenience, never fail anything over it */
    }
  }

  /** Is this exact URL bookmarked? Drives the address-bar star's filled/empty state. */
  has(url: unknown): boolean {
    return typeof url === 'string' && this.entries.has(url);
  }

  /** Add a bookmark (no-op if the URL is already saved; refreshes the title if a better one arrives). */
  add(url: unknown, title: unknown): boolean {
    if (!isBookmarkableUrl(url)) return false;
    const cleanTitle = typeof title === 'string' ? title.slice(0, MAX_TITLE_LEN) : '';
    const existing = this.entries.get(url);
    if (existing) {
      if (cleanTitle && existing.title !== cleanTitle) {
        existing.title = cleanTitle;
        this.save();
      }
      return true;
    }
    this.entries.set(url, { url, title: cleanTitle, createdAt: this.clock() });
    this.save();
    return true;
  }

  /** Remove a bookmark by URL. Returns true if one was removed. */
  remove(url: unknown): boolean {
    if (typeof url !== 'string' || !this.entries.has(url)) return false;
    this.entries.delete(url);
    this.save();
    return true;
  }

  /** Toggle the bookmark for a page: add if absent, remove if present. Returns the NEW state
   *  (`true` = now bookmarked) — this is what the address-bar star calls. */
  toggle(url: unknown, title: unknown): boolean {
    if (!isBookmarkableUrl(url)) return false;
    if (this.entries.has(url)) {
      this.entries.delete(url);
      this.save();
      return false;
    }
    this.add(url, title);
    return true;
  }

  /** Rename a bookmark (edit its display title) without changing its URL. */
  rename(url: unknown, title: unknown): boolean {
    if (typeof url !== 'string' || typeof title !== 'string') return false;
    const existing = this.entries.get(url);
    if (!existing) return false;
    existing.title = title.slice(0, MAX_TITLE_LEN);
    this.save();
    return true;
  }

  /** All bookmarks, newest first. */
  list(): Bookmark[] {
    return [...this.entries.values()].sort((a, b) => b.createdAt - a.createdAt);
  }
}
