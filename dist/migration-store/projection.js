import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { CURRENT_SCHEMA_VERSION } from './schema.js';
import { openMigrationStoreReadOnly, PRODUCTION_ENABLED_RESPONSIBILITIES, } from './store.js';
import { MIGRATION_RESPONSIBILITIES, } from './types.js';
const ACCESS = Object.freeze({
    writable: false,
    readOnly: true,
    externallyWired: false,
    externalWritesSupported: false,
    historicalBackfillAllowed: false,
});
const RESPONSIBILITY_BLOCKER_SLUG = {
    orderImport: 'order-import',
    price: 'price',
    inventory: 'inventory',
    listingCreate: 'listing-create',
    listingRevise: 'listing-revise',
    listingEndRelist: 'listing-end-relist',
    mapping: 'mapping',
    fulfillment: 'fulfillment',
    feedback: 'feedback',
    reconciliation: 'reconciliation',
};
function deniedProjection(status) {
    return {
        status,
        schemaVersion: null,
        scope: null,
        access: ACCESS,
        counts: null,
        ownership: [],
        orders: {
            watermarkUtc: null,
            watermarkEstablished: false,
            eligibleForCreation: 0,
            historicalBackfillAllowed: false,
        },
        audit: { valid: false, recordCount: 0, headHash: null },
        monitoring: null,
        readiness: {
            canaryReady: false,
            cutoverReady: false,
            blockers: [
                status === 'unavailable'
                    ? 'migration-store-unavailable'
                    : 'migration-store-integrity-invalid',
                'external-writes-not-supported',
                'operator-cutover-approval-required',
            ],
        },
    };
}
function fixedCounts(counts) {
    return {
        externalIdentities: counts.external_identities,
        orderWatermarks: counts.order_watermarks,
        orderLinks: counts.order_links,
        orderPages: counts.order_pages,
        orderObservations: counts.order_observations,
        orderObservationResolutions: counts.order_observation_resolutions,
        cursorAdvances: counts.cursor_advances,
        ownershipVersions: counts.ownership_versions,
        idempotencyIntents: counts.idempotency_intents,
        actionApprovals: counts.action_approvals,
        approvalConsumptions: counts.approval_consumptions,
        executionJobs: counts.execution_jobs,
        intentAttempts: counts.intent_attempts,
        attemptResolutions: counts.attempt_resolutions,
        reconciliationRuns: counts.reconciliation_runs,
        reconciliationExceptions: counts.reconciliation_exceptions,
        listingReviseObservations: counts.listing_revise_observations,
        targetEffectObservations: counts.target_effect_observations,
        auditEvents: counts.audit_events,
    };
}
/**
 * Returns a fixed, redacted, non-authorizing view of a migration store. This
 * facade never returns the underlying handle, database path, raw rows,
 * approval identifiers, or verification error details.
 */
export function inspectMigrationStoreReadOnly(input) {
    try {
        if (typeof input.databasePath !== 'string'
            || input.databasePath.length === 0
            || input.databasePath.includes('\u0000')
            || input.databasePath.startsWith('file:')
            || input.databasePath === ':memory:'
            || !path.isAbsolute(input.databasePath)
            || path.resolve(input.databasePath) !== input.databasePath) {
            return deniedProjection('invalid');
        }
        try {
            fs.lstatSync(input.databasePath);
        }
        catch (error) {
            if (error.code === 'ENOENT') {
                return deniedProjection('unavailable');
            }
            return deniedProjection('invalid');
        }
        const store = openMigrationStoreReadOnly(input);
        try {
            const counts = fixedCounts(store.getCounts());
            const ownership = MIGRATION_RESPONSIBILITIES.map((responsibility) => {
                const current = store.getCurrentOwnership(responsibility);
                return {
                    responsibility,
                    configured: current !== null,
                    version: current?.version ?? null,
                    owner: current?.owner ?? null,
                    singleWriterVerified: current?.singleWriterVerified ?? false,
                };
            });
            const storedWatermark = store.getOrderWatermark();
            if (store.writable !== false
                || store.externallyWired !== false
                || store.externalWritesSupported !== false) {
                throw new Error('Read-only projection received a writable or externally wired store');
            }
            if (store.scope.ebayEnvironment === 'production') {
                // A production watermark is valid only once the operator has recorded
                // the ProductPipeline single-writer orderImport ownership chain (the
                // Marketplace Connect disable evidence); otherwise it is forbidden.
                const orderImportOwnership = ownership.find((entry) => entry.responsibility === 'orderImport');
                if (storedWatermark !== null
                    && !(orderImportOwnership?.configured === true
                        && orderImportOwnership.owner === 'product_pipeline'
                        && orderImportOwnership.singleWriterVerified === true)) {
                    throw new Error('Production migration state contains a forbidden watermark');
                }
                const noIncumbentResponsibilities = new Set([
                    'listingCreate',
                    'listingRevise',
                    'listingEndRelist',
                ]);
                const verifiedIncumbentResponsibilities = new Set([
                    'orderImport',
                    'price',
                    'inventory',
                    'fulfillment',
                ]);
                const stagedOwners = new Set(['marketplace_connect', 'paused', 'product_pipeline']);
                // Production execution authority is valid only for the reviewed
                // replacement slice: Class A chains that never name Marketplace
                // Connect, Class B chains staged from the v1 Marketplace Connect
                // baseline, and execution rows scoped exclusively to the seven enabled
                // writer responsibilities. Any other configured writer state
                // (mapping or feedback) is forbidden.
                const ownershipValid = ownership.every((entry) => {
                    if (!entry.configured)
                        return true;
                    if (noIncumbentResponsibilities.has(entry.responsibility)) {
                        return entry.owner !== 'marketplace_connect'
                            && entry.singleWriterVerified === true;
                    }
                    return verifiedIncumbentResponsibilities.has(entry.responsibility)
                        && entry.owner !== null
                        && stagedOwners.has(entry.owner)
                        && entry.singleWriterVerified === true;
                });
                if (!ownershipValid
                    || store.countExecutionRowsOutsideResponsibilities(PRODUCTION_ENABLED_RESPONSIBILITIES) !== 0) {
                    throw new Error('Production migration state contains forbidden execution authority');
                }
            }
            const watermark = storedWatermark;
            const audit = store.verifyAuditChain();
            const monitoring = store.getOperationalMonitoring(input.nowUtc ?? new Date().toISOString());
            const blockers = [
                ...ownership
                    .filter((entry) => !entry.configured)
                    .map((entry) => `ownership-${RESPONSIBILITY_BLOCKER_SLUG[entry.responsibility]}-unrecorded`),
                ...(watermark ? [] : ['order-watermark-not-established']),
                'external-writes-not-supported',
                'operator-cutover-approval-required',
            ];
            return {
                status: 'verified',
                schemaVersion: CURRENT_SCHEMA_VERSION,
                scope: {
                    scopeKey: store.scopeKey,
                    shopifyStoreDomain: store.scope.shopifyStoreDomain,
                    ebayEnvironment: store.scope.ebayEnvironment,
                    ebayMarketplaceId: store.scope.ebayMarketplaceId,
                },
                access: ACCESS,
                counts,
                ownership,
                orders: {
                    watermarkUtc: watermark?.boundaryExclusiveUtc ?? null,
                    watermarkEstablished: watermark !== null,
                    eligibleForCreation: 0,
                    historicalBackfillAllowed: false,
                },
                audit: {
                    valid: audit.valid,
                    recordCount: audit.recordCount,
                    headHash: audit.headHash,
                },
                monitoring,
                readiness: {
                    canaryReady: false,
                    cutoverReady: false,
                    blockers,
                },
            };
        }
        finally {
            store.close();
        }
    }
    catch {
        return deniedProjection('invalid');
    }
}
/**
 * READ-ONLY lookup for the operator's publish-recovery retry: the most
 * recent listing-create job targeting the SKU whose attempt has no recorded
 * resolution. Same database-path discipline as inspectMigrationStoreReadOnly;
 * opens read-only, runs one SELECT, writes nothing. The identifiers returned
 * are re-verified by the recovery ceremonies before any provider action.
 */
export function findUnresolvedListingCreateReadOnly(input) {
    const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/;
    const SHA256 = /^sha256:[0-9a-f]{64}$/;
    if (typeof input.databasePath !== 'string'
        || input.databasePath.length === 0
        || input.databasePath.startsWith('file:')
        || input.databasePath === ':memory:'
        || !path.isAbsolute(input.databasePath)
        || path.resolve(input.databasePath) !== input.databasePath
        || typeof input.sku !== 'string'
        || input.sku.length === 0
        || input.sku.length > 128) {
        return null;
    }
    try {
        const database = new Database(input.databasePath, { readonly: true, fileMustExist: true });
        try {
            const row = database.prepare('SELECT j.job_id AS jobId, a.attempt_id AS attemptId, j.intent_key AS intentKey, '
                + 'j.approval_evidence_digest AS evidenceDigest '
                + 'FROM execution_jobs j '
                + 'JOIN external_identities e ON e.identity_key = j.target_identity_key '
                + 'JOIN intent_attempts a ON a.job_id = j.job_id '
                + 'LEFT JOIN attempt_resolutions r ON r.attempt_id = a.attempt_id '
                + "WHERE e.binding_key = ? AND j.job_id LIKE 'listing-create-job:%' "
                + 'AND r.resolution_id IS NULL '
                + 'ORDER BY j.reserved_at_utc DESC LIMIT 1').get(`ebay-inventory-sku:${input.sku}`);
            if (!row)
                return null;
            const { jobId, attemptId, intentKey, evidenceDigest } = row;
            if (typeof jobId !== 'string' || !SAFE_ID.test(jobId)
                || typeof attemptId !== 'string' || !SAFE_ID.test(attemptId)
                || typeof intentKey !== 'string' || !SHA256.test(intentKey)
                || typeof evidenceDigest !== 'string' || !SHA256.test(evidenceDigest)) {
                return null;
            }
            return Object.freeze({ jobId, attemptId, intentKey, evidenceDigest });
        }
        finally {
            database.close();
        }
    }
    catch {
        return null;
    }
}
