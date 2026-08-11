import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildOperatorProgram } from '../program.js';
import { runOperatorInspection } from '../preflight.js';
import { validConfig } from './fixtures.js';

const temporaryDirectories: string[] = [];

async function tempRepo(config = validConfig()): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'product-pipeline-preflight-'));
  temporaryDirectories.push(root);
  await fs.mkdir(path.join(root, '.git'));
  await fs.mkdir(path.join(root, 'config'));
  await fs.writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'product-pipeline', type: 'module' }),
  );
  await fs.writeFile(path.join(root, 'config/operator.json'), JSON.stringify(config));
  return root;
}

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      fs.rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe('operator preflight', () => {
  it('uses no network or application database and records a local audit result', async () => {
    const root = await tempRepo();
    const databaseSentinel = path.join(root, 'application-database-must-not-exist.db');
    const previousDatabasePath = process.env.DATABASE_PATH;
    process.env.DATABASE_PATH = databaseSentinel;
    const fetchSpy = vi.fn(() => {
      throw new Error('network access is forbidden');
    });
    vi.stubGlobal('fetch', fetchSpy);

    const result = await (async () => {
      try {
        return await runOperatorInspection({
          command: 'preflight',
          repoRoot: root,
          configPath: 'config/operator.json',
          now: () => new Date('2026-08-11T16:00:00.000Z'),
          createRunId: () => 'preflight-run',
        });
      } finally {
        if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
        else process.env.DATABASE_PATH = previousDatabasePath;
      }
    })();

    expect(result.status).toBe('configuration-safe');
    expect(result.guarantees).toEqual({
      mode: 'read-only',
      dryRun: true,
      externalNetworkAccess: false,
      externalWrites: false,
      historicalBackfill: false,
      orderImportEnabled: false,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    await expect(fs.stat(databaseSentinel)).rejects.toThrow();
    await expect(
      fs.stat(path.join(root, '.local', 'operator-audit', 'operator-cli.jsonl')),
    ).resolves.toBeDefined();
  });

  it('fails readiness on unknown ownership while keeping the command read-only', async () => {
    const base = validConfig();
    const root = await tempRepo({
      ...base,
      ownership: {
        ...base.ownership,
        listingRevise: {
          currentOwner: 'unverified',
          productPipelineAccess: 'read-only',
        },
      },
    });

    const result = await runOperatorInspection({
      command: 'ownership',
      repoRoot: root,
      configPath: 'config/operator.json',
    });

    expect(result.status).toBe('blocked');
    expect(result.blockers).toEqual(['ownership.listingRevise has no verified current owner']);
    expect(result.guarantees.externalWrites).toBe(false);
  });

  it('records a denial in the fallback audit when config validation fails', async () => {
    const root = await tempRepo({ ...validConfig(), writesEnabled: true } as unknown as ReturnType<
      typeof validConfig
    >);

    await expect(
      runOperatorInspection({
        command: 'preflight',
        repoRoot: root,
        configPath: 'config/operator.json',
      }),
    ).rejects.toThrow('writesEnabled');

    const auditText = await fs.readFile(
      path.join(root, '.local/operator-audit/operator-cli.jsonl'),
      'utf8',
    );
    expect(auditText).toContain('"outcome":"denied"');
    expect(auditText).not.toContain('writesEnabled');
  });

  it('exposes only preflight, ownership, and audit command groups', () => {
    const program = buildOperatorProgram({
      stdout: () => undefined,
      stderr: () => undefined,
      setExitCode: () => undefined,
    });

    expect(program.commands.map((command) => command.name())).toEqual([
      'preflight',
      'ownership',
      'reconcile',
      'audit',
    ]);
    for (const forbidden of ['sync', 'import', 'publish', 'write']) {
      expect(program.commands.map((command) => command.name())).not.toContain(forbidden);
    }
  });

  it('keeps production modules behind a static import boundary', async () => {
    const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const runtimeFiles = (await fs.readdir(sourceRoot)).filter((file) => file.endsWith('.ts'));
    const allowedExternalImports = new Set([
      'commander',
      'node:crypto',
      'node:fs/promises',
      'node:path',
      'node:url',
      '../safety/responsibilities.js',
    ]);

    for (const file of runtimeFiles) {
      const source = await fs.readFile(path.join(sourceRoot, file), 'utf8');
      const imports = [...source.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((match) => match[1]);
      expect(
        imports.every((specifier) => {
          if (allowedExternalImports.has(specifier)) return true;
          if (!/^\.\/[a-z0-9-]+\.js$/i.test(specifier)) return false;
          return runtimeFiles.includes(`${specifier.slice(2, -3)}.ts`);
        }),
        file,
      ).toBe(true);
      expect(source).not.toMatch(
        /(?:import\s*\(|require\s*\(|fetch\s*\(|getDb\s*\(|loadCredentials|SERVER_URL|syncOrders|node:(?:http|https|net|dns|child_process|worker_threads))/,
      );
    }

    const responsibilitySource = await fs.readFile(
      path.resolve(sourceRoot, '../safety/responsibilities.ts'),
      'utf8',
    );
    expect(responsibilitySource).not.toMatch(/(?:from\s+['"]|import\s*\(|require\s*\(|fetch\s*\()/);
  });

  it('defaults to dry-run and rejects a no-dry-run flag', async () => {
    const root = await tempRepo();
    const output: string[] = [];
    const errors: string[] = [];
    const exitCodes: number[] = [];
    const program = buildOperatorProgram({
      stdout: (message) => output.push(message),
      stderr: (message) => errors.push(message),
      setExitCode: (code) => exitCodes.push(code),
    });
    program.exitOverride();
    program.configureOutput({ writeOut: () => undefined, writeErr: () => undefined });

    await program.parseAsync(
      ['preflight', '--repo-root', root, '--config', 'config/operator.json', '--json'],
      { from: 'user' },
    );
    expect(JSON.parse(output[0]).guarantees.dryRun).toBe(true);
    expect(errors).toEqual([]);
    expect(exitCodes).toEqual([]);

    const unsafeProgram = buildOperatorProgram();
    unsafeProgram.exitOverride();
    unsafeProgram.commands.forEach((command) => command.exitOverride());
    unsafeProgram.configureOutput({ writeOut: () => undefined, writeErr: () => undefined });
    await expect(
      unsafeProgram.parseAsync(
        ['preflight', '--repo-root', root, '--config', 'config/operator.json', '--no-dry-run'],
        { from: 'user' },
      ),
    ).rejects.toMatchObject({ code: 'commander.unknownOption' });
  });
});
