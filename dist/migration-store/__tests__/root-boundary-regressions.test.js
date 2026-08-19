import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMigrationStore, MigrationStoreError, openMigrationStoreReadOnly, sha256Digest, } from '../index.js';
const SANDBOX_SCOPE = {
    shopifyStoreDomain: 'usedcameragear.myshopify.com',
    ebayEnvironment: 'sandbox',
    ebaySellerId: 'usedcam-0',
    ebayMarketplaceId: 'EBAY_US',
};
const PRODUCTION_SCOPE = {
    ...SANDBOX_SCOPE,
    ebayEnvironment: 'production',
};
const temporaryDirectories = [];
function temporaryStorePath() {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'product-pipeline-migration-store-'));
    temporaryDirectories.push(directory);
    return { directory, databasePath: path.join(directory, 'migration-state.sqlite') };
}
function fileDigest(filePath) {
    return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}
afterEach(() => {
    vi.restoreAllMocks();
    for (const directory of temporaryDirectories.splice(0)) {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});
describe('migration-store filesystem and production boundary regressions', () => {
    it('remains isolated from runtime integrations and imports only its approved local boundary', () => {
        const repositoryRoot = process.cwd();
        const storeRoot = path.join(repositoryRoot, 'src', 'migration-store');
        const runtimeFiles = ['index.ts', 'projection.ts', 'schema.ts', 'store.ts', 'types.ts'];
        const approvedImports = new Set([
            'node:crypto',
            'node:fs',
            'node:path',
            'better-sqlite3',
            './projection.js',
            './schema.js',
            './store.js',
            './types.js',
            '../safety/responsibilities.js',
        ]);
        for (const filename of runtimeFiles) {
            const source = fs.readFileSync(path.join(storeRoot, filename), 'utf8');
            expect(source).not.toMatch(/\bfetch\s*\(|\bimport\s*\(|process\.env|credentials|token-manager/);
            for (const match of source.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)) {
                expect(approvedImports.has(match[1]), `${filename} imports ${match[1]}`).toBe(true);
            }
        }
        for (const tree of ['server', 'cli', 'sync', 'shopify', 'ebay', 'watcher', 'services']) {
            const treeRoot = path.join(repositoryRoot, 'src', tree);
            const entries = fs.readdirSync(treeRoot, { recursive: true, encoding: 'utf8' });
            for (const entry of entries) {
                if (!entry.endsWith('.ts') && !entry.endsWith('.tsx'))
                    continue;
                if (/\.(?:test|spec)\.[^.]+$/.test(entry))
                    continue;
                const source = fs.readFileSync(path.join(treeRoot, entry), 'utf8');
                if (tree === 'server' && entry === 'migration-state-reader.ts') {
                    expect(source).toMatch(/from ['"]\.\.\/migration-store\/projection\.js['"]/);
                    expect(source).not.toMatch(/migration-store\/(?:index|store)\.js|\bcreateMigrationStore\b|\bopenMigrationStore(?:ReadOnly)?\b/);
                    continue;
                }
                expect(source, `${tree}/${entry} imports the migration store`).not.toMatch(/migration-store/);
            }
        }
    });
    it('keeps tracked compiled artifacts aligned with the inert source boundary', () => {
        const distRoot = path.join(process.cwd(), 'dist');
        const store = fs.readFileSync(path.join(distRoot, 'migration-store', 'store.js'), 'utf8');
        const schema = fs.readFileSync(path.join(distRoot, 'migration-store', 'schema.js'), 'utf8');
        const shadowTransport = fs.readFileSync(path.join(distRoot, 'shadow-read', 'transport.js'), 'utf8');
        const projection = fs.readFileSync(path.join(distRoot, 'migration-store', 'projection.js'), 'utf8');
        const migrationStateReader = fs.readFileSync(path.join(distRoot, 'server', 'migration-state-reader.js'), 'utf8');
        const migrationRoute = fs.readFileSync(path.join(distRoot, 'server', 'routes', 'migration.js'), 'utf8');
        const migrationAdminConfig = fs.readFileSync(path.join(distRoot, 'migration-admin', 'config.js'), 'utf8');
        const migrationAdminProgram = fs.readFileSync(path.join(distRoot, 'migration-admin', 'program.js'), 'utf8');
        const migrationAdminIndex = fs.readFileSync(path.join(distRoot, 'migration-admin', 'index.js'), 'utf8');
        const packageValue = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'));
        expect(store).toMatch(/externalWritesSupported = false/);
        expect(store).toMatch(/Production watermark establishment is disabled/);
        expect(store).toMatch(/Production reconciliation is shadow-only/);
        expect(store).toMatch(/journal_mode = DELETE/);
        expect(store).not.toMatch(/\bfetch\s*\(|process\.env|token-manager/);
        expect(schema).toMatch(/production writer intents are disabled/);
        expect(schema).toMatch(/order import intent requires an eligible unresolved observation/);
        expect(schema).toMatch(/attempt resolution lacks authoritative target reconciliation/);
        expect(shadowTransport).toMatch(/fixtureOnly:\s*true/);
        expect(shadowTransport).toMatch(/liveProof:\s*false/);
        expect(shadowTransport).not.toMatch(/\bfetch\s*\(|process\.env|token-manager/);
        expect(projection).toMatch(/openMigrationStoreReadOnly/);
        expect(projection).not.toMatch(/createMigrationStore|\bfetch\s*\(|process\.env|token-manager/);
        expect(migrationStateReader).toMatch(/migration-store\/projection\.js/);
        expect(migrationStateReader).not.toMatch(/migration-store\/(?:index|store)\.js|createMigrationStore|\bfetch\s*\(/);
        expect(migrationRoute).toMatch(/readConfiguredMigrationState/);
        expect(packageValue.scripts?.['migration-admin']).toBe('tsx src/migration-admin/index.ts');
        expect(migrationAdminIndex).toMatch(/buildMigrationAdminProgram/);
        expect(migrationAdminProgram.match(/\.command\(['"]([^'"]+)['"]\)/g)).toEqual([
            ".command('init')",
            ".command('upgrade')",
            ".command('verify')",
        ]);
        expect(migrationAdminProgram).not.toMatch(/\.command\(['"](?:live|write|force|reset|migrate|watermark|import|job|sync|publish)['"]\)/);
        for (const source of [migrationAdminConfig, migrationAdminProgram, migrationAdminIndex]) {
            expect(source).not.toMatch(/\bfetch\s*\(|process\.env|token-manager|shopify\/|ebay\/|sync\/|server\//);
        }
    });
    it('opens a clean store read-only without changing bytes, metadata, or directory contents', () => {
        const { directory, databasePath } = temporaryStorePath();
        const store = createMigrationStore({
            databasePath,
            scope: SANDBOX_SCOPE,
            createdAtUtc: '2026-08-11T20:00:00.000Z',
        });
        store.close();
        const before = fs.statSync(databasePath);
        const beforeDigest = fileDigest(databasePath);
        expect(before.mode & 0o777).toBe(0o600);
        expect(fs.readdirSync(directory)).toEqual(['migration-state.sqlite']);
        const readOnly = openMigrationStoreReadOnly({ databasePath, expectedScope: SANDBOX_SCOPE });
        expect(readOnly.writable).toBe(false);
        expect(readOnly.externallyWired).toBe(false);
        expect(readOnly.externalWritesSupported).toBe(false);
        expect(readOnly.verifyAuditChain()).toMatchObject({ valid: true, recordCount: 1 });
        readOnly.close();
        const after = fs.statSync(databasePath);
        expect(fs.readdirSync(directory)).toEqual(['migration-state.sqlite']);
        expect(fileDigest(databasePath)).toBe(beforeDigest);
        expect(after.size).toBe(before.size);
        expect(after.mtimeMs).toBe(before.mtimeMs);
    });
    it('fails atomically when final publication fails', () => {
        const { directory, databasePath } = temporaryStorePath();
        vi.spyOn(fs, 'linkSync').mockImplementation(() => {
            throw new Error('injected publication failure');
        });
        expect(() => createMigrationStore({
            databasePath,
            scope: SANDBOX_SCOPE,
            createdAtUtc: '2026-08-11T20:00:00.000Z',
        })).toThrow(MigrationStoreError);
        expect(fs.existsSync(databasePath)).toBe(false);
        expect(fs.readdirSync(directory)).toEqual([]);
    });
    it('rejects replacement from a raw connection even when recursive triggers are disabled', () => {
        const { databasePath } = temporaryStorePath();
        const store = createMigrationStore({
            databasePath,
            scope: SANDBOX_SCOPE,
            createdAtUtc: '2026-08-11T20:00:00.000Z',
        });
        store.close();
        const raw = new Database(databasePath);
        try {
            raw.pragma('recursive_triggers = OFF');
            expect(raw.pragma('recursive_triggers', { simple: true })).toBe(0);
            expect(() => raw.prepare('INSERT OR REPLACE INTO integration_scope SELECT * FROM integration_scope').run()).toThrow(/replacement denied/);
        }
        finally {
            raw.close();
        }
    });
    it('keeps a production-scoped store inert and limits the accepted baseline', () => {
        const { databasePath } = temporaryStorePath();
        const store = createMigrationStore({
            databasePath,
            scope: PRODUCTION_SCOPE,
            createdAtUtc: '2026-08-11T20:00:00.000Z',
        });
        const acceptedEvidence = sha256Digest('accepted-marketplace-connect-baseline');
        store.recordOwnershipVersion({
            responsibility: 'orderImport',
            version: 1,
            owner: 'marketplace_connect',
            singleWriterVerified: true,
            evidenceDigest: acceptedEvidence,
            effectiveAtUtc: '2026-08-11T20:00:01.000Z',
            recordedAtUtc: '2026-08-11T20:00:01.000Z',
            audit: { eventId: 'production-order-baseline', occurredAtUtc: '2026-08-11T20:00:01.000Z' },
        });
        expect(() => store.recordOwnershipVersion({
            responsibility: 'listingCreate',
            version: 1,
            owner: 'marketplace_connect',
            singleWriterVerified: true,
            evidenceDigest: acceptedEvidence,
            effectiveAtUtc: '2026-08-11T20:00:02.000Z',
            recordedAtUtc: '2026-08-11T20:00:02.000Z',
            audit: { eventId: 'unsupported-production-baseline', occurredAtUtc: '2026-08-11T20:00:02.000Z' },
        })).toThrow(/Production ownership transfer is disabled/);
        expect(() => store.establishOrderWatermark({
            boundaryExclusiveUtc: '2026-08-11T20:00:00.000Z',
            ownershipVersion: 1,
            ownershipEvidenceDigest: acceptedEvidence,
            acceptedEvidenceDigest: acceptedEvidence,
            createdAtUtc: '2026-08-11T20:00:03.000Z',
            audit: { eventId: 'production-watermark-denied', occurredAtUtc: '2026-08-11T20:00:03.000Z' },
        })).toThrow(/Production watermark establishment is disabled/);
        expect(() => store.recordOwnershipVersion({
            responsibility: 'orderImport',
            version: 2,
            owner: 'paused',
            singleWriterVerified: true,
            evidenceDigest: sha256Digest('paused-production-owner'),
            effectiveAtUtc: '2026-08-11T20:00:04.000Z',
            recordedAtUtc: '2026-08-11T20:00:04.000Z',
            audit: { eventId: 'production-transfer-denied', occurredAtUtc: '2026-08-11T20:00:04.000Z' },
        })).toThrow(/Production ownership transfer is disabled/);
        expect(store.getCounts()).toMatchObject({
            ownership_versions: 1,
            order_watermarks: 0,
            idempotency_intents: 0,
            approval_consumptions: 0,
            execution_jobs: 0,
            intent_attempts: 0,
        });
        store.close();
    });
});
