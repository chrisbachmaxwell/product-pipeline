import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectMigrationStoreReadOnly, } from '../migration-store/projection.js';
import { loadMigrationAdminConfig } from '../migration-admin/config.js';
import { MIGRATION_RESPONSIBILITIES } from '../safety/responsibilities.js';
const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
function unavailableProjection(status, errorCode) {
    const blocker = {
        'not-configured': 'migration-state-not-configured',
        unavailable: 'migration-store-unavailable',
        invalid: 'migration-state-invalid',
    }[status];
    return {
        status,
        schemaVersion: null,
        scope: null,
        access: {
            writable: false,
            readOnly: true,
            externallyWired: false,
            externalWritesSupported: false,
            historicalBackfillAllowed: false,
        },
        counts: null,
        ownership: [],
        orders: {
            watermarkUtc: null,
            watermarkEstablished: false,
            eligibleForCreation: 0,
            historicalBackfillAllowed: false,
        },
        audit: {
            valid: false,
            recordCount: 0,
            headHash: null,
        },
        readiness: {
            canaryReady: false,
            cutoverReady: false,
            blockers: [blocker],
        },
        errorCode: errorCode ?? (status === 'not-configured'
            ? 'MIGRATION_STATE_NOT_CONFIGURED'
            : status === 'unavailable'
                ? 'MIGRATION_STATE_STORE_UNAVAILABLE'
                : 'MIGRATION_STATE_STORE_INVALID'),
    };
}
const COUNT_KEYS = [
    'externalIdentities',
    'orderWatermarks',
    'orderLinks',
    'orderPages',
    'orderObservations',
    'orderObservationResolutions',
    'cursorAdvances',
    'ownershipVersions',
    'idempotencyIntents',
    'actionApprovals',
    'approvalConsumptions',
    'executionJobs',
    'intentAttempts',
    'attemptResolutions',
    'reconciliationRuns',
    'reconciliationExceptions',
    'listingReviseObservations',
    'targetEffectObservations',
    'auditEvents',
];
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const SHOPIFY_DOMAIN = /^[a-z0-9][a-z0-9-]{0,62}\.myshopify\.com$/;
const MARKETPLACE = /^[A-Z][A-Z0-9_]{1,31}$/;
const BLOCKER = /^[a-z0-9][a-z0-9-]{0,95}$/;
function isExactUtc(value) {
    try {
        return new Date(value).toISOString() === value;
    }
    catch {
        return false;
    }
}
function normalizeVerifiedProjection(projection) {
    if (projection.status === 'unavailable')
        return unavailableProjection('unavailable');
    if (projection.status !== 'verified')
        return unavailableProjection('invalid');
    const scope = projection.scope;
    const counts = projection.counts;
    const expectedResponsibilities = [...MIGRATION_RESPONSIBILITIES];
    const ownership = projection.ownership;
    const audit = projection.audit;
    const orders = projection.orders;
    const readiness = projection.readiness;
    const access = projection.access;
    const ownershipValid = ownership.length === expectedResponsibilities.length &&
        ownership.every((entry, index) => entry.responsibility === expectedResponsibilities[index] &&
            typeof entry.configured === 'boolean' &&
            (entry.version === null || (Number.isSafeInteger(entry.version) && entry.version > 0)) &&
            (entry.owner === null || ['marketplace_connect', 'paused', 'product_pipeline'].includes(entry.owner)) &&
            typeof entry.singleWriterVerified === 'boolean' &&
            (entry.configured
                ? entry.version !== null && entry.owner !== null
                : entry.version === null && entry.owner === null && entry.singleWriterVerified === false));
    const countsValid = counts !== null && COUNT_KEYS.every((key) => Number.isSafeInteger(counts[key]) && counts[key] >= 0);
    const watermarkValid = orders.watermarkUtc === null || (typeof orders.watermarkUtc === 'string' &&
        isExactUtc(orders.watermarkUtc));
    const blockersValid = readiness.blockers.every((blocker) => typeof blocker === 'string' && BLOCKER.test(blocker));
    // A production watermark is acceptable only when the same projection shows
    // current ProductPipeline single-writer orderImport ownership — the
    // operator-recorded Marketplace Connect disable evidence chain. Any other
    // production watermark is invalid.
    const orderImportOwnership = ownership.find((entry) => entry.responsibility === 'orderImport');
    const productionWatermarkValid = scope?.ebayEnvironment !== 'production'
        || orders.watermarkUtc === null
        || (orderImportOwnership !== undefined
            && orderImportOwnership.configured === true
            && orderImportOwnership.owner === 'product_pipeline'
            && orderImportOwnership.singleWriterVerified === true);
    const contractValid = projection.schemaVersion === 4 &&
        scope !== null &&
        DIGEST.test(scope.scopeKey) &&
        SHOPIFY_DOMAIN.test(scope.shopifyStoreDomain) &&
        ['sandbox', 'production'].includes(scope.ebayEnvironment) &&
        MARKETPLACE.test(scope.ebayMarketplaceId) &&
        access.writable === false &&
        access.readOnly === true &&
        access.externallyWired === false &&
        access.externalWritesSupported === false &&
        access.historicalBackfillAllowed === false &&
        countsValid &&
        counts !== null &&
        counts.orderWatermarks === (orders.watermarkEstablished ? 1 : 0) &&
        ownershipValid &&
        orders.eligibleForCreation === 0 &&
        orders.historicalBackfillAllowed === false &&
        orders.watermarkEstablished === (orders.watermarkUtc !== null) &&
        watermarkValid &&
        productionWatermarkValid &&
        audit.valid === true &&
        Number.isSafeInteger(audit.recordCount) &&
        audit.recordCount > 0 &&
        typeof audit.headHash === 'string' &&
        DIGEST.test(audit.headHash) &&
        readiness.canaryReady === false &&
        readiness.cutoverReady === false &&
        blockersValid;
    const productionOwnershipValid = scope?.ebayEnvironment !== 'production' || ownership.every((entry) => {
        if (!entry.configured)
            return true;
        // Class A (no verified incumbent): listingCreate, listingRevise, and
        // listingEndRelist permit a paused/product_pipeline chain; Marketplace
        // Connect is never a valid owner for them.
        if (['listingCreate', 'listingRevise', 'listingEndRelist'].includes(entry.responsibility)) {
            return entry.owner !== 'marketplace_connect'
                && entry.singleWriterVerified === true;
        }
        // Class B (verified incumbent): orderImport, price, inventory, and fulfillment may
        // sit anywhere on the staged chain — the v1 Marketplace Connect
        // baseline remains valid — always with verified single-writer
        // evidence. mapping/feedback configured rows stay invalid.
        const baselineResponsibility = ['orderImport', 'price', 'inventory', 'fulfillment'].includes(entry.responsibility);
        return baselineResponsibility
            && entry.owner !== null
            && ['marketplace_connect', 'paused', 'product_pipeline'].includes(entry.owner)
            && entry.singleWriterVerified === true;
    });
    if (!contractValid ||
        !productionOwnershipValid ||
        !counts ||
        !scope ||
        typeof audit.headHash !== 'string') {
        return unavailableProjection('invalid');
    }
    return {
        status: 'verified',
        schemaVersion: 4,
        scope: {
            scopeKey: scope.scopeKey,
            shopifyStoreDomain: scope.shopifyStoreDomain,
            ebayEnvironment: scope.ebayEnvironment,
            ebayMarketplaceId: scope.ebayMarketplaceId,
        },
        access: {
            writable: false,
            readOnly: true,
            externallyWired: false,
            externalWritesSupported: false,
            historicalBackfillAllowed: false,
        },
        counts: Object.fromEntries(COUNT_KEYS.map((key) => [key, counts[key]])),
        ownership: ownership.map((entry) => ({
            responsibility: entry.responsibility,
            configured: entry.configured,
            version: entry.version,
            owner: entry.owner,
            singleWriterVerified: entry.singleWriterVerified,
        })),
        orders: {
            watermarkUtc: orders.watermarkUtc,
            watermarkEstablished: orders.watermarkEstablished,
            eligibleForCreation: 0,
            historicalBackfillAllowed: false,
        },
        audit: {
            valid: true,
            recordCount: audit.recordCount,
            headHash: audit.headHash,
        },
        readiness: {
            canaryReady: false,
            cutoverReady: false,
            blockers: readiness.blockers.map((blocker) => blocker),
        },
    };
}
/**
 * Request-time-only bridge from explicit server configuration to the inert
 * durable-state projection. It never returns config paths/digests or a store
 * handle, and every error is collapsed to a stable non-sensitive state.
 */
export async function readConfiguredMigrationState(options = {}) {
    const environment = options.environment ?? process.env;
    const requestedConfigPath = environment.MIGRATION_STATE_CONFIG_PATH;
    if (typeof requestedConfigPath !== 'string' || requestedConfigPath.trim() === '') {
        return unavailableProjection('not-configured');
    }
    let loaded;
    try {
        loaded = await (options.loadConfig ?? loadMigrationAdminConfig)({
            repoRoot: options.repositoryRoot ?? REPOSITORY_ROOT,
            requestedConfigPath,
        });
    }
    catch {
        return unavailableProjection('invalid', 'MIGRATION_STATE_CONFIG_INVALID');
    }
    try {
        const projection = (options.inspectStore ?? inspectMigrationStoreReadOnly)({
            databasePath: loaded.databaseAbsolutePath,
            expectedScope: loaded.config.scope,
        });
        return normalizeVerifiedProjection(projection);
    }
    catch {
        return unavailableProjection('invalid', 'MIGRATION_STATE_STORE_INVALID');
    }
}
