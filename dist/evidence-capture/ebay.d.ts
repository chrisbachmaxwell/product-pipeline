export declare const EBAY_READ_SCOPES: Readonly<{
    identity: "https://api.ebay.com/oauth/api_scope/commerce.identity.readonly";
    inventory: "https://api.ebay.com/oauth/api_scope/sell.inventory.readonly";
    fulfillment: "https://api.ebay.com/oauth/api_scope/sell.fulfillment.readonly";
}>;
declare const HOSTS: Readonly<{
    production: Readonly<{
        identity: "apiz.ebay.com";
        sell: "api.ebay.com";
    }>;
    sandbox: Readonly<{
        identity: "apiz.sandbox.ebay.com";
        sell: "api.sandbox.ebay.com";
    }>;
}>;
declare const ORDER_WINDOW_BRAND: unique symbol;
export type EbayEnvironment = keyof typeof HOSTS;
export type EbayReadScope = (typeof EBAY_READ_SCOPES)[keyof typeof EBAY_READ_SCOPES];
export type EbayEvidenceErrorCode = "invalid-config" | "invalid-authorization" | "authorization-scope-denied" | "authorization-expired" | "authorization-near-expiry" | "transport-unavailable" | "transport-failure" | "transport-timeout" | "response-invalid" | "response-too-large" | "response-limit-exceeded" | "identity-mismatch" | "pagination-invalid" | "pagination-loop" | "duplicate-stable-id" | "incomplete-capture" | "invalid-order-window";
export declare class EbayEvidenceError extends Error {
    readonly code: EbayEvidenceErrorCode;
    constructor(code: EbayEvidenceErrorCode);
    toJSON(): Readonly<{
        name: string;
        code: EbayEvidenceErrorCode;
        message: string;
    }>;
}
export interface EbayAuthorizationAttestation {
    readonly kind: "ephemeral-user-access-attestation";
    readonly scopes: readonly EbayReadScope[];
    readonly issuedAtUtc: string;
    readonly expiresAtUtc: string;
    readonly refreshSupported: false;
    readonly credentialProvidedToCollector: false;
}
export interface EbayExpectedIdentity {
    readonly userId: string;
    readonly registrationMarketplaceId: string;
}
export interface EbayEvidenceLimits {
    readonly timeoutMs: number;
    readonly maxResponseBytes: number;
    readonly maxTotalResponseBytes: number;
    readonly maxInventoryPages: number;
    readonly maxInventoryItems: number;
    readonly maxOfferPages: number;
    readonly maxOffers: number;
    readonly maxOrderPages: number;
    readonly maxOrders: number;
}
export interface EbayEvidenceCollectorConfig {
    readonly environment: EbayEnvironment;
    readonly capturedAtUtc: string;
    readonly expectedIdentity: EbayExpectedIdentity;
    readonly authorization: EbayAuthorizationAttestation;
    readonly limits: EbayEvidenceLimits;
}
export type EbayTransportProvenance = Readonly<{
    kind: "fixture";
    fixtureId: string;
}> | Readonly<{
    kind: "direct-ebay-api";
    captureSessionId: string;
}>;
export interface EbayGetRequest {
    readonly method: "GET";
    readonly url: string;
    readonly headers: Readonly<{
        Accept: "application/json";
    }>;
    readonly redirect: "error";
    readonly requiredScope: EbayReadScope;
    readonly signal: AbortSignal;
    readonly credentialProvidedToCollector: false;
}
export interface EbayGetResponse {
    readonly status: number;
    readonly body: unknown;
}
export interface EbayInjectedGetTransport {
    readonly provenance: EbayTransportProvenance;
    readonly get: (request: EbayGetRequest) => Promise<EbayGetResponse>;
}
export interface EbayOrderWindowInput {
    readonly startUtc: string;
    readonly endUtc: string;
    readonly asOfUtc: string;
}
export type EbayOrderWindow = Readonly<{
    startUtc: string;
    endUtc: string;
    asOfUtc: string;
    historicalBackfill: false;
    lowerBoundInclusive: true;
    upperBoundExclusive: true;
    [ORDER_WINDOW_BRAND]: true;
}>;
export interface NormalizedEbayInventoryItem {
    readonly sku: string;
    readonly locale: string | null;
    readonly condition: string | null;
    readonly inventoryItemGroupKeys: readonly string[];
    readonly shipToLocationQuantity: number | null;
}
export interface NormalizedEbayOffer {
    readonly offerId: string;
    readonly sku: string;
    readonly marketplaceId: string;
    readonly format: string | null;
    readonly status: string | null;
    readonly availableQuantity: number | null;
    readonly categoryId: string | null;
    readonly price: Readonly<{
        currency: string;
        value: string;
    }> | null;
    readonly listing: Readonly<{
        listingId: string | null;
        listingStatus: string | null;
        soldQuantity: number | null;
        listingOnHold: boolean | null;
    }> | null;
}
export interface NormalizedEbayOrder {
    readonly orderId: string;
    readonly creationDate: string;
    readonly lastModifiedDate: string;
    readonly orderFulfillmentStatus: string;
}
export interface EbayRequestEvidence {
    readonly method: "GET";
    readonly host: string;
    readonly path: string;
    readonly requiredScope: EbayReadScope;
}
export interface EbayInventoryEvidence {
    readonly complete: true;
    readonly evidenceMode: "fixture" | "direct-ebay-api";
    readonly transportProvenance: EbayTransportProvenance;
    readonly environment: EbayEnvironment;
    readonly capturedAtUtc: string;
    readonly identity: EbayExpectedIdentity;
    readonly coverage: Readonly<{
        model: "ebay-inventory-api-records-and-associated-offers-only";
        allSellerListingsClaimed: false;
        tradingApiListingsIncluded: false;
        activeInventoryReportUsed: false;
    }>;
    readonly safeguards: Readonly<{
        getOnly: true;
        oauthRefreshAbsent: true;
        credentialsAbsentFromCollector: true;
        externalWritesSupported: false;
    }>;
    readonly records: Readonly<{
        inventoryItems: readonly NormalizedEbayInventoryItem[];
        offers: readonly NormalizedEbayOffer[];
    }>;
    readonly requests: readonly EbayRequestEvidence[];
    readonly responseBytes: number;
    readonly recordDigest: string;
}
export interface EbayOrderEvidence {
    readonly complete: true;
    readonly evidenceMode: "fixture" | "direct-ebay-api";
    readonly transportProvenance: EbayTransportProvenance;
    readonly environment: EbayEnvironment;
    readonly capturedAtUtc: string;
    readonly identity: EbayExpectedIdentity;
    readonly coverage: Readonly<{
        model: "ebay-fulfillment-completed-checkout-orders";
        window: Readonly<{
            startUtc: string;
            endUtc: string;
            lowerBoundInclusive: true;
            upperBoundExclusive: true;
            ebayQueryUpperBoundIsInclusive: true;
            upperBoundaryPostFiltered: true;
        }>;
        historicalBackfill: false;
        cutoverWatermark: false;
    }>;
    readonly safeguards: Readonly<{
        getOnly: true;
        oauthRefreshAbsent: true;
        credentialsAbsentFromCollector: true;
        externalWritesSupported: false;
        orderFieldsMinimized: true;
    }>;
    readonly records: readonly NormalizedEbayOrder[];
    readonly rawInclusiveRecordCount: number;
    readonly requests: readonly EbayRequestEvidence[];
    readonly responseBytes: number;
    readonly recordDigest: string;
}
export interface EbayEvidenceCollector {
    readonly collectInventoryAndOffers: () => Promise<EbayInventoryEvidence>;
    readonly collectRecentOrders: (window: EbayOrderWindow) => Promise<EbayOrderEvidence>;
}
export declare function createEbayOrderWindow(input: EbayOrderWindowInput): EbayOrderWindow;
export declare function createEbayEvidenceCollector(configInput: EbayEvidenceCollectorConfig, transportInput?: EbayInjectedGetTransport): EbayEvidenceCollector;
export {};
