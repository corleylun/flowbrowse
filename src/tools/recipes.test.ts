import test from 'node:test';
import assert from 'node:assert/strict';
import { createRecipeTools, RecipeProvider } from './recipes';
import { Recipe } from '../recorder/recipes';
import { ToolContext } from '../core/tool';

const ctx = { tabId: 't', epoch: 1, isLive: () => true, signal: new AbortController().signal } as ToolContext;

const recipe: Recipe = {
  name: 'Search AskMingLi',
  description: 'Search on DuckDuckGo and open the result',
  domain: 'duckduckgo.com',
  createdAt: 1,
  updatedAt: 2,
  steps: [
    { action: { type: 'fill', selector: '#q', label: 'Search', value: 'askmingli', masked: false, ts: 1 }, description: 'type the query' },
    { action: { type: 'submit', selector: '#q', label: 'Search', ts: 2 }, name: 'Run search' },
    { action: { type: 'fill', selector: '#pw', label: 'Password', value: null, masked: true, ts: 3 } },
  ],
};

function provider(domain = 'duckduckgo.com'): RecipeProvider {
  return {
    currentDomain: () => domain,
    list: (d) => (d === 'duckduckgo.com' ? [{ name: recipe.name, description: recipe.description, domain: d, createdAt: 1, updatedAt: 2, steps: 3 }] : []),
    get: (d, n) => (d === 'duckduckgo.com' && n === recipe.name ? recipe : null),
  };
}

const tools = (p = provider()) => Object.fromEntries(createRecipeTools(p).map((t) => [t.name, t]));

test('list_recipes + get_recipe are Read-tier, low-risk, no approval', () => {
  for (const t of createRecipeTools(provider())) {
    assert.equal(t.requiresApproval, false);
    assert.equal(t.risk, 'low');
  }
});

test('list_recipes returns the current domain’s recipes', async () => {
  const out = (await tools().list_recipes.handler({}, ctx)) as { domain: string; recipes: unknown[] };
  assert.equal(out.domain, 'duckduckgo.com');
  assert.deepEqual(out.recipes, [{ name: 'Search AskMingLi', description: 'Search on DuckDuckGo and open the result', steps: 3 }]);
});

test('list_recipes is empty on a site with none', async () => {
  const out = (await tools(provider('example.com')).list_recipes.handler({}, ctx)) as { recipes: unknown[] };
  assert.deepEqual(out.recipes, []);
});

test('get_recipe returns annotated steps and WITHHOLDS sensitive values', async () => {
  const out = (await tools().get_recipe.handler({ name: 'Search AskMingLi' }, ctx)) as {
    steps: Array<{ n: number; action: string; value?: string; sensitive?: boolean; name?: string; description?: string }>;
  };
  assert.equal(out.steps.length, 3);
  assert.equal(out.steps[0].value, 'askmingli'); // non-sensitive value exposed
  assert.equal(out.steps[0].description, 'type the query');
  assert.match(out.steps[1].action, /press Enter/);
  assert.equal(out.steps[1].name, 'Run search');
  // The password fill: value withheld, flagged sensitive.
  assert.equal(out.steps[2].value, undefined);
  assert.equal(out.steps[2].sensitive, true);
  assert.match(out.steps[2].action, /sensitive/);
});

test('get_recipe returns an error for an unknown name', async () => {
  const out = (await tools().get_recipe.handler({ name: 'nope' }, ctx)) as { error?: string };
  assert.match(String(out.error), /no recipe named/);
});

test('get_recipe rejects empty/garbage input (fail closed)', () => {
  const { get_recipe } = tools();
  assert.throws(() => get_recipe.inputSchema.parse({}));
  assert.throws(() => get_recipe.inputSchema.parse({ name: '   ' }));
  assert.throws(() => get_recipe.inputSchema.parse('x'));
});
