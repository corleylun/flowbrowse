import * as fs from 'node:fs';
import * as path from 'node:path';

export interface ContainerInfo {
  id: string;
  name: string;
  createdAt: number;
}

export const DEFAULT_CONTAINER = 'default';
const BASE_PARTITION = 'persist:safecobrowser';

/** Turn a user-supplied container name into a safe id slug. */
export function containerSlug(name: string): string {
  const s =
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40)
      .replace(/-+$/g, '') || 'container';
  // `default` is reserved (it maps to the base partition) — never let the slug collide
  // with it, so the function is safe even for callers that bypass create().
  return s === DEFAULT_CONTAINER ? 'default-1' : s;
}

/**
 * Manages named "containers" — each an isolated, persistent browser session. Containers
 * share NOTHING (separate cookies/logins) because each maps to its own Electron partition.
 * The Default container keeps the original `persist:safecobrowser` partition; named containers get
 * `persist:safecobrowser-<id>`. This is the "clean room per client/project" isolation.
 */
export class ContainerManager {
  private containers: ContainerInfo[] = [];

  constructor(private readonly file: string) {
    this.load();
  }

  private load(): void {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8')) as unknown;
      if (Array.isArray(raw)) {
        this.containers = raw.filter(
          (c): c is ContainerInfo =>
            !!c && typeof (c as ContainerInfo).id === 'string' && typeof (c as ContainerInfo).name === 'string',
        );
      }
    } catch {
      /* none yet */
    }
    // Dedupe by id (a hand-edited file could contain duplicates → same partition).
    const seen = new Set<string>();
    this.containers = this.containers.filter((c) => (seen.has(c.id) ? false : (seen.add(c.id), true)));
    if (!this.containers.some((c) => c.id === DEFAULT_CONTAINER)) {
      this.containers.unshift({ id: DEFAULT_CONTAINER, name: 'Default', createdAt: 0 });
    }
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(this.file, JSON.stringify(this.containers, null, 2), { mode: 0o600 });
  }

  list(): ContainerInfo[] {
    return [...this.containers];
  }

  has(id: string): boolean {
    return this.containers.some((c) => c.id === id);
  }

  get(id: string): ContainerInfo | null {
    return this.containers.find((c) => c.id === id) ?? null;
  }

  create(name: string): ContainerInfo {
    const base = containerSlug(name);
    let id = base;
    let n = 2;
    while (this.has(id)) id = `${base}-${n++}`;
    const info: ContainerInfo = { id, name: name.trim() || id, createdAt: Date.now() };
    this.containers.push(info);
    this.save();
    return info;
  }

  /** Rename a container (display name only — id/partition unchanged, so the session is preserved).
   *  The Default container is reserved and cannot be renamed. Returns null if the rename was rejected. */
  rename(id: string, name: string): ContainerInfo | null {
    if (id === DEFAULT_CONTAINER) return null;
    const c = this.containers.find((c) => c.id === id);
    if (!c) return null;
    const next = name.trim();
    if (!next) return null;
    c.name = next;
    this.save();
    return c;
  }

  /** Remove a container from the list. The Default container is reserved and cannot be removed.
   *  NOTE: this only forgets the container — wiping its partition storage is the caller's job. */
  remove(id: string): boolean {
    if (id === DEFAULT_CONTAINER) return false;
    const before = this.containers.length;
    this.containers = this.containers.filter((c) => c.id !== id);
    if (this.containers.length === before) return false;
    this.save();
    return true;
  }

  /** The Electron session partition for a container — the isolation boundary. */
  partitionFor(id: string): string {
    return id === DEFAULT_CONTAINER ? BASE_PARTITION : `${BASE_PARTITION}-${id}`;
  }
}
