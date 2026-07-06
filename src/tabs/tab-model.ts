export interface TabMeta {
  id: string;
  containerId: string;
}

/**
 * Pure tab bookkeeping (no Electron): the ordered list of tabs, each bound to a container,
 * plus which one is active. The main process mirrors this with real WebContentsViews. Keeps
 * the active-tab/close rules testable in isolation.
 */
export class TabModel {
  private tabs: TabMeta[] = [];
  private currentId = '';
  private seq = 0;

  /** Create a tab in the given container; it becomes the active tab. */
  create(containerId: string): TabMeta {
    const meta: TabMeta = { id: `t${++this.seq}`, containerId };
    this.tabs.push(meta);
    this.currentId = meta.id;
    return meta;
  }

  /**
   * Close a tab. If it was active, the neighbour (next, else previous) becomes active.
   * Returns the new active id (null if no tabs remain — the caller should then create one).
   */
  close(id: string): { newActiveId: string | null } {
    const idx = this.tabs.findIndex((t) => t.id === id);
    if (idx === -1) return { newActiveId: this.currentId || null };
    this.tabs.splice(idx, 1);
    if (this.currentId === id) {
      const next = this.tabs[idx] ?? this.tabs[idx - 1] ?? null;
      this.currentId = next ? next.id : '';
    }
    return { newActiveId: this.currentId || null };
  }

  activate(id: string): boolean {
    if (!this.tabs.some((t) => t.id === id)) return false;
    this.currentId = id;
    return true;
  }

  /** Reassign a tab to a different container (the caller recreates its page view). */
  setContainer(id: string, containerId: string): boolean {
    const t = this.tabs.find((x) => x.id === id);
    if (!t) return false;
    t.containerId = containerId;
    return true;
  }

  list(): TabMeta[] {
    return [...this.tabs];
  }

  get(id: string): TabMeta | null {
    return this.tabs.find((t) => t.id === id) ?? null;
  }

  active(): TabMeta | null {
    return this.tabs.find((t) => t.id === this.currentId) ?? null;
  }

  activeId(): string {
    return this.currentId;
  }

  count(): number {
    return this.tabs.length;
  }
}
