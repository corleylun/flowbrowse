import { Mode } from '../core/modes';
import { RiskLevel, Tool, Parser } from '../core/tool';
import { Recipe, RecipeSummary } from '../recorder/recipes';
import { RecordedAction } from '../recorder/actions';

/**
 * Read-only access to the user's saved recipes ("tutorials") for the AGENT. These tools let a
 * connected agent discover and read the how-to guides the user recorded for a site, then drive
 * the page with its own (already-gated) click/fill tools. They never execute anything and never
 * touch the page, so they are Read-tier, Low-risk, no-approval. Scoped to the active page's
 * domain — the agent only sees recipes for the site it is actually on. Sensitive (masked) field
 * values are withheld; only the fact that a sensitive field is filled is surfaced.
 */
export interface RecipeProvider {
  /** Registrable domain of the active tab — the recipe key. '' on non-web pages. */
  currentDomain(): string;
  list(domain: string): RecipeSummary[];
  get(domain: string, name: string): Recipe | null;
}

interface TutorialStep {
  n: number;
  name?: string;
  description?: string;
  action: string; // human-readable summary
  type: RecordedAction['type'];
  selector?: string;
  label?: string;
  value?: string; // only for non-sensitive fills
  sensitive?: boolean; // a masked field — value intentionally withheld
  url?: string;
}

function summarize(a: RecordedAction): string {
  if (a.type === 'click') return `click ${a.label ? `"${a.label}"` : a.selector}`;
  if (a.type === 'fill') return a.masked ? `type into "${a.label}" (sensitive — value hidden)` : `type "${a.value}" into "${a.label}"`;
  if (a.type === 'submit') return `press Enter${a.label ? ` in "${a.label}"` : ''} to submit`;
  return `go to ${(a as { url: string }).url}`; // navigate
}

function toTutorialStep(step: Recipe['steps'][number], i: number): TutorialStep {
  const a = step.action;
  const out: TutorialStep = { n: i + 1, action: summarize(a), type: a.type };
  if (step.name) out.name = step.name;
  if (step.description) out.description = step.description;
  if (a.type === 'click' || a.type === 'fill' || a.type === 'submit') {
    out.selector = a.selector;
    out.label = a.label;
  }
  if (a.type === 'fill') {
    if (a.masked || a.value === null) out.sensitive = true;
    else out.value = a.value;
  }
  if (a.type === 'navigate') out.url = a.url;
  return out;
}

const noArgs: Parser<Record<string, never>> = {
  parse(raw) {
    if (raw !== undefined && raw !== null && typeof raw !== 'object') throw new Error('this tool takes no arguments');
    return {};
  },
};

const nameArg: Parser<{ name: string }> = {
  parse(raw) {
    if (!raw || typeof raw !== 'object') throw new Error('expected { name }');
    const name = (raw as Record<string, unknown>).name;
    if (typeof name !== 'string' || name.trim() === '') throw new Error('name is required');
    return { name };
  },
};

export function createRecipeTools(provider: RecipeProvider): Tool[] {
  const listRecipes: Tool<Record<string, never>, { domain: string; recipes: Array<{ name: string; description?: string; steps: number }> }> =
    {
      name: 'list_recipes',
      description:
        "List the user's saved recipes (recorded how-to tutorials) for the current page's site. Use get_recipe to read one's steps before performing a task on this site.",
      minMode: Mode.Read,
      risk: RiskLevel.Low,
      requiresApproval: false,
      inputSchema: noArgs,
      handler: async () => {
        const domain = provider.currentDomain();
        const recipes = provider.list(domain).map((r) => ({
          name: r.name,
          ...(r.description ? { description: r.description } : {}),
          steps: r.steps,
        }));
        return { domain, recipes };
      },
    };

  const getRecipe: Tool<{ name: string }, { error?: string; name?: string; domain?: string; description?: string; steps?: TutorialStep[] }> =
    {
      name: 'get_recipe',
      description:
        "Read one saved recipe for the current site by name: its description and step-by-step actions (a how-to you can follow with click/fill). Sensitive field values are withheld.",
      minMode: Mode.Read,
      risk: RiskLevel.Low,
      requiresApproval: false,
      inputSchema: nameArg,
      handler: async (input) => {
        const recipe = provider.get(provider.currentDomain(), input.name);
        if (!recipe) return { error: `no recipe named "${input.name}" for this site` };
        return {
          name: recipe.name,
          domain: recipe.domain,
          ...(recipe.description ? { description: recipe.description } : {}),
          steps: recipe.steps.map(toTutorialStep),
        };
      },
    };

  return [listRecipes, getRecipe];
}
