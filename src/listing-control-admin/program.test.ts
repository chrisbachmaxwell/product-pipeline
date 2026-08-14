import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildListingControlAdminProgram } from './program.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

function target(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'listing-control-admin-'));
  fs.chmodSync(root, 0o700); roots.push(root);
  return path.join(root, 'listing-control.sqlite');
}

describe('listing control admin', () => {
  it('separates fresh init from read-only verify and reveals no path or credential', async () => {
    const databasePath = target();
    const output: string[] = [];
    const dependencies = { databasePath: () => databasePath,
      now: () => new Date('2026-08-13T20:00:00.000Z'), output: (value: string) => output.push(value) };
    await buildListingControlAdminProgram(dependencies).parseAsync(['node', 'admin', 'init']);
    expect(fs.statSync(databasePath).mode & 0o777).toBe(0o600);
    expect(JSON.parse(output[0]!)).toEqual({ status: 'initialized', schemaVersion: 2,
      mode: 'local_draft_only', externalWritesPerformed: 0 });
    const before = fs.readFileSync(databasePath);
    await expect(buildListingControlAdminProgram(dependencies)
      .parseAsync(['node', 'admin', 'init'])).rejects.toThrow();
    await buildListingControlAdminProgram(dependencies).parseAsync(['node', 'admin', 'verify']);
    expect(fs.readFileSync(databasePath)).toEqual(before);
    expect(JSON.stringify(output)).not.toContain(databasePath);
  });

  it('refuses verify when the file is absent and creates nothing', async () => {
    const databasePath = target();
    await expect(buildListingControlAdminProgram({ databasePath: () => databasePath })
      .parseAsync(['node', 'admin', 'verify'])).rejects.toThrow();
    expect(fs.existsSync(databasePath)).toBe(false);
  });
});
