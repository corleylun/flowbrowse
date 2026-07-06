#!/usr/bin/env node
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { readEndpoint } from '../server/endpoint';
import { verifyAuditFile, AUDIT_FILENAME } from '../audit/file-sink';
import { resolveInvokeInput, extractTabFlag } from './invoke-input';

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (data += c));
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

/**
 * safecobrowser — a thin CLI client for a running SafeCoBrowser session. It auto-discovers the
 * local server via ~/.safecobrowser/endpoint.json and calls the same broker-gated control
 * API the MCP surface uses. Like every agent surface, it CANNOT change the permission
 * mode — that stays with the user's UI.
 */

const HELP = `safecobrowser — control a running SafeCoBrowser session

Usage:
  safecobrowser status                          show session status
  safecobrowser tools                           list available tools
  safecobrowser invoke <tool> [input] [--tab id]  invoke a tool through the broker
  safecobrowser audit [n]                       show the last n audit records (default 20)
  safecobrowser audit verify                    verify the audit log's tamper-evident hash chain

  invoke <input> is one of: a JSON literal, '-' to read JSON from stdin, or
  --input-file <path> (-f) to read it from a file — handy for large run_js scripts, e.g.:
    cat script.json | safecobrowser invoke run_js -
    safecobrowser invoke run_js --input-file script.json

  --tab <id> targets a tab other than the active one (an id from \`invoke list_tabs\`), e.g.:
    safecobrowser invoke read_page --tab t2

Notes:
  SafeCoBrowser must be running for status/tools/invoke. Tool calls are gated by the per-tab
  permission mode you set in the SafeCoBrowser UI; this CLI cannot raise that mode. --tab only
  changes WHICH tab is gated — that tab's own mode (default Off) still decides the outcome, and
  targeting a non-active tab is itself denied if the human turned off "Allow agent tab control".
  The audit commands read the local log and work even when SafeCoBrowser is not running.`;

function runAudit(rest: string[]): void {
  const file = path.join(os.homedir(), '.safecobrowser', AUDIT_FILENAME);
  if (rest[0] === 'verify') {
    const r = verifyAuditFile(file);
    console.log(
      r.ok
        ? `audit OK — ${r.checked} record(s) verified`
        : `audit TAMPERED — chain broken at record #${r.brokenAt} (${r.checked} ok before it)`,
    );
    process.exit(r.ok ? 0 : 2);
  }
  const n = Number(rest[0]) || 20;
  let lines: string[] = [];
  try {
    lines = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.length > 0);
  } catch {
    console.log('(no audit log yet)');
    return;
  }
  for (const line of lines.slice(-n)) {
    try {
      const rec = JSON.parse(line) as { seq: number; event: Record<string, unknown> };
      const e = rec.event;
      const when = new Date(e.ts as number).toISOString();
      const outcome = String(e.outcome).toUpperCase().padEnd(7);
      const extra = `${e.reason ? ` ${e.reason}` : ''}${e.detail ? ` — ${e.detail}` : ''}`;
      console.log(`#${rec.seq} ${when} ${outcome} <${e.tabId}> ${e.toolName} [${e.mode}]${extra}`);
    } catch {
      /* skip unparseable */
    }
  }
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);

  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    console.log(HELP);
    return;
  }

  // Audit reads the local log directly — no running server required.
  if (cmd === 'audit') {
    runAudit(rest);
    return;
  }

  const ep = readEndpoint();
  if (!ep) {
    console.error('SafeCoBrowser is not running (no ~/.safecobrowser/endpoint.json). Start SafeCoBrowser first.');
    process.exit(1);
  }
  const headers = { authorization: `Bearer ${ep.token}`, 'content-type': 'application/json' };

  switch (cmd) {
    case 'status': {
      const r = await fetch(`${ep.url}/api/status`, { headers });
      console.log(JSON.stringify(await r.json(), null, 2));
      return;
    }
    case 'tools': {
      const r = await fetch(`${ep.url}/api/tools`, { headers });
      console.log(JSON.stringify(await r.json(), null, 2));
      return;
    }
    case 'invoke': {
      const [tool, ...args] = rest;
      if (!tool) {
        console.error('usage: safecobrowser invoke <tool> [json | - | --input-file <path>] [--tab <id>]');
        process.exit(1);
      }
      let tab: string | undefined;
      let input: unknown = {};
      try {
        const extracted = extractTabFlag(args);
        tab = extracted.tab;
        input = await resolveInvokeInput(extracted.rest, {
          readFile: (p) => fs.readFileSync(p, 'utf8'),
          readStdin,
        });
      } catch (e) {
        console.error(e instanceof Error ? e.message : 'invalid input');
        process.exit(1);
      }
      const r = await fetch(`${ep.url}/api/invoke`, {
        method: 'POST',
        headers,
        body: JSON.stringify(tab === undefined ? { tool, input } : { tool, input, tab }),
      });
      const result = (await r.json()) as { ok?: boolean };
      console.log(JSON.stringify(result, null, 2));
      process.exit(result.ok ? 0 : 2);
      return;
    }
    default:
      console.error(`unknown command: ${cmd}\n\n${HELP}`);
      process.exit(1);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
