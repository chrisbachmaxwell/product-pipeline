/**
 * Pure, intentionally unwired evaluator for a future, separately authorized canary.
 * It has no adapters and can never authorize or perform an external write.
 */
import { WRITER_RESPONSIBILITIES, } from './responsibilities.js';
export const CANARY_RESPONSIBILITIES = WRITER_RESPONSIBILITIES;
export const CANARY_AUDIT_DESTINATION = 'local-append-only-canary-audit-v1';
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const SHOPIFY_VARIANT_PATTERN = /^gid:\/\/shopify\/ProductVariant\/[0-9]+$/;
const STORE_DOMAIN_PATTERN = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const EXTERNAL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const ACCOUNT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{1,79}$/;
const APPROVAL_ACTION_BY_RESPONSIBILITY = {
    listingCreate: 'create-listing',
    listingRevise: 'revise-listing',
    listingEndRelist: 'end-or-relist-listing',
    mapping: 'update-mapping',
    price: 'update-price',
    inventory: 'update-inventory',
    orderImport: 'import-order',
    fulfillment: 'sync-fulfillment',
    feedback: 'sync-feedback',
};
function canonicalTimestamp(value) {
    return value !== null && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value;
}
function nonempty(value) {
    return value.trim().length > 0 && value.length <= 256;
}
function addIf(blockers, condition, blocker) {
    if (condition)
        blockers.push(blocker);
}
export function evaluateCanaryReadiness(input) {
    const blockers = [];
    addIf(blockers, input.targets.length !== 1, 'scope.exactly-one-target-required');
    addIf(blockers, input.responsibilities.length !== 1, 'scope.exactly-one-responsibility-required');
    const target = input.targets.length === 1 ? input.targets[0] : null;
    const responsibility = input.responsibilities.length === 1 ? input.responsibilities[0] : null;
    if (target) {
        addIf(blockers, !IDENTIFIER_PATTERN.test(target.targetKey), 'target.key-invalid');
        addIf(blockers, !STORE_DOMAIN_PATTERN.test(target.shopifyStoreDomain), 'target.shopify-store-invalid');
        addIf(blockers, !['sandbox', 'production'].includes(target.ebayEnvironment), 'target.ebay-environment-invalid');
        addIf(blockers, !ACCOUNT_PATTERN.test(target.ebaySellerAccount), 'target.ebay-seller-invalid');
        addIf(blockers, target.marketplaceId !== 'EBAY_US', 'target.marketplace-invalid');
        if (target.kind === 'listing') {
            addIf(blockers, !SHOPIFY_VARIANT_PATTERN.test(target.shopifyVariantGid), 'target.shopify-variant-invalid');
            addIf(blockers, !IDENTIFIER_PATTERN.test(target.sku), 'target.sku-invalid');
            if (target.ebayListingId !== null) {
                addIf(blockers, !EXTERNAL_ID_PATTERN.test(target.ebayListingId), 'target.ebay-listing-invalid');
            }
        }
        else {
            addIf(blockers, !EXTERNAL_ID_PATTERN.test(target.ebayOrderId), 'target.ebay-order-invalid');
        }
    }
    if (target && responsibility) {
        const orderResponsibility = ['orderImport', 'fulfillment', 'feedback'].includes(responsibility);
        addIf(blockers, orderResponsibility !== (target.kind === 'order'), 'scope.target-responsibility-mismatch');
        if (target.kind === 'listing' && responsibility !== 'listingCreate') {
            addIf(blockers, target.ebayListingId === null, 'target.ebay-listing-required');
        }
    }
    addIf(blockers, !input.evidence.accepted, 'evidence.not-accepted');
    addIf(blockers, !DIGEST_PATTERN.test(input.evidence.evidenceDigest), 'evidence.digest-invalid');
    addIf(blockers, !DIGEST_PATTERN.test(input.evidence.ownershipVersion), 'evidence.ownership-version-invalid');
    addIf(blockers, !DIGEST_PATTERN.test(input.evidence.expectedBeforeDigest), 'evidence.expected-before-digest-invalid');
    addIf(blockers, !DIGEST_PATTERN.test(input.evidence.expectedAfterDigest), 'evidence.expected-after-digest-invalid');
    addIf(blockers, input.evidence.expectedBeforeDigest === input.evidence.expectedAfterDigest, 'evidence.expected-state-not-distinct');
    addIf(blockers, !canonicalTimestamp(input.evidence.observationWindow.startUtc), 'evidence.observation-start-invalid');
    addIf(blockers, !canonicalTimestamp(input.evidence.observationWindow.endUtc), 'evidence.observation-end-invalid');
    addIf(blockers, !canonicalTimestamp(input.evidence.acceptedAtUtc), 'evidence.accepted-time-invalid');
    if (target)
        addIf(blockers, input.evidence.targetKey !== target.targetKey, 'evidence.target-mismatch');
    if (responsibility)
        addIf(blockers, input.evidence.responsibility !== responsibility, 'evidence.responsibility-mismatch');
    addIf(blockers, input.singleWriter.incumbent === 'unverified', 'single-writer.incumbent-unverified');
    addIf(blockers, !input.singleWriter.incumbentVerified, 'single-writer.incumbent-verification-missing');
    addIf(blockers, !input.singleWriter.incumbentDisabledOrTransferredForScope, 'single-writer.scoped-disable-or-transfer-proof-missing');
    addIf(blockers, !input.singleWriter.productPipelineSoleWriterForScope, 'single-writer.product-pipeline-sole-writer-proof-missing');
    addIf(blockers, !DIGEST_PATTERN.test(input.singleWriter.proofDigest), 'single-writer.proof-digest-invalid');
    addIf(blockers, !DIGEST_PATTERN.test(input.singleWriter.ownershipVersion), 'single-writer.ownership-version-invalid');
    addIf(blockers, input.singleWriter.ownershipVersion !== input.evidence.ownershipVersion, 'single-writer.ownership-version-mismatch');
    if (target)
        addIf(blockers, input.singleWriter.targetKey !== target.targetKey, 'single-writer.target-mismatch');
    if (responsibility)
        addIf(blockers, input.singleWriter.responsibility !== responsibility, 'single-writer.responsibility-mismatch');
    addIf(blockers, !input.approval.approved, 'approval.not-approved');
    addIf(blockers, !nonempty(input.approval.approvalId), 'approval.id-invalid');
    if (responsibility) {
        addIf(blockers, input.approval.action !== APPROVAL_ACTION_BY_RESPONSIBILITY[responsibility], 'approval.action-responsibility-mismatch');
    }
    addIf(blockers, input.approval.evidenceDigest !== input.evidence.evidenceDigest, 'approval.evidence-mismatch');
    addIf(blockers, !DIGEST_PATTERN.test(input.approval.ownershipVersion), 'approval.ownership-version-invalid');
    addIf(blockers, input.approval.ownershipVersion !== input.evidence.ownershipVersion, 'approval.ownership-version-mismatch');
    addIf(blockers, !canonicalTimestamp(input.approval.approvedAtUtc), 'approval.approved-time-invalid');
    addIf(blockers, !canonicalTimestamp(input.approval.expiresAtUtc), 'approval.expiry-invalid');
    addIf(blockers, input.approval.usedAtUtc !== null, 'approval.already-used');
    if (target)
        addIf(blockers, input.approval.targetKey !== target.targetKey, 'approval.target-mismatch');
    if (responsibility)
        addIf(blockers, input.approval.responsibility !== responsibility, 'approval.responsibility-mismatch');
    if (canonicalTimestamp(input.nowUtc) && canonicalTimestamp(input.approval.expiresAtUtc)) {
        addIf(blockers, Date.parse(input.approval.expiresAtUtc) <= Date.parse(input.nowUtc), 'approval.expired');
    }
    else if (!canonicalTimestamp(input.nowUtc))
        blockers.push('evaluation.time-invalid');
    addIf(blockers, !input.idempotency.persisted, 'idempotency.not-persisted');
    addIf(blockers, !input.idempotency.uniqueConstraintVerified, 'idempotency.unique-constraint-unverified');
    addIf(blockers, input.idempotency.priorResult !== 'absent', 'idempotency.prior-result-not-absent');
    addIf(blockers, !nonempty(input.idempotency.key), 'idempotency.key-invalid');
    addIf(blockers, !DIGEST_PATTERN.test(input.idempotency.ownershipVersion), 'idempotency.ownership-version-invalid');
    addIf(blockers, input.idempotency.ownershipVersion !== input.evidence.ownershipVersion, 'idempotency.ownership-version-mismatch');
    if (target)
        addIf(blockers, input.idempotency.targetKey !== target.targetKey, 'idempotency.target-mismatch');
    if (responsibility)
        addIf(blockers, input.idempotency.responsibility !== responsibility, 'idempotency.responsibility-mismatch');
    addIf(blockers, !input.audit.appendOnly, 'audit.append-only-unverified');
    addIf(blockers, !input.audit.preflightRecorded, 'audit.preflight-missing');
    addIf(blockers, !DIGEST_PATTERN.test(input.audit.evidenceDigest), 'audit.evidence-digest-invalid');
    addIf(blockers, !DIGEST_PATTERN.test(input.audit.ownershipVersion), 'audit.ownership-version-invalid');
    addIf(blockers, input.audit.ownershipVersion !== input.evidence.ownershipVersion, 'audit.ownership-version-mismatch');
    addIf(blockers, input.audit.auditDestination !== CANARY_AUDIT_DESTINATION, 'audit.destination-invalid');
    if (target)
        addIf(blockers, input.audit.targetKey !== target.targetKey, 'audit.target-mismatch');
    if (responsibility)
        addIf(blockers, input.audit.responsibility !== responsibility, 'audit.responsibility-mismatch');
    addIf(blockers, !input.reconciliation.preActionClean, 'reconciliation.pre-action-not-clean');
    addIf(blockers, !input.reconciliation.postActionRequired, 'reconciliation.post-action-not-required');
    addIf(blockers, !DIGEST_PATTERN.test(input.reconciliation.evidenceDigest), 'reconciliation.evidence-digest-invalid');
    addIf(blockers, !DIGEST_PATTERN.test(input.reconciliation.ownershipVersion), 'reconciliation.ownership-version-invalid');
    addIf(blockers, input.reconciliation.ownershipVersion !== input.evidence.ownershipVersion, 'reconciliation.ownership-version-mismatch');
    if (target)
        addIf(blockers, input.reconciliation.targetKey !== target.targetKey, 'reconciliation.target-mismatch');
    if (responsibility)
        addIf(blockers, input.reconciliation.responsibility !== responsibility, 'reconciliation.responsibility-mismatch');
    addIf(blockers, !input.rollback.documented, 'rollback.not-documented');
    addIf(blockers, !input.rollback.rehearsed, 'rollback.not-rehearsed');
    addIf(blockers, !input.rollback.immediateDisableVerified, 'rollback.immediate-disable-unverified');
    addIf(blockers, !DIGEST_PATTERN.test(input.rollback.evidenceDigest), 'rollback.evidence-digest-invalid');
    addIf(blockers, !DIGEST_PATTERN.test(input.rollback.ownershipVersion), 'rollback.ownership-version-invalid');
    addIf(blockers, input.rollback.ownershipVersion !== input.evidence.ownershipVersion, 'rollback.ownership-version-mismatch');
    if (target)
        addIf(blockers, input.rollback.targetKey !== target.targetKey, 'rollback.target-mismatch');
    if (responsibility)
        addIf(blockers, input.rollback.responsibility !== responsibility, 'rollback.responsibility-mismatch');
    addIf(blockers, input.orderSafety.historicalBackfill !== false, 'orders.historical-backfill-not-disabled');
    if (responsibility === 'orderImport') {
        addIf(blockers, !input.orderSafety.applicable, 'orders.watermark-evidence-not-applicable');
        addIf(blockers, !input.orderSafety.persisted, 'orders.watermark-not-persisted');
        addIf(blockers, !input.orderSafety.immutable, 'orders.watermark-not-immutable');
        addIf(blockers, input.orderSafety.ebayEnvironment !== target?.ebayEnvironment, 'orders.watermark-environment-mismatch');
        addIf(blockers, input.orderSafety.ebaySellerAccount !== target?.ebaySellerAccount, 'orders.watermark-seller-mismatch');
        addIf(blockers, input.orderSafety.shopifyStoreDomain !== target?.shopifyStoreDomain, 'orders.watermark-store-mismatch');
        addIf(blockers, !input.orderSafety.ownershipVersion || !DIGEST_PATTERN.test(input.orderSafety.ownershipVersion), 'orders.watermark-ownership-version-invalid');
        addIf(blockers, input.orderSafety.ownershipVersion !== input.evidence.ownershipVersion, 'orders.watermark-ownership-version-mismatch');
        addIf(blockers, !input.orderSafety.evidenceDigest || !DIGEST_PATTERN.test(input.orderSafety.evidenceDigest), 'orders.watermark-evidence-digest-invalid');
        addIf(blockers, input.orderSafety.evidenceDigest !== input.evidence.evidenceDigest, 'orders.watermark-evidence-mismatch');
        addIf(blockers, input.orderSafety.cutoverWatermarkUtc === null, 'orders.cutover-watermark-missing');
        addIf(blockers, input.orderSafety.cutoverWatermarkUtc !== null && !canonicalTimestamp(input.orderSafety.cutoverWatermarkUtc), 'orders.cutover-watermark-invalid');
        addIf(blockers, input.orderSafety.eventTimeField !== 'creationDate', 'orders.creation-date-gate-missing');
        addIf(blockers, !canonicalTimestamp(input.orderSafety.sourceOrderCreatedAtUtc), 'orders.source-created-time-invalid');
        if (target?.kind === 'order') {
            const expectedKey = [
                'ebay-order',
                target.ebayEnvironment,
                target.ebaySellerAccount,
                target.ebayOrderId,
                target.shopifyStoreDomain,
            ].join(':');
            addIf(blockers, input.idempotency.key !== expectedKey, 'orders.account-scoped-idempotency-key-mismatch');
        }
        if (canonicalTimestamp(input.orderSafety.cutoverWatermarkUtc) &&
            canonicalTimestamp(input.orderSafety.sourceOrderCreatedAtUtc)) {
            addIf(blockers, Date.parse(input.orderSafety.sourceOrderCreatedAtUtc) <= Date.parse(input.orderSafety.cutoverWatermarkUtc), 'orders.source-not-after-cutover-watermark');
        }
        if (canonicalTimestamp(input.nowUtc) && canonicalTimestamp(input.orderSafety.cutoverWatermarkUtc)) {
            addIf(blockers, Date.parse(input.orderSafety.cutoverWatermarkUtc) > Date.parse(input.nowUtc), 'orders.cutover-watermark-in-future');
        }
        if (canonicalTimestamp(input.nowUtc) && canonicalTimestamp(input.orderSafety.sourceOrderCreatedAtUtc)) {
            addIf(blockers, Date.parse(input.orderSafety.sourceOrderCreatedAtUtc) > Date.parse(input.nowUtc), 'orders.source-created-time-in-future');
        }
    }
    else {
        addIf(blockers, input.orderSafety.applicable, 'orders.watermark-evidence-unexpected');
    }
    if (canonicalTimestamp(input.evidence.observationWindow.startUtc) &&
        canonicalTimestamp(input.evidence.observationWindow.endUtc)) {
        addIf(blockers, Date.parse(input.evidence.observationWindow.startUtc) > Date.parse(input.evidence.observationWindow.endUtc), 'evidence.observation-window-reversed');
    }
    if (canonicalTimestamp(input.evidence.observationWindow.endUtc) &&
        canonicalTimestamp(input.evidence.acceptedAtUtc)) {
        addIf(blockers, Date.parse(input.evidence.observationWindow.endUtc) > Date.parse(input.evidence.acceptedAtUtc), 'evidence.observation-after-acceptance');
    }
    if (canonicalTimestamp(input.evidence.acceptedAtUtc) && canonicalTimestamp(input.approval.approvedAtUtc)) {
        addIf(blockers, Date.parse(input.evidence.acceptedAtUtc) > Date.parse(input.approval.approvedAtUtc), 'approval.precedes-evidence-acceptance');
    }
    if (canonicalTimestamp(input.approval.approvedAtUtc) && canonicalTimestamp(input.nowUtc)) {
        addIf(blockers, Date.parse(input.approval.approvedAtUtc) > Date.parse(input.nowUtc), 'approval.in-future');
    }
    if (canonicalTimestamp(input.nowUtc) && canonicalTimestamp(input.approval.expiresAtUtc)) {
        addIf(blockers, Date.parse(input.nowUtc) >= Date.parse(input.approval.expiresAtUtc), 'approval.expired');
    }
    const uniqueBlockers = [...new Set(blockers)];
    return {
        readyForSeparateAuthorization: uniqueBlockers.length === 0,
        externalWritesAllowed: false,
        canaryAuthorized: false,
        liveProof: false,
        productionParity: false,
        blockers: uniqueBlockers,
    };
}
