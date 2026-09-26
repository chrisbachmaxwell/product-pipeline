/** L79: the connections vault — writable, isolated, shape-guarded. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const roots: string[] = [];
afterEach(() => {
  delete process.env.CONNECTIONS_DATABASE_PATH;
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

import * as module from './connections.js';

function freshVault(): void {
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
    process.env.ANTHROPIC_API_KEY = 'sk-ant-env-override-key-000000';
    try {
      expect(module.readAnthropicKey()).toEqual({
        key: 'sk-ant-env-override-key-000000', source: 'env',
      });
      expect(module.getAnthropicConnectionStatus()).toEqual({ connected: true, source: 'env' });
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
    }
  });
});
