import fs from 'node:fs';
import path from 'node:path';
import { CURRENT_SCHEMA_VERSION } from './schema.js';
import { openMigrationStoreReadOnly } from './store.js';
import { MIGRATION_RESPONSIBILITIES, } from './types.js';
const ACCESS = Object.freeze({
    writable: false,
    readOnly: true,
    externallyWired: false,
    externalWritesSupported: false,
    historicalBackfillAllowed: false,
});
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
                if (storedWatermark !== null) {
                    throw new Error('Production migration state contains a forbidden watermark');
                }
                const acceptedProductionResponsibilities = new Set([
                    'orderImport',
                    'price',
                    'inventory',
                ]);
                if (ownership.some((entry) => entry.configured
                    && (!acceptedProductionResponsibilities.has(entry.responsibility)
                        || entry.version !== 1
                        || entry.owner !== 'marketplace_connect'
                        || entry.singleWriterVerified !== true))
                    || counts.idempotencyIntents !== 0
                    || counts.actionApprovals !== 0
                    || counts.approvalConsumptions !== 0
                    || counts.executionJobs !== 0
                    || counts.intentAttempts !== 0
                    || counts.attemptResolutions !== 0) {
                    throw new Error('Production migration state contains forbidden execution authority');
                }
            }
            const watermark = storedWatermark;
            const audit = store.verifyAuditChain();
            const blockers = [
                ...ownership
                    .filter((entry) => !entry.configured)
                    .map((entry) => `ownership-${entry.responsibility}-unrecorded`),
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
