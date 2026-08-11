import { type MigrationResponsibility } from '../safety/responsibilities.js';
export type Digest = `sha256:${string}`;
export type MarketplaceConnectSubject = {
    shopifyStoreDomainDigest: Digest;
    ebayEnvironment: 'sandbox' | 'production';
    ebaySellerAccountDigest: Digest;
    ebayMarketplaceId: 'EBAY_US';
};
export type MarketplaceConnectCapture = {
    capturedAtUtc: string;
    method: 'operator-ui' | 'shopify-support-export';
    completeness: 'complete' | 'partial';
};
export type MarketplaceConnectSettings = {
    connection: 'connected' | 'disconnected' | 'unknown';
    orderImport: {
        productScope: 'all-orders' | 'linked-products-only' | 'no-orders' | 'unknown';
        fulfillmentScope: 'all-orders' | 'marketplace-fulfilled-only' | 'merchant-fulfilled-only' | 'unknown';
        importWhen: 'pending' | 'complete' | 'unknown';
    };
    priceSync: 'enabled' | 'disabled' | 'unknown';
    inventorySync: 'enabled' | 'disabled' | 'unknown';
    autoListProducts: 'enabled' | 'disabled' | 'unknown';
    autoCategorization: 'enabled' | 'disabled' | 'unknown';
    inventoryLocation: {
        mode: 'all-locations' | 'selected-locations' | 'per-product' | 'unknown';
        locationSetDigest: Digest | null;
    };
};
export type MarketplaceConnectEvidenceAttachment = {
    evidenceId: string;
    surface: 'account-settings' | 'order-import-settings' | 'listing-settings' | 'listing-grid' | 'link-listings' | 'mapping' | 'inventory-location' | 'shopify-order-attribution' | 'shopify-support-export';
    capturedAtUtc: string;
    contentDigest: Digest;
    redacted: true;
};
export type MarketplaceConnectListingRecord = {
    recordKey: Digest;
    shopifyProductDigest: Digest;
    ebayListingDigest: Digest;
    skuDigest: Digest;
    linkStatus: 'linked' | 'unlinked' | 'suggested' | 'unknown';
    fieldOwners: {
        shipping: 'ebay' | 'marketplace-connect' | 'unknown';
        returns: 'ebay' | 'marketplace-connect' | 'unknown';
        title: 'ebay' | 'marketplace-connect' | 'unknown';
        description: 'ebay' | 'marketplace-connect' | 'unknown';
        priceTaxes: 'ebay' | 'marketplace-connect' | 'unknown';
    };
    evidenceIds: string[];
};
export type MarketplaceConnectListingCoverage = {
    status: 'complete' | 'partial' | 'unavailable';
    normalizedRecordCount: number;
    terminalPageObserved: boolean;
    terminalPageDigest: Digest | null;
    datasetDigest: Digest | null;
    records: MarketplaceConnectListingRecord[];
};
export type MarketplaceConnectClaim = {
    responsibility: MigrationResponsibility;
    assertedOwner: 'marketplace_connect' | 'unverified';
    evidenceClass: 'operator-attested-ui' | 'shopify-support-export';
    evidenceIds: string[];
};
export type MarketplaceConnectUnknown = {
    unknownId: string;
    responsibility: MigrationResponsibility;
    detailsDigest: Digest;
    evidenceIds: string[];
};
export type MarketplaceConnectAttestationPayload = {
    subject: MarketplaceConnectSubject;
    capture: MarketplaceConnectCapture;
    settings: MarketplaceConnectSettings;
    listingCoverage: MarketplaceConnectListingCoverage;
    evidenceAttachments: MarketplaceConnectEvidenceAttachment[];
    claims: MarketplaceConnectClaim[];
    unknowns: MarketplaceConnectUnknown[];
    limitations: {
        evidenceOnly: true;
        ownershipTransferAuthorized: false;
        liveParityProven: false;
        externalWritesObserved: 0;
        historicalBackfill: false;
    };
};
export type MarketplaceConnectDetachedSignature = {
    role: 'collector' | 'reviewer';
    signerId: Digest;
    keyId: Digest;
    algorithm: 'Ed25519';
    signatureBase64: string;
};
export type MarketplaceConnectAttestationPacket = {
    schemaVersion: 1;
    kind: 'marketplace-connect-readonly-attestation';
    payload: MarketplaceConnectAttestationPayload;
    signatures: [MarketplaceConnectDetachedSignature, MarketplaceConnectDetachedSignature];
};
export type TrustedMarketplaceConnectSigner = {
    signerId: Digest;
    keyId: Digest;
    publicKeySpkiBase64: string;
};
export type MarketplaceConnectTrust = {
    collector: TrustedMarketplaceConnectSigner;
    reviewer: TrustedMarketplaceConnectSigner;
    expectedSubject: MarketplaceConnectSubject;
    verifiedAtUtc: string;
};
export type VerifiedMarketplaceConnectAttestation = {
    packet: MarketplaceConnectAttestationPacket;
    payloadDigest: Digest;
    verification: {
        collectorSignatureVerified: true;
        reviewerSignatureVerified: true;
    };
    classification: {
        evidenceOnly: true;
        ownershipTransferAuthorized: false;
        liveParityProven: false;
        externalWritesAllowed: false;
        historicalBackfillAllowed: false;
    };
};
export declare class MarketplaceConnectAttestationError extends Error {
    constructor(message: string);
}
export declare function canonicalJson(value: unknown): string;
/** Validate and canonicalize a payload before an external collector/reviewer signs it. */
export declare function canonicalizeMarketplaceConnectPayload(value: unknown): string;
/**
 * Verify a redacted attestation against out-of-band trusted signer keys. The
 * return type is deliberately non-authorizing even when both signatures pass.
 */
export declare function verifyMarketplaceConnectAttestation(value: unknown, trust: MarketplaceConnectTrust): VerifiedMarketplaceConnectAttestation;
