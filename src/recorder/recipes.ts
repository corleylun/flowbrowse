import * as fs from 'node:fs';
import * as path from 'node:path';
import { RecordedAction } from './actions';
import { domainSlug } from './domain';

/** One step of a recipe: a captured action plus optional user authoring (name + description)
 *  that turns the recording into a readable tutorial for the user — and later the AI agent. */
export interface RecipeStep {
  action: RecordedAction;
  name?: string;
  description?: string;
}

export interface Recipe {
  name: string;
  description?: string;
  domain: string;
  createdAt: number;
  updatedAt: number;
  steps: RecipeStep[];
}

export interface RecipeSummary {
  name: string;
  description?: string;
  domain: string;
  createdAt: number;
  updatedAt: number;
  steps: number;
}

/** Turn a user-supplied recipe name into a safe filesystem slug. */
export function slug(name: string): string {
  const s = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100); // cap length so the filename can't exceed NAME_MAX
  return s.replace(/-+$/g, '') || 'recipe';
}

/** Coerce a parsed-from-disk object into a Recipe, tolerating the old flat `{ name, actions }`
 *  shape (recorder UI was hidden, so legacy recipes are unlikely — but parse defensively). */
function normalize(raw: unknown, domain: string): Recipe | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.name !== 'string') return null;

  let steps: RecipeStep[];
  if (Array.isArray(r.steps)) {
    steps = (r.steps as unknown[])
      .filter((s): s is RecipeStep => !!s && typeof s === 'object' && 'action' in (s as object))
      .map((s) => {
        const step = s as RecipeStep;
        return {
          action: step.action,
          ...(typeof step.name === 'string' ? { name: step.name } : {}),
          ...(typeof step.description === 'string' ? { description: step.description } : {}),
        };
      });
  } else if (Array.isArray(r.actions)) {
    steps = (r.actions as RecordedAction[]).map((action) => ({ action })); // legacy → steps
  } else {
    return null;
  }

  const createdAt = typeof r.createdAt === 'number' ? r.createdAt : Date.now();
  return {
    name: r.name,
    ...(typeof r.description === 'string' ? { description: r.description } : {}),
    domain: typeof r.domain === 'string' && r.domain ? r.domain : domain,
    createdAt,
    updatedAt: typeof r.updatedAt === 'number' ? r.updatedAt : createdAt,
    steps,
  };
}

/**
 * Persists named recipes (saved, annotated action sequences) keyed by DOMAIN. This is half the
 * lock-in: recipes accumulate per site and become the user's — and the agent's — reusable
 * automations. Layout: <dir>/<domainSlug>/<slug(name)>.json.
 */
export class RecipeStore {
  constructor(private readonly dir: string) {}

  private domainDir(domain: string): string {
    return path.join(this.dir, domainSlug(domain));
  }

  private fileFor(domain: string, name: string): string {
    return path.join(this.domainDir(domain), `${slug(name)}.json`);
  }

  save(domain: string, recipe: Omit<Recipe, 'domain' | 'createdAt' | 'updatedAt'> & Partial<Recipe>): Recipe {
    const dir = this.domainDir(domain);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const now = Date.now();
    const full: Recipe = {
      name: recipe.name.trim() || 'recipe',
      ...(recipe.description ? { description: recipe.description } : {}),
      domain,
      createdAt: recipe.createdAt ?? now,
      updatedAt: now,
      steps: recipe.steps ?? [],
    };
    fs.writeFileSync(this.fileFor(domain, full.name), JSON.stringify(full, null, 2), { mode: 0o600 });
    return full;
  }

  get(domain: string, name: string): Recipe | null {
    try {
      const raw = JSON.parse(fs.readFileSync(this.fileFor(domain, name), 'utf8')) as unknown;
      return normalize(raw, domain);
    } catch {
      return null;
    }
  }

  private readDomainDir(dirPath: string, fallbackDomain: string): RecipeSummary[] {
    let files: string[];
    try {
      files = fs.readdirSync(dirPath).filter((f) => f.endsWith('.json'));
    } catch {
      return [];
    }
    const out: RecipeSummary[] = [];
    for (const f of files) {
      try {
        const recipe = normalize(JSON.parse(fs.readFileSync(path.join(dirPath, f), 'utf8')), fallbackDomain);
        if (recipe) {
          out.push({
            name: recipe.name,
            ...(recipe.description ? { description: recipe.description } : {}),
            domain: recipe.domain,
            createdAt: recipe.createdAt,
            updatedAt: recipe.updatedAt,
            steps: recipe.steps.length,
          });
        }
      } catch {
        /* skip unreadable */
      }
    }
    return out;
  }

  /** Recipes for one domain. */
  list(domain: string): RecipeSummary[] {
    return this.readDomainDir(this.domainDir(domain), domain).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** Every recipe across all domains, newest first — for the "find any recipe" manager. */
  listAll(): RecipeSummary[] {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(this.dir, { withFileTypes: true });
    } catch {
      return [];
    }
    const out: RecipeSummary[] = [];
    for (const e of entries) {
      if (e.isDirectory()) out.push(...this.readDomainDir(path.join(this.dir, e.name), e.name));
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** Apply edits (name, description, step annotations) to an existing recipe. Renaming moves
   *  the file when the slug changes. Returns null if the original recipe is missing. */
  update(
    domain: string,
    originalName: string,
    recipe: Omit<Recipe, 'domain' | 'createdAt' | 'updatedAt'> & Partial<Recipe>,
  ): Recipe | null {
    const existing = this.get(domain, originalName);
    if (!existing) return null;
    const saved = this.save(domain, { ...recipe, createdAt: existing.createdAt });
    if (slug(saved.name) !== slug(originalName)) {
      try {
        fs.unlinkSync(this.fileFor(domain, originalName)); // remove the file under the old name
      } catch {
        /* best effort */
      }
    }
    return saved;
  }

  delete(domain: string, name: string): boolean {
    try {
      fs.unlinkSync(this.fileFor(domain, name));
      return true;
    } catch {
      return false;
    }
  }
}
