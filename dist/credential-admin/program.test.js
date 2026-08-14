import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PRODUCT_PIPELINE_SHOPIFY_IDENTITY } from '../shopify/production-identity.js';
import { PRODUCT_PIPELINE_PRODUCTION_RUNTIME, } from './config.js';
import { CANONICAL_SHOPIFY_SCOPE_TEXT } from './network.js';
import { fixedShopifyCredentialRotationFailure, ShopifyCredentialRotationError, } from './errors.js';
import { buildShopifyCredentialAdminProgram, executeShopifyCredentialDatabaseDiagnostic, executeShopifyCredentialRotation, executeShopifyCredentialRotationPreflight, executeShopifyCredentialRotationVerify, SHOPIFY_ROTATION_PREFLIGHT_OUTPUT, SHOPIFY_ROTATION_SUCCESS_OUTPUT, SHOPIFY_ROTATION_VERIFY_OUTPUT, } from './program.js';
import { LegacyShopifyTokenStore, readShopifyAuthTokenRowReadOnly, } from './store.js';
const roots = [];
const OLD_TOKEN = 'old-shopify-access-token-value';
const NEW_TOKEN = 'new-shopify-access-token-value';
const CLIENT_SECRET = 'new-production-client-secret';
const REFRESH_TOKEN = 'temporary-dashboard-refresh-token';
const LEGACY_SCOPE_ORDER = 'read_products,read_inventory,read_orders,read_fulfillments';
afterEach(() => {
    for (const root of roots.splice(0))
        fs.rmSync(root, { recursive: true, force: true });
});
function fixture(shopifyScope = null) {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'shopify-rotation-program-'));
    fs.chmodSync(root, 0o700);
    roots.push(root);
    const databasePath = path.join(root, 'ebaysync.db');
    const database = new Database(databasePath);
    database.exec(`
    CREATE TABLE auth_tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      platform TEXT NOT NULL UNIQUE,
      access_token TEXT NOT NULL,
      refresh_token TEXT,
      scope TEXT,
      expires_at INTEGER,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE TABLE unrelated_state (id INTEGER PRIMARY KEY, value TEXT NOT NULL);
  `);
    database.prepare(`INSERT INTO auth_tokens
      (platform, access_token, refresh_token, scope, expires_at, created_at, updated_at)
     VALUES ('shopify', ?, NULL, ?, NULL, 100, 200)`).run(OLD_TOKEN, shopifyScope);
    database.prepare(`INSERT INTO auth_tokens
      (platform, access_token, refresh_token, scope, expires_at, created_at, updated_at)
     VALUES ('ebay', 'ebay-token-value-long', 'ebay-refresh-value-long', 'sell.inventory', 999, 101, 201)`).run();
    database.prepare(`INSERT INTO unrelated_state VALUES (1, 'preserve')`).run();
    database.close();
    fs.chmodSync(databasePath, 0o600);
    return {
        databasePath,
        policy: {
            expectedDatabasePath: databasePath,
            backupDirectory: path.join(root, 'private', 'credential-backups', 'shopify'),
        },
        config: {
            databasePath: databasePath,
            clientId: PRODUCT_PIPELINE_SHOPIFY_IDENTITY.clientId,
            clientSecret: CLIENT_SECRET,
            previousClientSecret: 'old-production-client-secret',
            previousClientSecretExpiresAtEpochMs: Date.parse('2026-08-14T19:00:00.000Z'),
            refreshToken: REFRESH_TOKEN,
            storeDomain: PRODUCT_PIPELINE_SHOPIFY_IDENTITY.storeDomain,
            authorizationExpiresAtEpochMs: Date.parse('2026-08-14T19:00:00.000Z'),
        },
    };
}
function authority() {
    return {
        data: {
            shop: {
                id: PRODUCT_PIPELINE_SHOPIFY_IDENTITY.shopGid,
                myshopifyDomain: PRODUCT_PIPELINE_SHOPIFY_IDENTITY.storeDomain,
            },
            currentAppInstallation: {
                app: { apiKey: PRODUCT_PIPELINE_SHOPIFY_IDENTITY.clientId },
                accessScopes: PRODUCT_PIPELINE_SHOPIFY_IDENTITY.canonicalReadScopes
                    .map((handle) => ({ handle })),
            },
        },
    };
}
function json(value) {
    return new Response(JSON.stringify(value), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
    });
}
function diagnosticDependencies(loaded) {
    const fixedPath = PRODUCT_PIPELINE_PRODUCTION_RUNTIME.databasePath;
    const fixedParent = path.dirname(fixedPath);
    const actualParent = path.dirname(loaded.databasePath);
    const mapped = (value) => {
        const text = String(value);
        if (text === fixedPath)
            return loaded.databasePath;
        if (text === fixedParent)
            return actualParent;
        if (text.startsWith(fixedPath))
            return `${loaded.databasePath}${text.slice(fixedPath.length)}`;
        throw Object.assign(new Error('unexpected path'), { code: 'EPERM' });
    };
    return {
        filesystem: {
            lstatSync: ((value) => fs.lstatSync(mapped(value))),
            openSync: ((value, flags) => fs.openSync(mapped(value), flags)),
            fstatSync: fs.fstatSync,
            readSync: fs.readSync,
            closeSync: fs.closeSync,
        },
        openPrivateSnapshotReadOnly: (snapshot) => {
            expect(Buffer.isBuffer(snapshot)).toBe(true);
            return new Database(snapshot, { readonly: true });
        },
    };
}
function diagnosticEnvironment() {
    return {
        NODE_ENV: 'production',
        RAILWAY_PROJECT_ID: PRODUCT_PIPELINE_PRODUCTION_RUNTIME.projectId,
        RAILWAY_ENVIRONMENT_ID: PRODUCT_PIPELINE_PRODUCTION_RUNTIME.environmentId,
        RAILWAY_SERVICE_ID: PRODUCT_PIPELINE_PRODUCTION_RUNTIME.serviceId,
        DATABASE_PATH: PRODUCT_PIPELINE_PRODUCTION_RUNTIME.databasePath,
        SHOPIFY_CLIENT_ID: PRODUCT_PIPELINE_SHOPIFY_IDENTITY.clientId,
    };
}
async function filesBelow(directory) {
    const entries = await fs.promises.readdir(directory, { withFileTypes: true });
    const nested = await Promise.all(entries.map(async (entry) => {
        const resolved = path.join(directory, entry.name);
        return entry.isDirectory() ? filesBelow(resolved) : [resolved];
    }));
    return nested.flat();
}
describe('fixed-purpose Shopify credential administration', () => {
    it('exposes exact preflight, database diagnostic, rotate, and verify commands with no options', () => {
        const program = buildShopifyCredentialAdminProgram();
        expect(program.commands.map((command) => command.name())).toEqual([
            'preflight-shopify-access-token-rotation',
            'diagnose-shopify-credential-database',
            'rotate-shopify-access-token',
            'verify-shopify-access-token-rotation',
        ]);
        expect(program.commands.flatMap((command) => command.options)).toEqual([]);
    });
    it('denies database inspection before filesystem access when Production binding is wrong', () => {
        const lstatSync = vi.fn();
        expect(() => executeShopifyCredentialDatabaseDiagnostic({
            NODE_ENV: 'production',
            RAILWAY_PROJECT_ID: 'wrong',
        }, {
            filesystem: {
                lstatSync,
            },
        })).toThrow(expect.objectContaining({ code: 'configuration-denied' }));
        expect(lstatSync).not.toHaveBeenCalled();
    });
    it('emits one frozen value-free database diagnosis and sets failure exit only for a denied stage', async () => {
        const loaded = fixture();
        const output = [];
        const exitCodes = [];
        await buildShopifyCredentialAdminProgram({
            environment: diagnosticEnvironment(),
            databaseDiagnostic: diagnosticDependencies(loaded),
            output: (value) => output.push(value),
            setExitCode: (code) => exitCodes.push(code),
        }).parseAsync(['node', 'credential-admin', 'diagnose-shopify-credential-database']);
        expect(output).toHaveLength(1);
        expect(JSON.parse(output[0])).toMatchObject({
            status: 'database_diagnostic_verified',
            stage: 'verified',
            databaseWritesPerformed: 0,
            providerNetworkRequestsPerformed: 0,
            providerCredentialMutationsPerformed: 0,
            externalCommerceWritesPerformed: 0,
        });
        expect(exitCodes).toEqual([]);
        expect(output[0]).not.toContain(loaded.databasePath);
        expect(output[0]).not.toContain(PRODUCT_PIPELINE_PRODUCTION_RUNTIME.databasePath);
        expect(output[0]).not.toContain(OLD_TOKEN);
        fs.chmodSync(loaded.databasePath, 0o640);
        const deniedOutput = [];
        await buildShopifyCredentialAdminProgram({
            environment: diagnosticEnvironment(),
            databaseDiagnostic: diagnosticDependencies(loaded),
            output: (value) => deniedOutput.push(value),
            setExitCode: (code) => exitCodes.push(code),
        }).parseAsync(['node', 'credential-admin', 'diagnose-shopify-credential-database']);
        expect(JSON.parse(deniedOutput[0])).toMatchObject({
            status: 'database_diagnostic_failed_closed',
            stage: 'file-permissions-denied',
            databaseWritesPerformed: 0,
            providerNetworkRequestsPerformed: 0,
            externalCommerceWritesPerformed: 0,
        });
        expect(exitCodes).toEqual([1]);
    });
    it('performs preflight, backup, one rotation, fresh verify, CAS, reopen, and stored verify in order', async () => {
        const loaded = fixture(LEGACY_SCOPE_ORDER);
        const events = [];
        const fetchImpl = vi.fn(async (url, init) => {
            const text = String(url);
            if (text.endsWith('/admin/oauth/access_token')) {
                events.push('rotate');
                expect(fs.readdirSync(loaded.policy.backupDirectory)).toHaveLength(1);
                expect(readShopifyAuthTokenRowReadOnly(loaded.databasePath, loaded.databasePath).accessToken)
                    .toBe(OLD_TOKEN);
                return json({ access_token: NEW_TOKEN, scope: CANONICAL_SHOPIFY_SCOPE_TEXT });
            }
            const token = (init?.headers)['X-Shopify-Access-Token'];
            events.push(`verify:${token === OLD_TOKEN ? 'old' : 'new'}`);
            if (events.filter((event) => event === 'verify:new').length === 2) {
                expect(readShopifyAuthTokenRowReadOnly(loaded.databasePath, loaded.databasePath).accessToken)
                    .toBe(NEW_TOKEN);
            }
            return json(authority());
        });
        const dependencies = {
            now: () => new Date('2026-08-14T18:00:00.000Z'),
            network: { fetchImpl },
            openStore: (databasePath) => LegacyShopifyTokenStore.open(databasePath, loaded.policy),
            readStoredRow: (databasePath) => readShopifyAuthTokenRowReadOnly(databasePath, loaded.databasePath),
        };
        await expect(executeShopifyCredentialRotation(loaded.config, dependencies))
            .resolves.toEqual(SHOPIFY_ROTATION_SUCCESS_OUTPUT);
        expect(events).toEqual(['verify:old', 'rotate', 'verify:new', 'verify:new']);
        expect(fetchImpl).toHaveBeenCalledTimes(4);
        expect(fetchImpl.mock.calls.map(([url]) => String(url))).toEqual([
            'https://usedcameragear.myshopify.com/admin/api/2026-07/graphql.json',
            'https://usedcameragear.myshopify.com/admin/oauth/access_token',
            'https://usedcameragear.myshopify.com/admin/api/2026-07/graphql.json',
            'https://usedcameragear.myshopify.com/admin/api/2026-07/graphql.json',
        ]);
        expect(readShopifyAuthTokenRowReadOnly(loaded.databasePath, loaded.databasePath)).toMatchObject({
            accessToken: NEW_TOKEN,
            rawScope: CANONICAL_SHOPIFY_SCOPE_TEXT,
            scope: CANONICAL_SHOPIFY_SCOPE_TEXT,
        });
        const serializedOutput = JSON.stringify(SHOPIFY_ROTATION_SUCCESS_OUTPUT);
        expect(SHOPIFY_ROTATION_PREFLIGHT_OUTPUT).toMatchObject({
            providerCredentialMutationsPerformed: 0,
            temporaryRefreshTokenPersistedToDatabase: false,
            externalCommerceWritesPerformed: 0,
        });
        expect(SHOPIFY_ROTATION_SUCCESS_OUTPUT).toMatchObject({
            providerCredentialMutationsPerformed: 1,
            temporaryRefreshTokenPersistedToDatabase: false,
            externalCommerceWritesPerformed: 0,
        });
        expect(SHOPIFY_ROTATION_VERIFY_OUTPUT).toMatchObject({
            providerCredentialMutationsPerformed: 0,
            temporaryRefreshTokenPersistedToDatabase: false,
            externalCommerceWritesPerformed: 0,
        });
        for (const secret of [OLD_TOKEN, NEW_TOKEN, CLIENT_SECRET, REFRESH_TOKEN, loaded.databasePath]) {
            expect(serializedOutput).not.toContain(secret);
        }
    });
    it('provides separate fixed read-only preflight and reopened verification results', async () => {
        const loaded = fixture();
        const dependencies = {
            network: { fetchImpl: async () => json(authority()) },
            readStoredRow: (databasePath) => readShopifyAuthTokenRowReadOnly(databasePath, loaded.databasePath),
        };
        await expect(executeShopifyCredentialRotationPreflight(loaded.config, dependencies))
            .resolves.toEqual(SHOPIFY_ROTATION_PREFLIGHT_OUTPUT);
        await expect(executeShopifyCredentialRotationVerify(loaded.config, dependencies))
            .resolves.toEqual(SHOPIFY_ROTATION_VERIFY_OUTPUT);
    });
    it('does not issue a rotation or mutate the token row when the ACK loses its safe window after backup', async () => {
        const loaded = fixture();
        loaded.config = {
            ...loaded.config,
            authorizationExpiresAtEpochMs: Date.parse('2026-08-14T18:30:00.000Z'),
        };
        const times = [
            new Date('2026-08-14T18:00:00.000Z'),
            new Date('2026-08-14T18:15:00.001Z'),
        ];
        const fetchImpl = vi.fn(async (_url, _init) => json(authority()));
        await expect(executeShopifyCredentialRotation(loaded.config, {
            now: () => times.shift() ?? new Date('2026-08-14T18:15:00.001Z'),
            network: { fetchImpl },
            openStore: (databasePath) => LegacyShopifyTokenStore.open(databasePath, loaded.policy),
            readStoredRow: (databasePath) => readShopifyAuthTokenRowReadOnly(databasePath, loaded.databasePath),
        })).rejects.toMatchObject({ code: 'configuration-denied' });
        expect(fetchImpl).toHaveBeenCalledOnce();
        expect(String(fetchImpl.mock.calls[0]?.[0])).toContain('/graphql.json');
        expect(readShopifyAuthTokenRowReadOnly(loaded.databasePath, loaded.databasePath).accessToken)
            .toBe(OLD_TOKEN);
    });
    it('does not issue a rotation when the previous-secret overlap is missing or loses its safe window', async () => {
        for (const previous of [
            { previousClientSecret: null, previousClientSecretExpiresAtEpochMs: null },
            {
                previousClientSecret: 'old-production-client-secret',
                previousClientSecretExpiresAtEpochMs: Date.parse('2026-08-14T18:14:59.999Z'),
            },
        ]) {
            const loaded = fixture();
            loaded.config = { ...loaded.config, ...previous };
            const fetchImpl = vi.fn(async (_url, _init) => json(authority()));
            await expect(executeShopifyCredentialRotation(loaded.config, {
                now: () => new Date('2026-08-14T18:00:00.000Z'),
                network: { fetchImpl },
                openStore: (databasePath) => LegacyShopifyTokenStore.open(databasePath, loaded.policy),
                readStoredRow: (databasePath) => readShopifyAuthTokenRowReadOnly(databasePath, loaded.databasePath),
            })).rejects.toMatchObject({ code: 'configuration-denied' });
            expect(fetchImpl).toHaveBeenCalledOnce();
            expect(String(fetchImpl.mock.calls[0]?.[0])).toContain('/graphql.json');
            expect(readShopifyAuthTokenRowReadOnly(loaded.databasePath, loaded.databasePath).accessToken)
                .toBe(OLD_TOKEN);
        }
    });
    it('commits a verified provider token forward after dispatch even when wall time crosses the cutoff', async () => {
        const loaded = fixture();
        loaded.config = {
            ...loaded.config,
            authorizationExpiresAtEpochMs: Date.parse('2026-08-14T18:20:00.000Z'),
            previousClientSecretExpiresAtEpochMs: Date.parse('2026-08-14T18:20:00.000Z'),
        };
        let clock = new Date('2026-08-14T18:00:00.000Z');
        const fetchImpl = vi.fn(async (url) => {
            if (String(url).endsWith('/admin/oauth/access_token')) {
                return json({ access_token: NEW_TOKEN, scope: CANONICAL_SHOPIFY_SCOPE_TEXT });
            }
            if (fetchImpl.mock.calls.length === 3) {
                clock = new Date('2026-08-14T18:20:00.000Z');
            }
            return json(authority());
        });
        await expect(executeShopifyCredentialRotation(loaded.config, {
            now: () => clock,
            network: { fetchImpl },
            openStore: (databasePath) => LegacyShopifyTokenStore.open(databasePath, loaded.policy),
            readStoredRow: (databasePath) => readShopifyAuthTokenRowReadOnly(databasePath, loaded.databasePath),
        })).resolves.toEqual(SHOPIFY_ROTATION_SUCCESS_OUTPUT);
        expect(readShopifyAuthTokenRowReadOnly(loaded.databasePath, loaded.databasePath).accessToken)
            .toBe(NEW_TOKEN);
    });
    it('keeps the local row unchanged when fresh-token verification fails after remote issuance', async () => {
        const loaded = fixture();
        const fetchImpl = vi.fn()
            .mockResolvedValueOnce(json(authority()))
            .mockResolvedValueOnce(json({ access_token: NEW_TOKEN, scope: CANONICAL_SHOPIFY_SCOPE_TEXT }))
            .mockResolvedValueOnce(json({ ...authority(), errors: [{ message: 'denied' }] }));
        await expect(executeShopifyCredentialRotation(loaded.config, {
            now: () => new Date('2026-08-14T18:00:00.000Z'),
            network: { fetchImpl },
            openStore: (databasePath) => LegacyShopifyTokenStore.open(databasePath, loaded.policy),
            readStoredRow: (databasePath) => readShopifyAuthTokenRowReadOnly(databasePath, loaded.databasePath),
        })).rejects.toMatchObject({ code: 'verification-denied' });
        expect(fetchImpl).toHaveBeenCalledTimes(3);
        expect(readShopifyAuthTokenRowReadOnly(loaded.databasePath, loaded.databasePath).accessToken)
            .toBe(OLD_TOKEN);
    });
    it('keeps the standalone provider-write import boundary absent from the mounted server', async () => {
        const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
        const adminRoot = path.join(sourceRoot, 'credential-admin');
        const runtimeFiles = (await fs.promises.readdir(adminRoot)).filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts'));
        for (const file of runtimeFiles) {
            const source = await fs.promises.readFile(path.join(adminRoot, file), 'utf8');
            expect(source, file).not.toMatch(/from\s+['"]\.\.\/(?:server|sync|ebay|db|services|watcher|cli)\/|import\s*\(|require\s*\(|child_process|node:(?:http|https|net|dns)/);
        }
        const outsideAdmin = (await filesBelow(sourceRoot)).filter((file) => file.endsWith('.ts')
            && !file.endsWith('.test.ts')
            && !file.includes(`${path.sep}credential-admin${path.sep}`));
        for (const file of outsideAdmin) {
            const source = await fs.promises.readFile(file, 'utf8');
            expect(source, path.relative(sourceRoot, file)).not.toMatch(/credential-admin|SHOPIFY_ROTATION_REFRESH_TOKEN|rotate-shopify-access-token/);
        }
        const client = await fs.promises.readFile(path.join(sourceRoot, 'shopify/client.ts'), 'utf8');
        expect(client).not.toMatch(/SHOPIFY_PREVIOUS_CLIENT_SECRET|SHOPIFY_ROTATION_REFRESH_TOKEN/);
    });
    it('renders only fixed value-free failure codes', () => {
        const secret = 'must-never-appear-in-fixed-failure';
        expect(fixedShopifyCredentialRotationFailure(new ShopifyCredentialRotationError('token-row-denied'))).toBe('{"status":"failed_closed","code":"token-row-denied"}');
        const unexpected = fixedShopifyCredentialRotationFailure(new Error(secret));
        expect(unexpected).toBe('{"status":"failed_closed","code":"unexpected-denied"}');
        expect(unexpected).not.toContain(secret);
    });
    it('never reflects unknown compiled-entrypoint arguments while preserving clean help', () => {
        const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
        const entrypoint = path.resolve(sourceRoot, '../dist/credential-admin/index.js');
        const sentinel = 'dummy-secret-never-log';
        for (const args of [
            ['rotate-shopify-access-token', `--client-secret=${sentinel}`],
            [`unknown-${sentinel}`],
            ['preflight-shopify-access-token-rotation', sentinel],
            ['diagnose-shopify-credential-database', `--database=${sentinel}`],
            ['diagnose-shopify-credential-database', sentinel],
            ['rotate-shopify-access-token', '--', sentinel],
            ['verify-shopify-access-token-rotation', sentinel],
        ]) {
            const result = spawnSync(process.execPath, [entrypoint, ...args], {
                encoding: 'utf8',
                env: {},
            });
            expect(result.status).toBe(1);
            expect(result.stdout).toBe('');
            expect(result.stderr.trim()).toBe('{"status":"failed_closed","code":"unexpected-denied"}');
            expect(`${result.stdout}${result.stderr}${String(result.error ?? '')}`).not.toContain(sentinel);
        }
        const help = spawnSync(process.execPath, [entrypoint, '--help'], {
            encoding: 'utf8',
            env: {},
        });
        expect(help.status).toBe(0);
        expect(help.stderr).toBe('');
        expect(help.stdout).toContain('diagnose-shopify-credential-database');
        expect(help.stdout).toContain('rotate-shopify-access-token');
        expect(help.stdout).not.toContain('failed_closed');
    });
    it('has no npm credential-admin wrapper that can print raw operator arguments', () => {
        const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
        const repositoryRoot = path.resolve(sourceRoot, '..');
        const packageJson = JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'package.json'), 'utf8'));
        expect(packageJson.scripts).not.toHaveProperty('credential-admin');
        const npmCache = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'npm-no-admin-wrapper-'));
        roots.push(npmCache);
        const sentinel = 'package-argv-sentinel-never-reflect';
        const result = spawnSync('npm', ['run', 'credential-admin', '--', sentinel], {
            cwd: repositoryRoot,
            encoding: 'utf8',
            env: {
                ...process.env,
                npm_config_cache: npmCache,
                npm_config_logs_max: '0',
            },
        });
        expect(result.status).toBe(1);
        expect(`${result.stdout}${result.stderr}${String(result.error ?? '')}`).not.toContain(sentinel);
        expect(`${result.stdout}${result.stderr}`).not.toContain('tsx src/credential-admin/index.ts');
    });
});
