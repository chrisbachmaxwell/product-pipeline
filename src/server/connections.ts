/**
 * In-app API connections (L79): the operator connects the AI diagnosis
 * tier from Settings by pasting a key ONCE — no CLI, no env editing. The
 * key is validated live against the provider before it is accepted, then
 * stored in the app's existing credential vault (the shadow ledger's
 * auth_tokens table, exactly where the Shopify and eBay tokens live).
 * An env-provided ANTHROPIC_API_KEY always wins over the stored one so
 * operators retain the override; keys are never logged and never echoed
 * back to any client.
 */
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
/**
 * The app-managed connections vault. The legacy auth_tokens ledger is HARD
 * read-only from the server by design (query_only enforced — its writer is
 * the credential-admin ceremony), so operator-pasted AI/GitHub secrets get
 * their own store beside the app's other writable state. 0600, never in
 * the repo, logs, tests, or the migration store.
 */
function connectionsDbPath(): string {
  return process.env.CONNECTIONS_DATABASE_PATH
    ?? '/data/product-pipeline/connections.sqlite';
}

function openConnectionsStore(writable: boolean): InstanceType<typeof Database> | null {
  const databasePath = connectionsDbPath();
  try {
    if (writable) fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    const database = new Database(databasePath, writable
      ? {}
      : { readonly: true, fileMustExist: true });
    if (writable) {
      database.exec('CREATE TABLE IF NOT EXISTS connections ('
        + 'platform TEXT PRIMARY KEY, secret TEXT NOT NULL, '
        + "updated_at INTEGER NOT NULL DEFAULT (unixepoch()))");
      try { fs.chmodSync(databasePath, 0o600); } catch { /* best effort */ }
    }
    return database;
  } catch {
    return null;
  }
}

function readSecret(platform: string, shape: RegExp): string | null {
  const database = openConnectionsStore(false);
  if (database === null) return null;
  try {
    const row = database.prepare('SELECT secret FROM connections WHERE platform = ?')
      .get(platform) as { secret: string } | undefined;
    return row?.secret && shape.test(row.secret) ? row.secret : null;
  } catch {
    return null;
  } finally {
    database.close();
  }
}

function writeSecret(platform: string, secret: string): boolean {
  const database = openConnectionsStore(true);
  if (database === null) return false;
  try {
    database.prepare('INSERT INTO connections (platform, secret) VALUES (?, ?) '
      + 'ON CONFLICT(platform) DO UPDATE SET secret = excluded.secret, '
      + 'updated_at = unixepoch()').run(platform, secret);
    return true;
  } catch {
    return false;
  } finally {
    database.close();
  }
}

function deleteSecret(platform: string): boolean {
  const database = openConnectionsStore(true);
  if (database === null) return false;
  try {
    database.prepare('DELETE FROM connections WHERE platform = ?').run(platform);
    return true;
  } catch {
    return false;
  } finally {
    database.close();
  }
}

const KEY_SHAPE = /^sk-ant-[A-Za-z0-9_-]{10,250}$/;
const PLATFORM = 'anthropic';

export function isPlausibleAnthropicKey(key: unknown): key is string {
  return typeof key === 'string' && KEY_SHAPE.test(key);
}

export type AnthropicConnectionStatus = Readonly<{
  connected: boolean;
  /** 'env' = armed by environment (app cannot disconnect it); 'stored' = vault. */
  source: 'env' | 'stored' | null;
}>;

export function readStoredAnthropicKey(): string | null {
  return readSecret(PLATFORM, KEY_SHAPE);
}

/** The one key resolver every AI feature uses: env override, then vault. */
export function readAnthropicKey(): { key: string; source: 'env' | 'stored' } | null {
  const fromEnv = process.env.ANTHROPIC_API_KEY;
  if (typeof fromEnv === 'string' && fromEnv.length > 0) {
    return { key: fromEnv, source: 'env' };
  }
  const stored = readStoredAnthropicKey();
  return stored === null ? null : { key: stored, source: 'stored' };
}

export function getAnthropicConnectionStatus(): AnthropicConnectionStatus {
  const resolved = readAnthropicKey();
  return Object.freeze({
    connected: resolved !== null,
    source: resolved?.source ?? null,
  });
}

/** Live validation: a models list is the cheapest authenticated read. */
export async function validateAnthropicKey(key: string): Promise<'valid' | 'unauthorized' | 'unreachable'> {
  try {
    const response = await fetch('https://api.anthropic.com/v1/models?limit=1', {
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    });
    if (response.status === 200) return 'valid';
    if (response.status === 401 || response.status === 403) return 'unauthorized';
    return 'unreachable';
  } catch {
    return 'unreachable';
  }
}

export function storeAnthropicKey(key: string): boolean {
  if (!isPlausibleAnthropicKey(key)) return false;
  return writeSecret(PLATFORM, key);
}

export function deleteStoredAnthropicKey(): boolean {
  return deleteSecret(PLATFORM);
}

/* ------------------------- GitHub connection ------------------------- */

const GITHUB_PLATFORM = 'github';
const GITHUB_TOKEN_SHAPE = /^(github_pat_|ghp_)[A-Za-z0-9_]{20,255}$/;
const REPO_SHAPE = /^[\w.-]+\/[\w.-]+$/;

export function isPlausibleGithubToken(token: unknown): token is string {
  return typeof token === 'string' && GITHUB_TOKEN_SHAPE.test(token);
}

export function incidentGithubRepo(): string {
  const fromEnv = process.env.INCIDENT_GITHUB_REPO;
  return typeof fromEnv === 'string' && REPO_SHAPE.test(fromEnv)
    ? fromEnv : 'chrisbachmaxwell/product-pipeline';
}

function readStoredGithubToken(): string | null {
  return readSecret(GITHUB_PLATFORM, GITHUB_TOKEN_SHAPE);
}

/** Env override first, vault second — same contract as the Claude key. */
export function readGithubToken(): { token: string; source: 'env' | 'stored' } | null {
  const fromEnv = process.env.INCIDENT_GITHUB_TOKEN;
  if (typeof fromEnv === 'string' && fromEnv.length > 0) {
    return { token: fromEnv, source: 'env' };
  }
  const stored = readStoredGithubToken();
  return stored === null ? null : { token: stored, source: 'stored' };
}

export function getGithubConnectionStatus(): AnthropicConnectionStatus {
  const resolved = readGithubToken();
  return Object.freeze({ connected: resolved !== null, source: resolved?.source ?? null });
}

/**
 * Live validation: the token must SEE the incident repo. (Issue-write is
 * asked for in the UI instructions; a missing write scope surfaces on the
 * first real escalation and is logged, never silently swallowed.)
 */
export async function validateGithubToken(token: string): Promise<'valid' | 'unauthorized' | 'unreachable'> {
  try {
    const response = await fetch(`https://api.github.com/repos/${incidentGithubRepo()}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'ProductPipeline-incident-watchdog',
      },
    });
    if (response.status === 200) return 'valid';
    if (response.status === 401 || response.status === 403 || response.status === 404) {
      // 404 = token cannot even see the repo (fine-grained PAT scoped wrong).
      return 'unauthorized';
    }
    return 'unreachable';
  } catch {
    return 'unreachable';
  }
}

export function storeGithubToken(token: string): boolean {
  if (!isPlausibleGithubToken(token)) return false;
  return writeSecret(GITHUB_PLATFORM, token);
}

export function deleteStoredGithubToken(): boolean {
  return deleteSecret(GITHUB_PLATFORM);
}
