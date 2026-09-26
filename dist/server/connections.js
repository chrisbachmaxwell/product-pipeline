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
export function isPlausibleAnthropicKey(key) {
    return typeof key === 'string' && KEY_SHAPE.test(key);
}
export function readStoredAnthropicKey() {
    try {
        const database = openShadowDatabase();
        try {
            const row = database.prepare('SELECT access_token FROM auth_tokens WHERE platform = ?').get(PLATFORM);
            return row?.access_token && KEY_SHAPE.test(row.access_token) ? row.access_token : null;
        }
        finally {
            database.close();
        }
    }
    catch {
        return null;
    }
}
/** The one key resolver every AI feature uses: env override, then vault. */
export function readAnthropicKey() {
    const fromEnv = process.env.ANTHROPIC_API_KEY;
    if (typeof fromEnv === 'string' && fromEnv.length > 0) {
        return { key: fromEnv, source: 'env' };
    }
    const stored = readStoredAnthropicKey();
    return stored === null ? null : { key: stored, source: 'stored' };
}
export function getAnthropicConnectionStatus() {
    const resolved = readAnthropicKey();
    return Object.freeze({
        connected: resolved !== null,
        source: resolved?.source ?? null,
    });
}
/** Live validation: a models list is the cheapest authenticated read. */
export async function validateAnthropicKey(key) {
    try {
        const response = await fetch('https://api.anthropic.com/v1/models?limit=1', {
            headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
        });
        if (response.status === 200)
            return 'valid';
        if (response.status === 401 || response.status === 403)
            return 'unauthorized';
        return 'unreachable';
    }
    catch {
        return 'unreachable';
    }
}
export function storeAnthropicKey(key) {
    if (!isPlausibleAnthropicKey(key))
        return false;
    try {
        const database = openShadowDatabase();
        try {
            database.prepare('INSERT INTO auth_tokens (platform, access_token) VALUES (?, ?) '
                + 'ON CONFLICT(platform) DO UPDATE SET access_token = excluded.access_token, '
                + 'updated_at = unixepoch()').run(PLATFORM, key);
            return true;
        }
        finally {
            database.close();
        }
    }
    catch {
        return false;
    }
}
export function deleteStoredAnthropicKey() {
    try {
        const database = openShadowDatabase();
        try {
            database.prepare('DELETE FROM auth_tokens WHERE platform = ?').run(PLATFORM);
            return true;
        }
        finally {
            database.close();
        }
    }
    catch {
        return false;
    }
}
