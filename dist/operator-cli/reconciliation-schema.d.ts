import { type OperatorConfig } from './config.js';
export declare const RECONCILIATION_SOURCES: readonly ["productPipeline", "shopify", "ebay", "marketplaceConnect"];
export type ReconciliationSource = (typeof RECONCILIATION_SOURCES)[number];
export type SnapshotIdentities = OperatorConfig['identities'];
export type ProductPipelineDataset = {
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
export type ShopifyDataset = {
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
export type EbayDataset = {
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
export type MarketplaceConnectDataset = {
    settings: Array<{
        responsibility: 'orderImport' | 'price' | 'inventory';
        enabled: boolean;
    }>;
};
type DatasetBySource = {
    productPipeline: ProductPipelineDataset;
    shopify: ShopifyDataset;
    ebay: EbayDataset;
    marketplaceConnect: MarketplaceConnectDataset;
};
type SubjectBySource = {
    productPipeline: {
        project: 'product-pipeline';
        shopifyStoreDomain: string;
        ebayEnvironment: 'sandbox' | 'production';
        ebaySellerAccount: string;
    };
    shopify: {
        shopifyStoreDomain: string;
    };
    ebay: {
        ebayEnvironment: 'sandbox' | 'production';
        ebaySellerAccount: string;
        marketplaceId: 'EBAY_US';
    };
    marketplaceConnect: {
        shopifyStoreDomain: string;
        marketplaceConnectAccount: string | null;
    };
};
export type SourceAvailability = 'complete' | 'partial' | 'unavailable';
export type SourceUnavailableReason = 'authority-absent' | 'credentials-unavailable' | 'collector-unavailable' | 'source-unreachable' | 'not-collected';
type MethodBySource = {
    productPipeline: 'application-ledger-read';
    shopify: 'direct-api-read';
    ebay: 'direct-api-read';
    marketplaceConnect: 'operator-attested-admin-view';
};
type AttestationBySource = {
    productPipeline: 'runtime-observed';
    shopify: 'runtime-observed';
    ebay: 'runtime-observed';
    marketplaceConnect: 'operator-attested';
};
export type SourceProvenance<S extends ReconciliationSource> = {
    source: S;
    availability: SourceAvailability;
    unavailableReason: SourceUnavailableReason | null;
    method: MethodBySource[S];
    attestation: AttestationBySource[S];
    subject: SubjectBySource[S];
    collector: {
        name: string;
        version: string;
        buildCommit: string;
    };
    apiVersion: string | null;
    capturedAtUtc: string;
    asOfStartUtc: string;
    asOfEndUtc: string;
    queryScope: {
        kind: 'bounded';
        lowerBoundUtc: string;
        upperBoundUtc: string;
    };
    paginationComplete: boolean;
    pageCount: number;
    recordCount: number | null;
    reportedTotal: number | null;
    terminalCursorDigest: string | null;
    normalizationVersion: string;
    redactionVersion: string;
    datasetDigest: string | null;
};
export type SourceBundle<S extends ReconciliationSource> = {
    provenance: SourceProvenance<S>;
    data: DatasetBySource[S];
};
export type ReconciliationSnapshot = {
    schemaVersion: 2;
    kind: 'product-pipeline-shadow-reconciliation';
    generatedAtUtc: string;
    identities: SnapshotIdentities;
    sources: {
        productPipeline: SourceBundle<'productPipeline'>;
        shopify: SourceBundle<'shopify'>;
        ebay: SourceBundle<'ebay'>;
        marketplaceConnect: SourceBundle<'marketplaceConnect'>;
    };
};
export declare class ReconciliationSnapshotError extends Error {
    readonly issues: string[];
    constructor(issues: string[]);
}
export declare function computeReconciliationDatasetDigest(value: unknown): string;
export declare function parseReconciliationSnapshot(value: unknown, recordLimit?: number): ReconciliationSnapshot;
export {};
