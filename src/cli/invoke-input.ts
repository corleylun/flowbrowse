/**
 * Resolve the JSON input for `safecobrowser invoke <tool> [...]` from one of:
 *   - a JSON literal arg:        invoke run_js '{"script":"…"}'
 *   - stdin (the `-` convention): cat big.json | invoke run_js -
 *   - a file:                     invoke run_js --input-file big.json   (or -f, or --input-file=big.json)
 *   - nothing → {}                invoke read_page
 *
 * Pure + dependency-injected so it's unit-testable without touching real stdin/fs.
 * Throws on a missing path or invalid JSON (the caller maps that to a usage error / exit 1).
 */
export interface InvokeInputIO {
  readFile: (path: string) => string;
  readStdin: () => Promise<string>;
}

/**
 * Pull an optional `--tab <id>` (or `--tab=<id>`) flag out of an `invoke` argv, wherever it
 * appears among the input args — leaving the rest untouched for `resolveInvokeInput`. Lets the
 * CLI target a background tab (an id from `list_tabs`) the same way the MCP/HTTP surfaces do.
 * Throws if `--tab` is given without a value.
 */
export function extractTabFlag(args: string[]): { tab?: string; rest: string[] } {
  const rest: string[] = [];
  let tab: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--tab') {
      const value = args[i + 1];
      if (value === undefined) throw new Error('--tab requires a value');
      tab = value;
      i++; // consume the value too
    } else if (a.startsWith('--tab=')) {
      tab = a.slice('--tab='.length);
    } else {
      rest.push(a);
    }
  }
  return { tab, rest };
}

export async function resolveInvokeInput(args: string[], io: InvokeInputIO): Promise<unknown> {
  const a0 = args[0];
  let raw: string | undefined;

  if (a0 === '-') {
    raw = await io.readStdin();
  } else if (a0 === '--input-file' || a0 === '-f') {
    if (!args[1]) throw new Error('--input-file requires a path');
    raw = io.readFile(args[1]);
  } else if (a0 && a0.startsWith('--input-file=')) {
    raw = io.readFile(a0.slice('--input-file='.length));
  } else if (a0 !== undefined) {
    raw = a0; // JSON literal
  }

  if (raw === undefined || raw.trim() === '') return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error('input must be valid JSON');
  }
}
