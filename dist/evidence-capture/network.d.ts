import type { LoadedEvidenceCaptureConfig } from './config.js';
import { type EbayAuthorizationAttestation, type EbayInjectedGetTransport } from './ebay.js';
import { type ShopifyGraphqlDispatcher } from './shopify.js';
export declare const EVIDENCE_AUTHORITY_ENVIRONMENT: Readonly<{
    readonly shopifyAccess: "PRODUCT_PIPELINE_SHOPIFY_READ_ACCESS_TOKEN";
    readonly ebayAccess: "PRODUCT_PIPELINE_EBAY_READ_ACCESS_TOKEN";
    readonly ebayScopes: "PRODUCT_PIPELINE_EBAY_READ_ACCESS_SCOPES";
    readonly ebayIssuedAt: "PRODUCT_PIPELINE_EBAY_READ_ACCESS_ISSUED_AT_UTC";
    readonly ebayExpiresAt: "PRODUCT_PIPELINE_EBAY_READ_ACCESS_EXPIRES_AT_UTC";
}>;
export type EvidenceFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
export declare class EvidenceNetworkError extends Error {
    readonly code: 'authority-unavailable' | 'authority-invalid' | 'authority-expired' | 'authority-near-expiry' | 'request-denied' | 'response-denied' | 'transport-failed';
    constructor(code: EvidenceNetworkError['code']);
}
/**
 * Creates a semantic-read-only Shopify dispatcher. The authority remains in a
 * closure and never enters the collector request, result, error, or audit data.
 */
export declare function createShopifyNetworkDispatcher(input: {
    loaded: LoadedEvidenceCaptureConfig;
    environment: Readonly<Record<string, string | undefined>>;
    fetch: EvidenceFetch;
}): ShopifyGraphqlDispatcher;
/**
 * Creates a GET-only eBay transport. It cannot acquire or refresh OAuth access,
 * cannot submit a body, and rejects every host/path/query outside the capture contract.
 */
export declare function createEbayNetworkTransport(input: {
    loaded: LoadedEvidenceCaptureConfig;
    environment: Readonly<Record<string, string | undefined>>;
    fetch: EvidenceFetch;
    nowUtc: string;
}): {
    transport: EbayInjectedGetTransport;
    authorization: EbayAuthorizationAttestation;
};
export declare function inspectEvidenceAuthorityAvailability(environment: Readonly<Record<string, string | undefined>>): Readonly<{
    shopifyAccessPresent: boolean;
    ebayAccessPresent: boolean;
    ebayScopeMetadataPresent: boolean;
    ebayExpiryMetadataPresent: boolean;
    signingAuthorityPresent: boolean;
}>;
