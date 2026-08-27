import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMigrationStore, openMigrationStore, sha256Digest } from '../migration-store/index.js';
import { MIGRATION_RESPONSIBILITIES } from '../safety/responsibilities.js';
import { readConfiguredMigrationState } from './migration-state-reader.js';
const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporaryRoots = [];
afterEach(() => {
    for (const root of temporaryRoots.splice(0)) {
        fsSync.rmSync(root, { recursive: true, force: true });
    }
});
const SCOPE = {
    shopifyStoreDomain: 'usedcameragear.myshopify.com',
    ebayEnvironment: 'sandbox',
    ebaySellerId: 'scope-seller',
    ebayMarketplaceId: 'EBAY_US',
};
const VERIFIED = {
    status: 'verified',
    schemaVersion: 5,
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
        targetEffectObservations: 0,
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
    monitoring: {
        currentJobs: {
            reserved: 0, dispatching: 0, reconciliationRequired: 0,
            resolvedExisting: 0, confirmedMissing: 0, resolvedResidueRemoved: 0,
        },
        previousUtcDay: {
            dateUtc: '2026-08-25',
            windowStartUtc: '2026-08-25T00:00:00.000Z',
            windowEndUtc: '2026-08-26T00:00:00.000Z',
            writes: { performed: 0, succeeded: 0, failed: 0, unresolved: 0 },
            reconciliations: { passed: 0, blocked: 0, failed: 0 },
            exceptions: { info: 0, warning: 0, critical: 0 },
        },
    },
    readiness: {
        canaryReady: false,
        cutoverReady: false,
        blockers: ['external-writes-not-supported'],
    },
};
const PRODUCTION_SCOPE = {
    shopifyStoreDomain: 'usedcameragear.myshopify.com',
    ebayEnvironment: 'production',
    ebaySellerId: 'usedcameragear',
    ebayMarketplaceId: 'EBAY_US',
};
function createProductionDatabase() {
    const root = fsSync.mkdtempSync(path.join(os.tmpdir(), 'migration-reader-production-'));
    temporaryRoots.push(root);
    const databasePath = path.join(root, 'migration-state.sqlite');
    const store = createMigrationStore({
        databasePath,
        scope: PRODUCTION_SCOPE,
        createdAtUtc: '2026-08-26T10:00:00.000Z',
    });
    store.close();
    return databasePath;
}
async function readProductionDatabase(databasePath) {
    return readConfiguredMigrationState({
        environment: { MIGRATION_STATE_CONFIG_PATH: 'config/migration-state.production.json' },
        loadConfig: vi.fn(async () => ({
            config: { scope: PRODUCTION_SCOPE },
            databaseAbsolutePath: databasePath,
            scopeDigest: 'not-projected',
            configDigest: 'not-projected',
        })),
        now: () => new Date('2026-08-27T12:00:00.000Z'),
    });
}
function populateResolvedG10(databasePath) {
    const store = openMigrationStore({ databasePath, expectedScope: PRODUCTION_SCOPE });
    const variant = store.registerIdentity({
        platform: 'shopify', kind: 'variant', bindingKey: 'variant:g10-production-shape',
        storeDomain: PRODUCTION_SCOPE.shopifyStoreDomain,
        externalGid: 'gid://shopify/ProductVariant/54881767358755',
    }, { eventId: 'identity:g10-variant', occurredAtUtc: '2026-08-26T10:01:00.000Z' });
    const listing = store.registerIdentity({
        platform: 'ebay', kind: 'listing', bindingKey: 'listing:g10-production-shape',
        environment: 'production', sellerId: PRODUCTION_SCOPE.ebaySellerId,
        marketplaceId: PRODUCTION_SCOPE.ebayMarketplaceId, externalId: '147232036779',
    }, { eventId: 'identity:g10-listing', occurredAtUtc: '2026-08-26T10:02:00.000Z' });
    store.recordOwnershipVersion({
        responsibility: 'listingRevise', version: 1, owner: 'paused',
        singleWriterVerified: true, evidenceDigest: sha256Digest('g10-paused'),
        effectiveAtUtc: '2026-08-26T10:03:00.000Z', recordedAtUtc: '2026-08-26T10:03:00.000Z',
        audit: { eventId: 'ownership:g10:v1', occurredAtUtc: '2026-08-26T10:03:00.000Z' },
    });
    store.recordOwnershipVersion({
        responsibility: 'listingRevise', version: 2, owner: 'product_pipeline',
        singleWriterVerified: true, evidenceDigest: sha256Digest('g10-product-pipeline'),
        effectiveAtUtc: '2026-08-26T10:04:00.000Z', recordedAtUtc: '2026-08-26T10:04:00.000Z',
        audit: { eventId: 'ownership:g10:v2', occurredAtUtc: '2026-08-26T10:04:00.000Z' },
    });
    const intentKey = store.createIdempotencyIntent({
        action: 'revise_ebay_listing', sourceIdentityKey: variant.identityKey,
        targetIdentityKey: listing.identityKey, desiredStateDigest: sha256Digest('g10-manifest'),
        createdAtUtc: '2026-08-26T10:05:00.000Z',
        audit: { eventId: 'intent:g10', occurredAtUtc: '2026-08-26T10:05:00.000Z' },
    });
    const approvalToken = 'g10-production-shape-one-action-approval';
    const approvalEvidenceDigest = sha256Digest('g10-approval-evidence');
    store.issueActionApproval({
        approvalToken, intentKey, responsibility: 'listingRevise',
        targetIdentityKey: listing.identityKey, ownershipVersion: 2,
        issuedAtUtc: '2026-08-26T10:06:00.000Z', expiresAtUtc: '2026-08-26T10:16:00.000Z',
        evidenceDigest: approvalEvidenceDigest,
        audit: { eventId: 'approval:g10', occurredAtUtc: '2026-08-26T10:06:00.000Z' },
    });
    store.reserveExecutionJob({
        jobId: 'job:g10', approvalToken, intentKey, responsibility: 'listingRevise',
        targetIdentityKey: listing.identityKey, ownershipVersion: 2, approvalEvidenceDigest,
        reservedAtUtc: '2026-08-26T10:07:00.000Z', evidenceDigest: sha256Digest('g10-reserved'),
        audit: { eventId: 'job:g10:reserved', occurredAtUtc: '2026-08-26T10:07:00.000Z' },
    });
    store.markDispatchingOutcomeUnknown({
        jobId: 'job:g10', attemptId: 'attempt:g10', approvalToken, approvalEvidenceDigest,
        occurredAtUtc: '2026-08-26T10:08:00.000Z', evidenceDigest: sha256Digest('g10-dispatch'),
        audit: { eventId: 'job:g10:dispatch', occurredAtUtc: '2026-08-26T10:08:00.000Z' },
    });
    store.requirePostDispatchReconciliation({
        jobId: 'job:g10', attemptId: 'attempt:g10', occurredAtUtc: '2026-08-26T10:09:00.000Z',
        evidenceDigest: sha256Digest('g10-reconciliation-required'),
        audit: { eventId: 'job:g10:required', occurredAtUtc: '2026-08-26T10:09:00.000Z' },
    });
    for (const [ordinal, effect] of [
        [1, 'revised_state_absent'],
        [2, 'revised_state_absent'],
        [3, 'revised_state_observed'],
    ]) {
        const resultDigest = sha256Digest(`g10-result-${ordinal}`);
        const completedAtUtc = `2026-08-26T10:${String(9 + ordinal).padStart(2, '0')}:00.000Z`;
        store.recordReconciliationRun({
            runId: `reconciliation:g10:${ordinal}`, responsibility: 'listingRevise',
            targetIdentityKey: listing.identityKey, mode: 'production_canary', status: 'passed',
            sourceSnapshotDigest: sha256Digest(`g10-source-${ordinal}`),
            targetSnapshotDigest: sha256Digest(`g10-target-${ordinal}`), resultDigest,
            authoritative: true, authorityEvidenceDigest: sha256Digest(`g10-authority-${ordinal}`),
            externalWritesObserved: 0, startedAtUtc: completedAtUtc, completedAtUtc,
            exceptions: [],
            listingReviseObservation: {
                observationId: `observation:g10:${ordinal}`, intentKey, effect,
                observedDigest: sha256Digest(`g10-observed-${ordinal}`),
            },
            audit: { eventId: `reconciliation:g10:${ordinal}`, occurredAtUtc: completedAtUtc },
        });
    }
    store.resolveUnknownAttempt({
        jobId: 'job:g10', attemptId: 'attempt:g10', resolution: 'resolved_existing',
        reconciliationRunId: 'reconciliation:g10:3',
        reconciliationResultDigest: sha256Digest('g10-result-3'),
        reconciledAtUtc: '2026-08-26T10:13:00.000Z',
        audit: { eventId: 'resolution:g10', occurredAtUtc: '2026-08-26T10:13:00.000Z' },
    });
    store.close();
}
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
            nowUtc: expect.any(String),
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
    it('accepts the resolved Production G10 shape with canonical safe blockers', async () => {
        const databasePath = createProductionDatabase();
        populateResolvedG10(databasePath);
        const result = await readProductionDatabase(databasePath);
        expect(result).toMatchObject({
            status: 'verified',
            schemaVersion: 5,
            orders: { watermarkUtc: null, watermarkEstablished: false },
            audit: { valid: true },
            counts: {
                executionJobs: 1, intentAttempts: 1, attemptResolutions: 1,
                reconciliationRuns: 3, listingReviseObservations: 3,
            },
            monitoring: {
                currentJobs: { resolvedExisting: 1 },
                previousUtcDay: {
                    writes: { performed: 1, succeeded: 1, failed: 0, unresolved: 0 },
                    reconciliations: { passed: 3, blocked: 0, failed: 0 },
                },
            },
            readiness: {
                blockers: [
                    'ownership-order-import-unrecorded',
                    'ownership-price-unrecorded',
                    'ownership-inventory-unrecorded',
                    'ownership-listing-create-unrecorded',
                    'ownership-listing-end-relist-unrecorded',
                    'ownership-mapping-unrecorded',
                    'ownership-fulfillment-unrecorded',
                    'ownership-feedback-unrecorded',
                    'ownership-reconciliation-unrecorded',
                    'order-watermark-not-established',
                    'external-writes-not-supported',
                    'operator-cutover-approval-required',
                ],
            },
        });
        expect(JSON.stringify(result.readiness.blockers))
            .not.toMatch(/orderImport|listingCreate|listingEndRelist/);
    });
    it('accepts configured fulfillment as the fourth Production Class-B responsibility', async () => {
        const databasePath = createProductionDatabase();
        const store = openMigrationStore({ databasePath, expectedScope: PRODUCTION_SCOPE });
        for (const ownership of [
            { version: 1, owner: 'marketplace_connect', at: '2026-08-26T10:01:00.000Z' },
            { version: 2, owner: 'paused', at: '2026-08-26T10:02:00.000Z' },
            { version: 3, owner: 'product_pipeline', at: '2026-08-26T10:03:00.000Z' },
        ]) {
            store.recordOwnershipVersion({
                responsibility: 'fulfillment', version: ownership.version, owner: ownership.owner,
                singleWriterVerified: true,
                evidenceDigest: sha256Digest(`fulfillment-owner-${ownership.version}`),
                effectiveAtUtc: ownership.at, recordedAtUtc: ownership.at,
                audit: { eventId: `ownership:fulfillment:${ownership.version}`, occurredAtUtc: ownership.at },
            });
        }
        store.close();
        const result = await readProductionDatabase(databasePath);
        expect(result.status).toBe('verified');
        if (result.status !== 'verified')
            throw new Error('verified result required');
        expect(result.ownership.find((entry) => entry.responsibility === 'fulfillment'))
            .toEqual({
            responsibility: 'fulfillment', configured: true, version: 3,
            owner: 'product_pipeline', singleWriterVerified: true,
        });
        expect(result.readiness.blockers).not.toContain('ownership-fulfillment-unrecorded');
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
            'monitoring',
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
    it('rejects monitoring write buckets that do not partition one attempt cohort', async () => {
        const result = await readConfiguredMigrationState({
            environment: { MIGRATION_STATE_CONFIG_PATH: 'config/migration-state.json' },
            loadConfig: vi.fn(async () => ({
                config: { scope: SCOPE },
                databaseAbsolutePath: '/repo/.local/migration-state/product-pipeline-migration-v1.sqlite',
            })),
            inspectStore: vi.fn(() => ({
                ...VERIFIED,
                monitoring: {
                    ...VERIFIED.monitoring,
                    previousUtcDay: {
                        ...VERIFIED.monitoring.previousUtcDay,
                        writes: { performed: 1, succeeded: 1, failed: 0, unresolved: 1 },
                    },
                },
            })),
        });
        expect(result).toMatchObject({ status: 'invalid', monitoring: null });
    });
    it('accepts a production watermark only with ProductPipeline single-writer orderImport ownership', async () => {
        const watermarked = (orderImportOwner) => ({
            ...VERIFIED,
            scope: { ...VERIFIED.scope, ebayEnvironment: 'production' },
            counts: { ...VERIFIED.counts, orderWatermarks: 1, ownershipVersions: 3 },
            ownership: VERIFIED.ownership.map((entry) => entry.responsibility === 'orderImport'
                ? {
                    ...entry,
                    configured: true,
                    version: 3,
                    owner: orderImportOwner,
                    singleWriterVerified: true,
                }
                : entry),
            orders: {
                ...VERIFIED.orders,
                watermarkUtc: '2026-08-19T18:30:00.000Z',
                watermarkEstablished: true,
            },
        });
        const loadConfig = vi.fn(async () => ({
            config: { scope: { ...SCOPE, ebayEnvironment: 'production' } },
            databaseAbsolutePath: '/repo/.local/migration-state/product-pipeline-migration-v1.sqlite',
        }));
        const denied = await readConfiguredMigrationState({
            environment: { MIGRATION_STATE_CONFIG_PATH: 'config/migration-state.json' },
            loadConfig: loadConfig,
            inspectStore: vi.fn(() => watermarked('marketplace_connect')),
        });
        expect(denied).toMatchObject({
            status: 'invalid',
            orders: { watermarkUtc: null, watermarkEstablished: false, eligibleForCreation: 0 },
            readiness: { canaryReady: false, cutoverReady: false },
        });
        const accepted = await readConfiguredMigrationState({
            environment: { MIGRATION_STATE_CONFIG_PATH: 'config/migration-state.json' },
            loadConfig: loadConfig,
            inspectStore: vi.fn(() => watermarked('product_pipeline')),
        });
        expect(accepted).toMatchObject({
            status: 'verified',
            orders: {
                watermarkUtc: '2026-08-19T18:30:00.000Z',
                watermarkEstablished: true,
                eligibleForCreation: 0,
                historicalBackfillAllowed: false,
            },
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
