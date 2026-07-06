import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/** Where SafeCoBrowser writes its local control token + endpoint, for the CLI to discover. */
export function safecobrowserDir(): string {
  return path.join(os.homedir(), '.safecobrowser');
}

export interface Endpoint {
  url: string;
  token: string;
}

function ensureDir(): string {
  const dir = safecobrowserDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/** Load the persisted control token, creating a strong one on first run. */
export function loadOrCreateToken(): string {
  const file = path.join(ensureDir(), 'control-token');
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    // Require our exact format — 64 hex chars (256 bits). Anything weaker/foreign is
    // discarded and regenerated, so the surface can never rest on a low-entropy token.
    if (/^[0-9a-f]{64}$/.test(existing)) {
      // Repair loose perms (e.g. a file created under a permissive umask).
      if ((fs.statSync(file).mode & 0o077) !== 0) fs.chmodSync(file, 0o600);
      return existing;
    }
  } catch {
    /* not yet created or unreadable → recreate */
  }
  const token = randomBytes(32).toString('hex');
  fs.writeFileSync(file, token, { mode: 0o600 });
  return token;
}

/** Mint a fresh control token, overwriting the persisted one. Used by "Regenerate token" in
 *  Settings — it revokes any agent still holding the old token. */
export function regenerateToken(): string {
  const file = path.join(ensureDir(), 'control-token');
  const token = randomBytes(32).toString('hex');
  fs.writeFileSync(file, token, { mode: 0o600 });
  return token;
}

/** Publish the running server's URL + token so a separate CLI process can find it. */
export function writeEndpoint(ep: Endpoint): string {
  const file = path.join(ensureDir(), 'endpoint.json');
  fs.writeFileSync(file, JSON.stringify(ep, null, 2), { mode: 0o600 });
  return file;
}

export function readEndpoint(): Endpoint | null {
  try {
    const raw = fs.readFileSync(path.join(safecobrowserDir(), 'endpoint.json'), 'utf8');
    const ep = JSON.parse(raw) as Endpoint;
    return typeof ep.url === 'string' && typeof ep.token === 'string' ? ep : null;
  } catch {
    return null;
  }
}
