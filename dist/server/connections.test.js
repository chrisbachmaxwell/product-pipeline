/** L79: the connections vault — writable, isolated, shape-guarded. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// Hermetic env (L80): the resolvers read env FIRST, so a real key in the
// runner's environment (the incident-fix workflow sets ANTHROPIC_API_KEY)
// both failed these tests and printed the live secret in the assertion
// diff. Blank every override the module reads; empty string = unset.
beforeEach(() => {
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    vi.stubEnv('INCIDENT_GITHUB_TOKEN', '');
    vi.stubEnv('INCIDENT_GITHUB_REPO', '');
});
const roots = [];
afterEach(() => {
    vi.unstubAllEnvs();
    delete process.env.CONNECTIONS_DATABASE_PATH;
    for (const root of roots.splice(0))
        fs.rmSync(root, { recursive: true, force: true });
});
import * as module from './connections.js';
function freshVault() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'connections-vault-'));
    roots.push(root);
    process.env.CONNECTIONS_DATABASE_PATH = path.join(root, 'connections.sqlite');
}
describe('connections vault', () => {
    it('stores, resolves, and deletes both secrets round-trip', () => {
        freshVault();
        const key = `sk-ant-${'a'.repeat(40)}`;
        const token = `github_pat_${'b'.repeat(40)}`;
        expect(module.storeAnthropicKey(key)).toBe(true);
        expect(module.storeGithubToken(token)).toBe(true);
        expect(module.readAnthropicKey()).toEqual({ key, source: 'stored' });
        expect(module.readGithubToken()).toEqual({ token, source: 'stored' });
        expect(module.deleteStoredAnthropicKey()).toBe(true);
        expect(module.readAnthropicKey()).toBeNull();
        expect(module.readGithubToken()).toEqual({ token, source: 'stored' });
    });
    it('refuses malformed secrets and reads null from an absent vault', () => {
        freshVault();
        expect(module.storeAnthropicKey('sk-live-nope')).toBe(false);
        expect(module.storeGithubToken('not-a-token')).toBe(false);
        expect(module.readAnthropicKey()).toBeNull();
    });
    it('env secrets override the vault and report source env', () => {
        freshVault();
        module.storeAnthropicKey(`sk-ant-${'c'.repeat(40)}`);
        vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-env-override-key-000000');
        expect(module.readAnthropicKey()).toEqual({
            key: 'sk-ant-env-override-key-000000', source: 'env',
        });
        expect(module.getAnthropicConnectionStatus()).toEqual({ connected: true, source: 'env' });
    });
    it('starts every test with each env override blanked, whatever the runner holds', () => {
        // Order-dependent: runs after the override test above, proving its stub
        // did not leak (the old `finally { delete ... }` also erased a real
        // runner key for every later test in the worker; unstubAllEnvs restores).
        expect(process.env.ANTHROPIC_API_KEY).toBe('');
        expect(process.env.INCIDENT_GITHUB_TOKEN).toBe('');
        expect(process.env.INCIDENT_GITHUB_REPO).toBe('');
    });
});
