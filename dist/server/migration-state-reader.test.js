import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { MIGRATION_RESPONSIBILITIES } from '../safety/responsibilities.js';
import { readConfiguredMigrationState } from './migration-state-reader.js';
const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCOPE = {
    shopifyStoreDomain: 'usedcameragear.myshopify.com',
    ebayEnvironment: 'sandbox',
    ebaySellerId: 'scope-seller',
    ebayMarketplaceId: 'EBAY_US',
};
const VERIFIED = {
    status: 'verified',
    schemaVersion: 2,
    scope: { ...SCOPE, scopeKey: `sha256:${'1'.repeat(64)}` },
    access: {
        writable: false,
        readOnly: true,
        externallyWired: false,
        externalWritesSupported: false,
        historicalBackfillAllowed: false,
    },
    counts: {
        externalIdentities: 0,
        orderWatermarks: 0,
        orderLinks: 0,
        orderPages: 0,
        orderObservations: 0,
        orderObservationResolutions: 0,
        cursorAdvances: 0,
        ownershipVersions: 0,
        idempotencyIntents: 0,
        actionApprovals: 0,
        approvalConsumptions: 0,
        executionJobs: 0,
        intentAttempts: 0,
        attemptResolutions: 0,
        reconciliationRuns: 0,
        reconciliationExceptions: 0,
        listingReviseObservations: 0,
        auditEvents: 1,
    },
    ownership: MIGRATION_RESPONSIBILITIES.map((responsibility) => ({
        responsibility,
        configured: false,
        version: null,
        owner: null,
        singleWriterVerified: false,
    })),
    orders: {
        watermarkUtc: null,
        watermarkEstablished: false,
        eligibleForCreation: 0,
        historicalBackfillAllowed: false,
    },
    audit: { valid: true, recordCount: 1, headHash: `sha256:${'2'.repeat(64)}` },
    readiness: {
        canaryReady: false,
        cutoverReady: false,
        blockers: ['external-writes-not-supported'],
    },
};
describe('request-time durable migration-state reader', () => {
    it('does not load a config or inspect a store when the explicit environment path is absent', async () => {
        const loadConfig = vi.fn();
        const inspectStore = vi.fn();
        const result = await readConfiguredMigrationState({
            environment: {},
            loadConfig: loadConfig,
            inspectStore: inspectStore,
        });
        expect(loadConfig).not.toHaveBeenCalled();
        expect(inspectStore).not.toHaveBeenCalled();
        expect(result).toMatchObject({
            status: 'not-configured',
            scope: null,
            counts: null,
            access: {
                writable: false,
                readOnly: true,
                externallyWired: false,
                externalWritesSupported: false,
                historicalBackfillAllowed: false,
            },
            orders: { eligibleForCreation: 0, watermarkUtc: null },
            readiness: { canaryReady: false, cutoverReady: false },
        });
    });
    it('loads and inspects only at invocation, then returns one normalized inert projection', async () => {
        const loadConfig = vi.fn(async () => ({
            config: { scope: SCOPE },
            databaseAbsolutePath: '/repo/.local/migration-state/product-pipeline-migration-v1.sqlite',
            scopeDigest: 'must-not-escape-scope-digest',
            configDigest: 'must-not-escape-config-digest',
        }));
        const inspectStore = vi.fn(() => VERIFIED);
        expect(loadConfig).not.toHaveBeenCalled();
        expect(inspectStore).not.toHaveBeenCalled();
        const result = await readConfiguredMigrationState({
            environment: { MIGRATION_STATE_CONFIG_PATH: 'config/migration-state.json' },
            repositoryRoot: '/repo',
            loadConfig: loadConfig,
            inspectStore: inspectStore,
        });
        expect(loadConfig).toHaveBeenCalledWith({
            repoRoot: '/repo',
            requestedConfigPath: 'config/migration-state.json',
        });
        expect(inspectStore).toHaveBeenCalledWith({
            databasePath: '/repo/.local/migration-state/product-pipeline-migration-v1.sqlite',
            expectedScope: SCOPE,
        });
        expect(result).toMatchObject({
            status: 'verified',
            access: {
                writable: false,
                readOnly: true,
                externallyWired: false,
                externalWritesSupported: false,
                historicalBackfillAllowed: false,
            },
            orders: { eligibleForCreation: 0, watermarkUtc: null },
            readiness: { canaryReady: false, cutoverReady: false },
        });
        expect(JSON.stringify(result)).not.toMatch(/databaseAbsolutePath|configDigest|scopeDigest|must-not-escape|\.local\/migration-state/);
        expect(JSON.stringify(result)).not.toContain('scope-seller');
    });
    it('deep-allowlists the projection so future internal or injected details cannot escape', async () => {
        const secret = 'must-not-escape-internal-detail';
        const inspectStore = vi.fn(() => ({
            ...VERIFIED,
            accessToken: secret,
            databasePath: `/private/${secret}.sqlite`,
            scope: {
                ...VERIFIED.scope,
                ebaySellerId: secret,
                internal: { secret },
            },
            counts: { ...VERIFIED.counts, internalSecrets: 7 },
            ownership: VERIFIED.ownership.map((entry) => ({
                ...entry,
                buyerEmail: `${secret}@example.com`,
            })),
            orders: { ...VERIFIED.orders, customerPayload: secret },
            audit: { ...VERIFIED.audit, rawSqliteError: secret },
            readiness: { ...VERIFIED.readiness, internalApproval: secret },
        }));
        const result = await readConfiguredMigrationState({
            environment: { MIGRATION_STATE_CONFIG_PATH: 'config/migration-state.json' },
            loadConfig: vi.fn(async () => ({
                config: { scope: SCOPE },
                databaseAbsolutePath: '/repo/.local/migration-state/product-pipeline-migration-v1.sqlite',
                scopeDigest: 'not-projected',
                configDigest: 'not-projected',
            })),
            inspectStore: inspectStore,
        });
        const serialized = JSON.stringify(result);
        expect(result.status).toBe('verified');
        expect(serialized).not.toMatch(/must-not-escape|accessToken|databasePath|ebaySellerId|internalSecrets|buyerEmail|customerPayload|rawSqliteError|internalApproval|scopeDigest|configDigest/i);
        expect(Object.keys(result)).toEqual([
            'status',
            'schemaVersion',
            'scope',
            'access',
            'counts',
            'ownership',
            'orders',
            'audit',
            'readiness',
        ]);
    });
    it('rejects inconsistent or hidden production watermark state', async () => {
        const result = await readConfiguredMigrationState({
            environment: { MIGRATION_STATE_CONFIG_PATH: 'config/migration-state.json' },
            loadConfig: vi.fn(async () => ({
                config: { scope: { ...SCOPE, ebayEnvironment: 'production' } },
                databaseAbsolutePath: '/repo/.local/migration-state/product-pipeline-migration-v1.sqlite',
            })),
            inspectStore: vi.fn(() => ({
                ...VERIFIED,
                scope: { ...VERIFIED.scope, ebayEnvironment: 'production' },
                counts: { ...VERIFIED.counts, orderWatermarks: 1 },
                orders: { ...VERIFIED.orders, watermarkUtc: null, watermarkEstablished: false },
            })),
        });
        expect(result).toMatchObject({
            status: 'invalid',
            orders: { watermarkUtc: null, watermarkEstablished: false, eligibleForCreation: 0 },
            readiness: { canaryReady: false, cutoverReady: false },
        });
    });
    it('collapses config failures to one redacted non-authorizing response', async () => {
        const secret = 'Bearer customer@example.com /private/migration.sqlite';
        const result = await readConfiguredMigrationState({
            environment: { MIGRATION_STATE_CONFIG_PATH: 'config/migration-state.json' },
            loadConfig: vi.fn(async () => { throw new Error(secret); }),
            inspectStore: vi.fn(() => { throw new Error(secret); }),
        });
        expect(result).toMatchObject({
            status: 'invalid',
            errorCode: 'MIGRATION_STATE_CONFIG_INVALID',
            scope: null,
            counts: null,
            orders: { eligibleForCreation: 0, watermarkUtc: null },
            readiness: { canaryReady: false, cutoverReady: false },
        });
        expect(JSON.stringify(result)).not.toMatch(/Bearer|customer@|private|sqlite/i);
    });
    it('collapses unexpected inspection failures without exposing config or store details', async () => {
        const secret = 'Bearer buyer@example.com /private/store.sqlite';
        const result = await readConfiguredMigrationState({
            environment: { MIGRATION_STATE_CONFIG_PATH: 'config/migration-state.json' },
            loadConfig: vi.fn(async () => ({
                config: { scope: SCOPE },
                databaseAbsolutePath: '/repo/.local/migration-state/product-pipeline-migration-v1.sqlite',
                scopeDigest: 'not-projected',
                configDigest: 'not-projected',
            })),
            inspectStore: vi.fn(() => { throw new Error(secret); }),
        });
        expect(result).toMatchObject({
            status: 'invalid',
            errorCode: 'MIGRATION_STATE_STORE_INVALID',
            scope: null,
            counts: null,
            orders: { eligibleForCreation: 0, watermarkUtc: null },
            readiness: { canaryReady: false, cutoverReady: false },
        });
        expect(JSON.stringify(result)).not.toMatch(/Bearer|buyer@|private|sqlite/i);
    });
    it('has no startup, writer, platform, credential, or default-store boundary', async () => {
        const [reader, route, server] = await Promise.all([
            fs.readFile(path.join(sourceRoot, 'server/migration-state-reader.ts'), 'utf8'),
            fs.readFile(path.join(sourceRoot, 'server/routes/migration.ts'), 'utf8'),
            fs.readFile(path.join(sourceRoot, 'server/index.ts'), 'utf8'),
        ]);
        expect(reader).toMatch(/MIGRATION_STATE_CONFIG_PATH/);
        expect(reader).toMatch(/migration-store\/projection\.js/);
        expect(reader).not.toMatch(/createMigrationStore|openMigrationStore(?:ReadOnly)?|migration-store\/(?:index|store)\.js|\bfetch\s*\(|token|credential/i);
        expect(route).toMatch(/await readConfiguredMigrationState\(\)/);
        expect(server).not.toMatch(/migration-state-reader|migration-store|MIGRATION_STATE_CONFIG_PATH/);
        const authIndex = server.indexOf("app.use('/api', apiKeyAuth)");
        const quarantineIndex = server.indexOf("app.use('/api', writerQuarantineMiddleware)");
        const routesIndex = server.indexOf('app.use(shadowApiRoutes)');
        expect(authIndex).toBeGreaterThan(-1);
        expect(quarantineIndex).toBeGreaterThan(authIndex);
        expect(routesIndex).toBeGreaterThan(quarantineIndex);
        const shadowRouter = await fs.readFile(path.join(sourceRoot, 'server/routes/shadow-api.ts'), 'utf8');
        expect(shadowRouter).toMatch(/res\.setHeader\('Cache-Control', 'no-store'\)/);
    });
});
