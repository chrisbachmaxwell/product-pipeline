import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadMigrationAdminConfig, MigrationAdminConfigError, parseMigrationAdminConfig, } from '../config.js';
import { buildMigrationAdminProgram, initializeMigrationStore, previewMigrationStoreInitialization, verifyMigrationStore, } from '../program.js';
const CREATED_AT = '2026-08-11T20:00:00.000Z';
const NOW = Date.parse('2026-08-11T21:00:00.000Z');
const CONFIG_PATH = 'config/migration-state.json';
const temporaryDirectories = [];
function validConfig() {
    return {
        schemaVersion: 1,
        project: 'product-pipeline',
        lane: 'sandbox',
        mode: 'migration-state-admin',
        databasePath: '.local/migration-state/product-pipeline-migration-v1.sqlite',
        scope: {
            shopifyStoreDomain: 'usedcameragear.myshopify.com',
            ebayEnvironment: 'sandbox',
            ebaySellerId: 'usedcam-0',
            ebayMarketplaceId: 'EBAY_US',
        },
        safety: {
            externalPlatformAccess: false,
            externalWrites: false,
            historicalBackfill: false,
            cutoverWatermarkUtc: null,
            ownershipTransferAllowed: false,
            credentialsAllowed: false,
        },
    };
}
function temporaryRepository(config = validConfig()) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'product-pipeline-migration-admin-'));
    temporaryDirectories.push(root);
    fs.mkdirSync(path.join(root, '.git'));
    fs.mkdirSync(path.join(root, 'config'));
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'product-pipeline' }));
    const configAbsolutePath = path.join(root, CONFIG_PATH);
    fs.writeFileSync(configAbsolutePath, JSON.stringify(config));
    return {
        root,
        configAbsolutePath,
        databasePath: path.join(root, '.local', 'migration-state', 'product-pipeline-migration-v1.sqlite'),
    };
}
function createDatabaseParent(root) {
    fs.mkdirSync(path.join(root, '.local', 'migration-state'), {
        recursive: true,
        mode: 0o700,
    });
}
function digest(filePath) {
    return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}
function entries(root) {
    return fs.readdirSync(root, { recursive: true, encoding: 'utf8' }).sort();
}
afterEach(() => {
    vi.unstubAllGlobals();
    for (const directory of temporaryDirectories.splice(0)) {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});
describe('migration-admin strict local boundary', () => {
    it('parses only the explicit inert schema and rejects unsafe lanes or safety flags', () => {
        expect(parseMigrationAdminConfig(validConfig())).toMatchObject({
            lane: 'sandbox',
            scope: { ebayEnvironment: 'sandbox' },
            safety: { externalWrites: false, historicalBackfill: false },
        });
        const unsafe = validConfig();
        unsafe.safety.externalWrites = true;
        expect(() => parseMigrationAdminConfig(unsafe)).toThrow(MigrationAdminConfigError);
        const drifted = validConfig();
        drifted.lane = 'production-shadow';
        expect(() => parseMigrationAdminConfig(drifted)).toThrow(/environment does not match/);
    });
    it('rejects credential-like and unknown fields without echoing attacker-controlled names or values', () => {
        const unsafe = {
            ...validConfig(),
            'token_super-secret-value': 'shpat_should-never-be-echoed',
        };
        let message = '';
        try {
            parseMigrationAdminConfig(unsafe);
        }
        catch (error) {
            message = error instanceof Error ? error.message : String(error);
        }
        expect(message).toMatch(/denied/);
        expect(message).not.toContain('token_super-secret-value');
        expect(message).not.toContain('shpat_should-never-be-echoed');
    });
    it('ships an intentionally invalid placeholder example that cannot bind a production scope', () => {
        const example = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'config', 'migration-state.example.json'), 'utf8'));
        expect(() => parseMigrationAdminConfig(example)).toThrow(MigrationAdminConfigError);
    });
    it('preview exits conceptually blocked and creates no directory or database', () => {
        const repository = temporaryRepository();
        const before = entries(repository.root);
        const preview = previewMigrationStoreInitialization({
            repoRoot: repository.root,
            configPath: CONFIG_PATH,
            createdAtUtc: CREATED_AT,
            now: NOW,
        });
        expect(preview.result.status).toBe('preview');
        expect(preview.result.projection).toBeNull();
        expect(entries(repository.root)).toEqual(before);
        expect(fs.existsSync(path.join(repository.root, '.local'))).toBe(false);
    });
    it('denies a wrong confirmation and a missing parent without creating state', () => {
        const wrong = temporaryRepository();
        createDatabaseParent(wrong.root);
        expect(() => initializeMigrationStore({
            repoRoot: wrong.root,
            configPath: CONFIG_PATH,
            createdAtUtc: CREATED_AT,
            confirmScope: `sha256:${'0'.repeat(64)}`,
            now: NOW,
        })).toThrow(/confirmation digest/);
        expect(fs.existsSync(wrong.databasePath)).toBe(false);
        const missingParent = temporaryRepository();
        const scopeDigest = loadMigrationAdminConfig({
            repoRoot: missingParent.root,
            requestedConfigPath: CONFIG_PATH,
        }).scopeDigest;
        expect(() => initializeMigrationStore({
            repoRoot: missingParent.root,
            configPath: CONFIG_PATH,
            createdAtUtc: CREATED_AT,
            confirmScope: scopeDigest,
            now: NOW,
        })).toThrow(/parent is missing/);
        expect(fs.existsSync(missingParent.databasePath)).toBe(false);
    });
    it('initializes exactly one inert store and never emits the seller identifier', () => {
        const repository = temporaryRepository();
        createDatabaseParent(repository.root);
        const scopeDigest = loadMigrationAdminConfig({
            repoRoot: repository.root,
            requestedConfigPath: CONFIG_PATH,
        }).scopeDigest;
        const result = initializeMigrationStore({
            repoRoot: repository.root,
            configPath: CONFIG_PATH,
            createdAtUtc: CREATED_AT,
            confirmScope: scopeDigest,
            now: NOW,
        });
        expect(result.status).toBe('initialized-inert');
        expect(result.projection).toMatchObject({
            status: 'verified',
            access: {
                writable: false,
                readOnly: true,
                externallyWired: false,
                externalWritesSupported: false,
                historicalBackfillAllowed: false,
            },
            orders: { watermarkEstablished: false, eligibleForCreation: 0 },
            audit: { valid: true, recordCount: 1 },
            readiness: { canaryReady: false, cutoverReady: false },
        });
        expect(result.projection?.counts).toMatchObject({
            auditEvents: 1,
            orderWatermarks: 0,
            idempotencyIntents: 0,
            executionJobs: 0,
            intentAttempts: 0,
        });
        expect(JSON.stringify(result)).not.toContain('usedcam-0');
        expect(fs.statSync(repository.databasePath).mode & 0o777).toBe(0o600);
        expect(fs.readdirSync(path.dirname(repository.databasePath))).toEqual([
            'product-pipeline-migration-v1.sqlite',
        ]);
        expect(() => initializeMigrationStore({
            repoRoot: repository.root,
            configPath: CONFIG_PATH,
            createdAtUtc: CREATED_AT,
            confirmScope: scopeDigest,
            now: NOW,
        })).toThrow(/target already exists/);
    });
    it('keeps a production-shadow initialization empty and unable to establish authority', () => {
        const config = validConfig();
        config.lane = 'production-shadow';
        config.scope.ebayEnvironment = 'production';
        const repository = temporaryRepository(config);
        createDatabaseParent(repository.root);
        const scopeDigest = loadMigrationAdminConfig({
            repoRoot: repository.root,
            requestedConfigPath: CONFIG_PATH,
        }).scopeDigest;
        const result = initializeMigrationStore({
            repoRoot: repository.root,
            configPath: CONFIG_PATH,
            createdAtUtc: CREATED_AT,
            confirmScope: scopeDigest,
            now: NOW,
        });
        expect(result.projection).toMatchObject({
            status: 'verified',
            counts: {
                ownershipVersions: 0,
                orderWatermarks: 0,
                idempotencyIntents: 0,
                actionApprovals: 0,
                executionJobs: 0,
                intentAttempts: 0,
                auditEvents: 1,
            },
            orders: { watermarkUtc: null, watermarkEstablished: false, eligibleForCreation: 0 },
            readiness: { canaryReady: false, cutoverReady: false },
        });
        expect(result.projection?.ownership.every((entry) => entry.configured === false)).toBe(true);
    });
    it('never invokes global fetch during preview, initialize, or verify', () => {
        const fetch = vi.fn(() => Promise.reject(new Error('network must remain unreachable')));
        vi.stubGlobal('fetch', fetch);
        const repository = temporaryRepository();
        const preview = previewMigrationStoreInitialization({
            repoRoot: repository.root,
            configPath: CONFIG_PATH,
            createdAtUtc: CREATED_AT,
            now: NOW,
        });
        createDatabaseParent(repository.root);
        initializeMigrationStore({
            repoRoot: repository.root,
            configPath: CONFIG_PATH,
            createdAtUtc: CREATED_AT,
            confirmScope: preview.loaded.scopeDigest,
            now: NOW,
        });
        verifyMigrationStore({ repoRoot: repository.root, configPath: CONFIG_PATH });
        expect(fetch).not.toHaveBeenCalled();
    });
    it('verify preserves database bytes, metadata, mode, and directory entries', () => {
        const repository = temporaryRepository();
        createDatabaseParent(repository.root);
        const loaded = loadMigrationAdminConfig({
            repoRoot: repository.root,
            requestedConfigPath: CONFIG_PATH,
        });
        initializeMigrationStore({
            repoRoot: repository.root,
            configPath: CONFIG_PATH,
            createdAtUtc: CREATED_AT,
            confirmScope: loaded.scopeDigest,
            now: NOW,
        });
        const before = fs.statSync(repository.databasePath);
        const beforeDigest = digest(repository.databasePath);
        const beforeEntries = entries(repository.root);
        const result = verifyMigrationStore({
            repoRoot: repository.root,
            configPath: CONFIG_PATH,
        });
        const after = fs.statSync(repository.databasePath);
        expect(result.status).toBe('verified');
        expect(digest(repository.databasePath)).toBe(beforeDigest);
        expect(after.size).toBe(before.size);
        expect(after.mtimeMs).toBe(before.mtimeMs);
        expect(after.mode).toBe(before.mode);
        expect(entries(repository.root)).toEqual(beforeEntries);
    });
    it.each(['-journal', '-wal', '-shm'])('rejects an existing %s sidecar before SQLite opens', (suffix) => {
        const repository = temporaryRepository();
        createDatabaseParent(repository.root);
        const loaded = loadMigrationAdminConfig({
            repoRoot: repository.root,
            requestedConfigPath: CONFIG_PATH,
        });
        initializeMigrationStore({
            repoRoot: repository.root,
            configPath: CONFIG_PATH,
            createdAtUtc: CREATED_AT,
            confirmScope: loaded.scopeDigest,
            now: NOW,
        });
        const before = fs.statSync(repository.databasePath);
        const beforeDigest = digest(repository.databasePath);
        const sidecar = `${repository.databasePath}${suffix}`;
        fs.writeFileSync(sidecar, 'sentinel');
        const beforeEntries = entries(repository.root);
        expect(() => verifyMigrationStore({
            repoRoot: repository.root,
            configPath: CONFIG_PATH,
        })).toThrow(/sidecar/);
        const after = fs.statSync(repository.databasePath);
        expect(digest(repository.databasePath)).toBe(beforeDigest);
        expect(after.mtimeMs).toBe(before.mtimeMs);
        expect(after.mode).toBe(before.mode);
        expect(entries(repository.root)).toEqual(beforeEntries);
        expect(fs.readFileSync(sidecar, 'utf8')).toBe('sentinel');
    });
    it('verify fails closed on missing or legacy data without creating or mutating it', () => {
        const missing = temporaryRepository();
        const before = entries(missing.root);
        expect(() => verifyMigrationStore({
            repoRoot: missing.root,
            configPath: CONFIG_PATH,
        })).toThrow(/unavailable/);
        expect(entries(missing.root)).toEqual(before);
        const legacy = temporaryRepository();
        createDatabaseParent(legacy.root);
        fs.writeFileSync(legacy.databasePath, 'legacy-app-database');
        fs.chmodSync(legacy.databasePath, 0o600);
        const beforeLegacy = fs.statSync(legacy.databasePath);
        const beforeDigest = digest(legacy.databasePath);
        const beforeEntries = entries(legacy.root);
        expect(() => verifyMigrationStore({
            repoRoot: legacy.root,
            configPath: CONFIG_PATH,
        })).toThrow(/integrity/);
        const afterLegacy = fs.statSync(legacy.databasePath);
        expect(digest(legacy.databasePath)).toBe(beforeDigest);
        expect(afterLegacy.mtimeMs).toBe(beforeLegacy.mtimeMs);
        expect(entries(legacy.root)).toEqual(beforeEntries);
    });
    it('rejects config and database parent symlink escapes without outside writes', () => {
        const repository = temporaryRepository();
        const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'product-pipeline-migration-outside-'));
        temporaryDirectories.push(outside);
        fs.unlinkSync(repository.configAbsolutePath);
        fs.symlinkSync(path.join(outside, 'missing-config.json'), repository.configAbsolutePath);
        expect(() => loadMigrationAdminConfig({
            repoRoot: repository.root,
            requestedConfigPath: CONFIG_PATH,
        })).toThrow(/non-symlink/);
        const second = temporaryRepository();
        fs.symlinkSync(outside, path.join(second.root, '.local'));
        expect(() => previewMigrationStoreInitialization({
            repoRoot: second.root,
            configPath: CONFIG_PATH,
            createdAtUtc: CREATED_AT,
            now: NOW,
        })).toThrow(/symbolic link/);
        expect(entries(outside)).toEqual([]);
    });
    it('rejects a hard-linked configuration file', () => {
        const repository = temporaryRepository();
        const hardLink = path.join(repository.root, 'config', 'hard-linked.json');
        fs.linkSync(repository.configAbsolutePath, hardLink);
        expect(() => loadMigrationAdminConfig({
            repoRoot: repository.root,
            requestedConfigPath: 'config/hard-linked.json',
        })).toThrow(/non-hard-linked/);
    });
    it('rejects dangling database targets and sidecars rather than following them', () => {
        const repository = temporaryRepository();
        createDatabaseParent(repository.root);
        const danglingTarget = path.join(repository.root, 'does-not-exist');
        fs.symlinkSync(danglingTarget, `${repository.databasePath}-journal`);
        expect(() => loadMigrationAdminConfig({
            repoRoot: repository.root,
            requestedConfigPath: CONFIG_PATH,
        })).toThrow(/sidecar/);
        expect(fs.existsSync(danglingTarget)).toBe(false);
    });
    it('rejects group/world-writable migration-state parent directories', () => {
        const repository = temporaryRepository();
        createDatabaseParent(repository.root);
        fs.chmodSync(path.join(repository.root, '.local'), 0o777);
        expect(() => loadMigrationAdminConfig({
            repoRoot: repository.root,
            requestedConfigPath: CONFIG_PATH,
        })).toThrow(/group\/world writable/);
        expect(fs.existsSync(repository.databasePath)).toBe(false);
    });
    it('rejects oversized, non-normalized, and future-dated inputs', () => {
        const oversized = temporaryRepository();
        fs.writeFileSync(oversized.configAbsolutePath, ' '.repeat(32 * 1024 + 1));
        expect(() => loadMigrationAdminConfig({
            repoRoot: oversized.root,
            requestedConfigPath: CONFIG_PATH,
        })).toThrow(/32 KiB/);
        const normalized = temporaryRepository();
        expect(() => loadMigrationAdminConfig({
            repoRoot: normalized.root,
            requestedConfigPath: 'config/../config/migration-state.json',
        })).toThrow(/exact normalized path/);
        expect(() => previewMigrationStoreInitialization({
            repoRoot: normalized.root,
            configPath: CONFIG_PATH,
            createdAtUtc: '2099-01-01T00:00:00.000Z',
            now: NOW,
        })).toThrow(/not in the future/);
    });
    it('exposes exactly init, upgrade, and verify and emits one JSON preview with exit code 2', async () => {
        const repository = temporaryRepository();
        const stdout = [];
        const stderr = [];
        const exitCodes = [];
        const program = buildMigrationAdminProgram({
            stdout: (message) => stdout.push(message),
            stderr: (message) => stderr.push(message),
            setExitCode: (code) => exitCodes.push(code),
        });
        program.exitOverride();
        expect(program.commands.map((command) => command.name())).toEqual(['init', 'upgrade', 'verify']);
        expect(JSON.stringify(program.commands.map((command) => command.options.map((option) => option.long))))
            .not.toMatch(/--live|--write|--force|--reset|--migrate|--watermark|--import|--job/);
        await program.parseAsync([
            'node',
            'migration-admin',
            'init',
            '--repo-root',
            repository.root,
            '--config',
            CONFIG_PATH,
            '--created-at',
            CREATED_AT,
            '--json',
        ]);
        expect(stderr).toEqual([]);
        expect(exitCodes).toEqual([2]);
        expect(stdout).toHaveLength(1);
        expect(JSON.parse(stdout[0])).toMatchObject({ command: 'init', status: 'preview' });
        expect(stdout[0]).not.toContain('usedcam-0');
        expect(fs.existsSync(path.join(repository.root, '.local'))).toBe(false);
    });
    it('upgrades only with the exact scope confirmation and reports already-current idempotently', async () => {
        const repository = temporaryRepository();
        const stdout = [];
        const stderr = [];
        const exitCodes = [];
        const io = {
            stdout: (message) => stdout.push(message),
            stderr: (message) => stderr.push(message),
            setExitCode: (code) => exitCodes.push(code),
        };
        createDatabaseParent(repository.root);
        const preview = previewMigrationStoreInitialization({
            repoRoot: repository.root,
            configPath: CONFIG_PATH,
            createdAtUtc: CREATED_AT,
            now: NOW,
        });
        initializeMigrationStore({
            repoRoot: repository.root,
            configPath: CONFIG_PATH,
            createdAtUtc: CREATED_AT,
            confirmScope: preview.loaded.scopeDigest,
            now: NOW,
        });
        const program = buildMigrationAdminProgram(io);
        program.exitOverride();
        await program.parseAsync([
            'node', 'migration-admin', 'upgrade',
            '--repo-root', repository.root,
            '--config', CONFIG_PATH,
            '--applied-at', CREATED_AT,
            '--confirm-scope', `sha256:${'f'.repeat(64)}`,
            '--json',
        ]);
        expect(exitCodes).toEqual([1]);
        expect(JSON.parse(stderr[0])).toMatchObject({ command: 'upgrade', status: 'denied' });
        await program.parseAsync([
            'node', 'migration-admin', 'upgrade',
            '--repo-root', repository.root,
            '--config', CONFIG_PATH,
            '--applied-at', CREATED_AT,
            '--confirm-scope', preview.loaded.scopeDigest,
            '--json',
        ]);
        expect(stdout).toHaveLength(1);
        expect(JSON.parse(stdout[0])).toMatchObject({
            command: 'upgrade',
            status: 'already-current',
            schemaUpgrade: { fromVersion: 3, toVersion: 3 },
        });
    });
    it('keeps migration-admin isolated from network, credentials, runtime, and legacy CLIs', () => {
        const runtimeRoot = path.join(process.cwd(), 'src', 'migration-admin');
        const runtimeFiles = ['config.ts', 'program.ts', 'index.ts'];
        for (const filename of runtimeFiles) {
            const source = fs.readFileSync(path.join(runtimeRoot, filename), 'utf8');
            expect(source).not.toMatch(/\bfetch\s*\(|process\.env|token-manager|shopify\/|ebay\/|sync\/|server\//);
        }
        for (const filename of ['src/cli/index.ts', 'src/operator-cli/index.ts']) {
            expect(fs.readFileSync(path.join(process.cwd(), filename), 'utf8')).not.toMatch(/migration-admin/);
        }
        expect(fs.readFileSync(path.join(process.cwd(), '.gitignore'), 'utf8'))
            .toMatch(/^config\/migration-state\.json$/m);
    });
});
