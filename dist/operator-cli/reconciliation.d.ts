import { type OperatorConfig, type Responsibility } from './config.js';
export declare const RECONCILIATION_SNAPSHOT_DIRECTORY = ".local/operator-reconciliation";
export declare const MAX_RECONCILIATION_SNAPSHOT_BYTES: number;
export declare const MAX_RECONCILIATION_RECORDS_PER_COLLECTION = 5000;
export declare const MAX_RECONCILIATION_SNAPSHOT_AGE_MS: number;
type SnapshotIdentities = OperatorConfig['identities'];
export type ReconciliationSnapshot = {
    schemaVersion: 1;
    kind: 'product-pipeline-shadow-reconciliation';
    capturedAtUtc: string;
    identities: SnapshotIdentities;
    productPipeline: {
        listings: Array<{
            shopifyProductId: string;
            shopifyVariantGid: string | null;
            sku: string;
            ebayInventoryItemSku: string | null;
            ebayOfferId: string | null;
            ebayListingId: string | null;
            status: 'active' | 'ended' | 'draft' | 'unverified';
        }>;
        orders: Array<{
            ebayOrderId: string;
            shopifyOrderGid: string | null;
            state: 'observed' | 'mapped';
        }>;
    };
    shopify: {
        variants: Array<{
            shopifyProductGid: string;
            shopifyVariantGid: string;
            sku: string;
            priceMinor: number;
            currency: string;
            inventoryQuantity: number;
        }>;
        orders: Array<{
            shopifyOrderGid: string;
            ebayOrderId: string | null;
            importOwner: 'marketplace-connect' | 'product-pipeline' | 'unknown';
            createdAtUtc: string;
            status: 'open' | 'closed' | 'cancelled' | 'unknown';
        }>;
    };
    ebay: {
        listings: Array<{
            inventoryItemSku: string;
            offerId: string | null;
            listingId: string | null;
            status: 'published' | 'unpublished' | 'ended' | 'unknown';
            priceMinor: number;
            currency: string;
            availableQuantity: number;
        }>;
        orders: Array<{
            ebayOrderId: string;
            createdAtUtc: string;
            status: 'active' | 'completed' | 'cancelled' | 'unknown';
        }>;
    };
    marketplaceConnect: {
        orderImportEnabled: boolean;
        priceSyncEnabled: boolean;
        inventorySyncEnabled: boolean;
    };
};
export type ReconciliationDiscrepancy = {
    code: string;
    severity: 'info' | 'warning' | 'critical';
    responsibility: Responsibility;
    entityType: 'configuration' | 'listing' | 'order' | 'snapshot';
    entityKey: string;
    owner: OperatorConfig['ownership'][Responsibility]['currentOwner'];
    summary: string;
};
export type ReconciliationResult = {
    command: 'reconcile';
    status: 'consistent-with-supplied-snapshots' | 'exceptions-found';
    evidenceScope: 'supplied-snapshots-only';
    guarantees: {
        liveProof: false;
        productionParity: false;
        externalNetworkAccess: false;
        externalWrites: 0;
        applicationDatabaseAccess: false;
        historicalBackfill: false;
        orderCreationEligible: false;
    };
    capturedAtUtc: string;
    snapshotAgeMs: number;
    declaredIdentity: SnapshotIdentities;
    ownership: OperatorConfig['ownership'];
    counts: {
        productPipelineListings: number;
        productPipelineOrders: number;
        shopifyVariants: number;
        shopifyOrders: number;
        ebayListings: number;
        ebayOrders: number;
        discrepancies: number;
    };
    discrepancies: ReconciliationDiscrepancy[];
    snapshot: {
        path: string;
        digest: string;
    };
    resultDigest: string;
    audit: {
        path: string;
        sequence: number;
        recordHash: string;
    };
};
export declare class ReconciliationSnapshotError extends Error {
    readonly issues: string[];
    constructor(issues: string[]);
}
export declare function parseReconciliationSnapshot(value: unknown): ReconciliationSnapshot;
export declare function runSnapshotReconciliation(options: {
    repoRoot: string;
    configPath: string;
    snapshotPath: string;
    now?: () => Date;
    createRunId?: () => string;
}): Promise<ReconciliationResult>;
export {};
