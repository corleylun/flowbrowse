import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * User-defined sensitive-data redaction. When enabled, each rule's `match` text is replaced with
 * its `label` everywhere it appears in page content — so the same mechanism covers the user's
 * screen, screenshots, and what the agent reads (read_page / inspect).
 *
 * IMPORTANT framing: this is BEST-EFFORT defense-in-depth, NOT a guarantee. It matches literal
 * strings (case-insensitively); it will not catch reformatted, abbreviated, or split-across-nodes
 * variants. It is a convenience for hiding known values (your name, address), not a security
 * boundary — the per-tab AI block is the boundary.
 */

export interface PrivacyRule {
  match: string;
  label: string;
}

export interface PrivacyState {
  enabled: boolean;
  rules: PrivacyRule[];
}

const DEFAULT_LABEL = '[Filtered]';

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Replace every rule's match (case-insensitive, literal) with its label. Longest matches first
 *  so an overlapping shorter rule can't partially clobber a longer one. */
export function applyRules(text: string, rules: PrivacyRule[]): string {
  if (!text) return text;
  let out = text;
  const active = rules
    .filter((r) => r && typeof r.match === 'string' && r.match.length > 0)
    .sort((a, b) => b.match.length - a.match.length);
  for (const r of active) {
    out = out.replace(new RegExp(escapeRegExp(r.match), 'gi'), r.label || DEFAULT_LABEL);
  }
  return out;
}

/** Normalize a user-supplied rule list: trim, drop empties, default the label, dedupe by match. */
export function sanitizeRules(rules: unknown): PrivacyRule[] {
  if (!Array.isArray(rules)) return [];
  const seen = new Set<string>();
  const out: PrivacyRule[] = [];
  for (const r of rules) {
    const match = typeof (r as PrivacyRule)?.match === 'string' ? (r as PrivacyRule).match.trim() : '';
    if (!match) continue;
    const key = match.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const rawLabel = typeof (r as PrivacyRule)?.label === 'string' ? (r as PrivacyRule).label.trim() : '';
    out.push({ match, label: rawLabel || DEFAULT_LABEL });
  }
  return out;
}

export class PrivacyFilter {
  private state: PrivacyState = { enabled: false, rules: [] };

  constructor(private readonly file: string) {
    this.load();
  }

  private load(): void {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Partial<PrivacyState>;
      this.state = { enabled: !!raw.enabled, rules: sanitizeRules(raw.rules) };
    } catch {
      /* none yet */
    }
  }

  private save(): void {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
      fs.writeFileSync(this.file, JSON.stringify(this.state, null, 2), { mode: 0o600 });
    } catch {
      /* best effort */
    }
  }

  get(): PrivacyState {
    return { enabled: this.state.enabled, rules: this.state.rules.map((r) => ({ ...r })) };
  }

  setEnabled(on: boolean): void {
    this.state.enabled = !!on;
    this.save();
  }

  setRules(rules: unknown): void {
    this.state.rules = sanitizeRules(rules);
    this.save();
  }

  /** Redact text only when the filter is enabled — used for agent-facing tool output. */
  redact(text: string): string {
    return this.state.enabled ? applyRules(text, this.state.rules) : text;
  }
}
