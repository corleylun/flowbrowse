import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Local browsing history that powers URL-bar autocomplete.
 *
 * This is the HUMAN's own address-bar convenience — it is NEVER exposed to the agent (no tool
 * reads it; it lives only behind the `nav:suggest` IPC the chrome renderer calls). Only committed
 * top-level http(s) navigations are recorded; internal/blank pages are skipped. Ranking is a simple
 * "frecency": visit count scaled by how recently the page was last seen, with host-prefix matches
 * ranked above mid-URL matches above title-only matches.
 */

export interface HistoryEntry {
  url: string;
  title: string;
  /** How many times this exact URL has been navigated to. */
  visitCount: number;
  /** Epoch ms of the most recent visit. */
  lastVisit: number;
}

export interface Suggestion {
  url: string;
  title: string;
}

const MAX_ENTRIES = 3000;
const MAX_TITLE_LEN = 300;
const MAX_URL_LEN = 2048;
const DEFAULT_LIMIT = 8;

/** Strip protocol + a leading `www.` so a query like "git" matches github.com at the host start. */
export function stripForMatch(url: string): string {
  return url.replace(/^https?:\/\//i, '').replace(/^www\./i, '');
}

/** Recency multiplier — recently-seen pages rank higher (the "frecency" recency half). */
export function recencyWeight(ageMs: number): number {
  const day = 86_400_000;
  if (ageMs < day) return 4;
  if (ageMs < 7 * day) return 2;
  if (ageMs < 30 * day) return 1;
  return 0.5;
}

/**
 * Score one entry against an already-lowercased query. Returns -1 for no match. Match *quality*
 * (where the query lands) dominates; frecency breaks ties within a quality tier.
 */
export function scoreEntry(entry: HistoryEntry, q: string, now: number): number {
  const stripped = stripForMatch(entry.url).toLowerCase();
  const fullUrl = entry.url.toLowerCase();
  const title = (entry.title || '').toLowerCase();
  let base: number;
  if (stripped.startsWith(q)) base = 1000;
  else if (fullUrl.includes(q)) base = 400;
  else if (title.includes(q)) base = 200;
  else return -1;
  const frecency = entry.visitCount * recencyWeight(now - entry.lastVisit);
  return base + frecency;
}

/** Only real, navigable web pages belong in history (never about:blank, data:, the internal shell). */
function isRecordableUrl(url: unknown): url is string {
  return typeof url === 'string' && /^https?:\/\//i.test(url) && url.length <= MAX_URL_LEN;
}

export class HistoryStore {
  private entries = new Map<string, HistoryEntry>();

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
        const e = item as Partial<HistoryEntry>;
        if (!isRecordableUrl(e.url)) continue;
        this.entries.set(e.url, {
          url: e.url,
          title: typeof e.title === 'string' ? e.title.slice(0, MAX_TITLE_LEN) : '',
          visitCount: typeof e.visitCount === 'number' && e.visitCount > 0 ? Math.floor(e.visitCount) : 1,
          lastVisit: typeof e.lastVisit === 'number' && Number.isFinite(e.lastVisit) ? e.lastVisit : 0,
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
      /* best effort — autocomplete is a convenience, never fail a navigation over it */
    }
  }

  /** Drop the least-useful entries (lowest frecency, oldest) when the store grows too large. */
  private prune(): void {
    if (this.entries.size <= MAX_ENTRIES) return;
    const now = this.clock();
    const ranked = [...this.entries.values()].sort(
      (a, b) => b.visitCount * recencyWeight(now - b.lastVisit) - a.visitCount * recencyWeight(now - a.lastVisit),
    );
    this.entries = new Map(ranked.slice(0, MAX_ENTRIES).map((e) => [e.url, e]));
  }

  /** Record a committed navigation: upsert the URL, bump its visit count, refresh title + time. */
  record(url: unknown, title: unknown): void {
    if (!isRecordableUrl(url)) return;
    const now = this.clock();
    const cleanTitle = typeof title === 'string' ? title.slice(0, MAX_TITLE_LEN) : '';
    const existing = this.entries.get(url);
    if (existing) {
      existing.visitCount += 1;
      existing.lastVisit = now;
      if (cleanTitle) existing.title = cleanTitle;
    } else {
      this.entries.set(url, { url, title: cleanTitle, visitCount: 1, lastVisit: now });
      this.prune();
    }
    this.save();
  }

  /** Update a URL's title without counting it as a new visit (titles arrive after did-navigate). */
  touchTitle(url: unknown, title: unknown): void {
    if (!isRecordableUrl(url) || typeof title !== 'string' || !title) return;
    const existing = this.entries.get(url);
    if (!existing) return;
    const clean = title.slice(0, MAX_TITLE_LEN);
    if (existing.title === clean) return;
    existing.title = clean;
    this.save();
  }

  /** How many pages are currently stored (shown in Settings). */
  count(): number {
    return this.entries.size;
  }

  /** Wipe all saved history (the Settings "Clear history" action). Irreversible. */
  clear(): void {
    this.entries.clear();
    this.save();
  }

  /** Top matches for the typed text, best first. Empty query → no suggestions. */
  suggest(query: unknown, limit: number = DEFAULT_LIMIT): Suggestion[] {
    if (typeof query !== 'string') return [];
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const now = this.clock();
    const scored: Array<{ score: number; entry: HistoryEntry }> = [];
    for (const entry of this.entries.values()) {
      const score = scoreEntry(entry, q, now);
      if (score >= 0) scored.push({ score, entry });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, Math.max(0, limit)).map(({ entry }) => ({ url: entry.url, title: entry.title }));
  }
}
