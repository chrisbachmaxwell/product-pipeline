/**
 * Pure, intentionally unwired evaluator for a future, separately authorized canary.
 * It has no adapters and can never authorize or perform an external write.
 */
export declare const CANARY_RESPONSIBILITIES: readonly ["listingCreate", "listingRevise", "listingEndRelist", "mapping", "price", "inventory", "orderImport", "fulfillment", "feedback"];
export type CanaryResponsibility = (typeof CANARY_RESPONSIBILITIES)[number];
export type CanaryApprovalAction = 'create-listing' | 'revise-listing' | 'end-or-relist-listing' | 'update-mapping' | 'update-price' | 'update-inventory' | 'import-order' | 'sync-fulfillment' | 'sync-feedback';
export type CanaryIncumbent = 'marketplace-connect' | 'manual' | 'paused' | 'unverified';
export declare const CANARY_AUDIT_DESTINATION: "local-append-only-canary-audit-v1";
export type CanaryTarget = {
    kind: 'listing';
    targetKey: string;
    shopifyStoreDomain: string;
    ebayEnvironment: 'sandbox' | 'production';
    ebaySellerAccount: string;
    marketplaceId: 'EBAY_US';
    shopifyVariantGid: string;
    sku: string;
    ebayListingId: string | null;
} | {
    kind: 'order';
    targetKey: string;
    ebayOrderId: string;
    shopifyStoreDomain: string;
    ebayEnvironment: 'sandbox' | 'production';
    ebaySellerAccount: string;
    marketplaceId: 'EBAY_US';
};
export type CanaryReadinessInput = {
    targets: CanaryTarget[];
    responsibilities: CanaryResponsibility[];
    evidence: {
        accepted: boolean;
        responsibility: CanaryResponsibility;
        targetKey: string;
        evidenceDigest: string;
        ownershipVersion: string;
        observationWindow: {
            startUtc: string;
            endUtc: string;
        };
        expectedBeforeDigest: string;
        expectedAfterDigest: string;
        acceptedAtUtc: string;
    };
    singleWriter: {
        incumbent: CanaryIncumbent;
        incumbentVerified: boolean;
        responsibility: CanaryResponsibility;
        targetKey: string;
        ownershipVersion: string;
        incumbentDisabledOrTransferredForScope: boolean;
        productPipelineSoleWriterForScope: boolean;
        proofDigest: string;
    };
    approval: {
        approved: boolean;
        approvalId: string;
        responsibility: CanaryResponsibility;
        targetKey: string;
        action: CanaryApprovalAction;
        evidenceDigest: string;
        ownershipVersion: string;
        approvedAtUtc: string;
        expiresAtUtc: string;
        usedAtUtc: null | string;
    };
    idempotency: {
        responsibility: CanaryResponsibility;
        targetKey: string;
        ownershipVersion: string;
        key: string;
        persisted: boolean;
        uniqueConstraintVerified: boolean;
        priorResult: 'absent' | 'completed' | 'unknown';
    };
    audit: {
        targetKey: string;
        responsibility: CanaryResponsibility;
        ownershipVersion: string;
        auditDestination: typeof CANARY_AUDIT_DESTINATION;
        appendOnly: boolean;
        preflightRecorded: boolean;
        evidenceDigest: string;
    };
    reconciliation: {
        targetKey: string;
        responsibility: CanaryResponsibility;
        ownershipVersion: string;
        preActionClean: boolean;
        postActionRequired: boolean;
        evidenceDigest: string;
    };
    rollback: {
        targetKey: string;
        responsibility: CanaryResponsibility;
        ownershipVersion: string;
        documented: boolean;
        rehearsed: boolean;
        immediateDisableVerified: boolean;
        evidenceDigest: string;
    };
    orderSafety: {
        applicable: boolean;
        ebayEnvironment: 'sandbox' | 'production' | null;
        ebaySellerAccount: string | null;
        shopifyStoreDomain: string | null;
        ownershipVersion: string | null;
        persisted: boolean;
        immutable: boolean;
        evidenceDigest: string | null;
        cutoverWatermarkUtc: string | null;
        eventTimeField: 'creationDate' | null;
        sourceOrderCreatedAtUtc: string | null;
        historicalBackfill: false;
    };
    nowUtc: string;
};
export type CanaryReadinessResult = {
    readyForSeparateAuthorization: boolean;
    externalWritesAllowed: false;
    canaryAuthorized: false;
    liveProof: false;
    productionParity: false;
    blockers: string[];
};
export declare function evaluateCanaryReadiness(input: CanaryReadinessInput): CanaryReadinessResult;
