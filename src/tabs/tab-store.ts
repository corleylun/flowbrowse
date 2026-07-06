import * as fs from 'node:fs';
import * as path from 'node:path';

export interface PersistedTab {
  containerId: string;
  url: string;
}

export interface PersistedTabs {
  activeIndex: number;
  tabs: PersistedTab[];
}

/** Persist the open tabs (container + url) so they can be restored next launch. */
export function saveTabs(file: string, state: PersistedTabs): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify(state, null, 2), { mode: 0o600 });
}

/** Load persisted tabs; returns null if none/invalid (caller opens a default tab). */
export function loadTabs(file: string): PersistedTabs | null {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as PersistedTabs;
    if (!raw || !Array.isArray(raw.tabs)) return null;
    const tabs = raw.tabs.filter(
      (t): t is PersistedTab =>
        !!t && typeof t.containerId === 'string' && typeof t.url === 'string',
    );
    if (tabs.length === 0) return null;
    const activeIndex =
      typeof raw.activeIndex === 'number' && raw.activeIndex >= 0 && raw.activeIndex < tabs.length
        ? raw.activeIndex
        : 0;
    return { activeIndex, tabs };
  } catch {
    return null;
  }
}
