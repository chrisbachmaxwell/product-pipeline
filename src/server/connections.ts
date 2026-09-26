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
import { openShadowDatabase } from './shadow-db.js';

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
  try {
    const database = openShadowDatabase();
    try {
      const row = database.prepare(
        'SELECT access_token FROM auth_tokens WHERE platform = ?',
      ).get(PLATFORM) as { access_token: string } | undefined;
      return row?.access_token && KEY_SHAPE.test(row.access_token) ? row.access_token : null;
    } finally {
      database.close();
    }
  } catch {
    return null;
  }
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
  try {
    const database = openShadowDatabase();
    try {
      database.prepare(
        'INSERT INTO auth_tokens (platform, access_token) VALUES (?, ?) '
        + 'ON CONFLICT(platform) DO UPDATE SET access_token = excluded.access_token, '
        + 'updated_at = unixepoch()',
      ).run(PLATFORM, key);
      return true;
    } finally {
      database.close();
    }
  } catch {
    return false;
  }
}

export function deleteStoredAnthropicKey(): boolean {
  try {
    const database = openShadowDatabase();
    try {
      database.prepare('DELETE FROM auth_tokens WHERE platform = ?').run(PLATFORM);
      return true;
    } finally {
      database.close();
    }
  } catch {
    return false;
  }
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
  try {
    const database = openShadowDatabase();
    try {
      const row = database.prepare(
        'SELECT access_token FROM auth_tokens WHERE platform = ?',
      ).get(GITHUB_PLATFORM) as { access_token: string } | undefined;
      return row?.access_token && GITHUB_TOKEN_SHAPE.test(row.access_token)
        ? row.access_token : null;
    } finally {
      database.close();
    }
  } catch {
    return null;
  }
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
  try {
    const database = openShadowDatabase();
    try {
      database.prepare(
        'INSERT INTO auth_tokens (platform, access_token) VALUES (?, ?) '
        + 'ON CONFLICT(platform) DO UPDATE SET access_token = excluded.access_token, '
        + 'updated_at = unixepoch()',
      ).run(GITHUB_PLATFORM, token);
      return true;
    } finally {
      database.close();
    }
  } catch {
    return false;
  }
}

export function deleteStoredGithubToken(): boolean {
  try {
    const database = openShadowDatabase();
    try {
      database.prepare('DELETE FROM auth_tokens WHERE platform = ?').run(GITHUB_PLATFORM);
      return true;
    } finally {
      database.close();
    }
  } catch {
    return false;
  }
}
