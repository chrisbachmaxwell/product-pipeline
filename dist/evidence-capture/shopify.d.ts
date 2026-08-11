/**
 * Shopify authoritative evidence collector.
 *
 * This module deliberately has no default transport, credential loader, environment
 * lookup, persistence, retry loop, or write operation. A caller must inject the only
 * dispatch capability, and every dispatched document is a static Admin GraphQL query.
 */
export declare const SHOPIFY_ADMIN_API_VERSION: "2026-07";
export declare const SHOPIFY_REQUIRED_READ_SCOPES: readonly ["read_inventory", "read_orders", "read_products"];
export declare const SHOPIFY_GRAPHQL_DOCUMENTS: Readonly<{
    readonly preflight: "query ProductPipelineShopifyPreflight {\n  shop {\n    id\n    myshopifyDomain\n    currencyCode\n  }\n  currentAppInstallation {\n    id\n    app {\n      id\n    }\n    accessScopes {\n      handle\n    }\n  }\n}";
    readonly variants: "query ProductPipelineShopifyVariants($first: Int!, $after: String) {\n  productVariants(first: $first, after: $after, sortKey: ID) {\n    nodes {\n      id\n      sku\n      price\n      inventoryQuantity\n      updatedAt\n      product {\n        id\n        status\n        updatedAt\n      }\n      inventoryItem {\n        id\n        tracked\n        inventoryLevels(first: 25, includeInactive: true) {\n          nodes {\n            id\n            isActive\n            updatedAt\n            location {\n              id\n            }\n            quantities(names: [\"available\"]) {\n              name\n              quantity\n            }\n          }\n          pageInfo {\n            hasNextPage\n            endCursor\n          }\n        }\n      }\n    }\n    pageInfo {\n      hasNextPage\n      endCursor\n    }\n  }\n}";
    readonly orders: "query ProductPipelineShopifyOrders($first: Int!, $after: String, $query: String!) {\n  orders(first: $first, after: $after, query: $query, sortKey: CREATED_AT) {\n    nodes {\n      id\n      createdAt\n      updatedAt\n      app {\n        id\n        name\n      }\n      sourceName\n      sourceIdentifier\n      displayFinancialStatus\n      displayFulfillmentStatus\n      test\n    }\n    pageInfo {\n      hasNextPage\n      endCursor\n    }\n  }\n}";
}>;
export type ShopifyReadErrorCode = 'configuration-denied' | 'credential-expired' | 'identity-mismatch' | 'scope-denied' | 'request-limit-exceeded' | 'transport-unavailable' | 'api-version-mismatch' | 'graphql-error' | 'throttled' | 'response-invalid' | 'pagination-incomplete' | 'pagination-loop' | 'duplicate-resource';
export declare class ShopifyReadError extends Error {
    readonly code: ShopifyReadErrorCode;
    constructor(code: ShopifyReadErrorCode);
}
export type ShopifyOrderReadWindow = Readonly<{
    startUtc: string;
    endUtc: string;
}>;
export type ShopifyReadLimits = Readonly<{
    variantPageSize: number;
    orderPageSize: number;
    maxVariantPages: number;
    maxOrderPages: number;
    maxRequests: number;
    maxResponseBytes: number;
}>;
export type ShopifyReadCollectorConfig = Readonly<{
    storeDomain: string;
    expectedShopId: string;
    expectedAppId: string;
    authorityExpiresAtUtc: string | null;
    orderWindow: ShopifyOrderReadWindow;
    limits: ShopifyReadLimits;
}>;
export type ShopifyGraphqlOperationName = 'ProductPipelineShopifyPreflight' | 'ProductPipelineShopifyVariants' | 'ProductPipelineShopifyOrders';
export type InjectedShopifyGraphqlRequest = Readonly<{
    method: 'POST';
    url: string;
    headers: Readonly<{
        Accept: 'application/json';
        'Content-Type': 'application/json';
    }>;
    authority: Readonly<{
        kind: 'injected-shopify-read-authority';
        secretExposed: false;
    }>;
    redirect: 'error';
    signal: AbortSignal;
    body: Readonly<{
        operationName: ShopifyGraphqlOperationName;
        query: string;
        variables: Readonly<Record<string, unknown>>;
    }>;
}>;
export type InjectedShopifyGraphqlResponse = Readonly<{
    status: number;
    apiVersion: string | null;
    body: unknown;
}>;
export type ShopifyGraphqlDispatcher = (request: InjectedShopifyGraphqlRequest) => Promise<InjectedShopifyGraphqlResponse>;
export type ShopifyInventoryLocationEvidence = Readonly<{
    inventoryLevelId: string;
    locationId: string;
    active: boolean;
    available: number;
    updatedAtUtc: string;
}>;
export type ShopifyVariantEvidence = Readonly<{
    productId: string;
    productStatus: string;
    productUpdatedAtUtc: string;
    variantId: string;
    sku: string | null;
    price: Readonly<{
        amount: string;
        currencyCode: string;
    }>;
    aggregateAvailable: number | null;
    variantUpdatedAtUtc: string;
    inventoryItemId: string;
    inventoryTracked: boolean;
    inventoryByLocation: readonly ShopifyInventoryLocationEvidence[];
}>;
export type ShopifyOrderEvidence = Readonly<{
    orderId: string;
    createdAtUtc: string;
    updatedAtUtc: string;
    app: Readonly<{
        id: string;
        name: string;
    }> | null;
    sourceName: string | null;
    sourceIdentifier: string | null;
    financialStatus: string | null;
    fulfillmentStatus: string;
    test: boolean;
}>;
export type ShopifyReadProvenanceInputs = Readonly<{
    source: 'shopify-admin-graphql';
    apiVersion: typeof SHOPIFY_ADMIN_API_VERSION;
    endpointHost: string;
    shopId: string;
    appId: string;
    grantedScopes: readonly string[];
    observedAtUtc: string;
    orderWindow: ShopifyOrderReadWindow;
    variantPageCount: number;
    orderPageCount: number;
    requestCount: number;
    paginationComplete: true;
    readOnly: true;
    externalWritesPerformed: false;
    historicalBackfillPerformed: false;
}>;
export type ShopifyAuthoritativeEvidence = Readonly<{
    identity: Readonly<{
        shopId: string;
        storeDomain: string;
        appId: string;
    }>;
    variants: readonly ShopifyVariantEvidence[];
    orders: readonly ShopifyOrderEvidence[];
    provenance: ShopifyReadProvenanceInputs;
}>;
export type ShopifyReadCollectorDependencies = Readonly<{
    dispatcher: ShopifyGraphqlDispatcher;
    now?: () => Date;
    signal?: AbortSignal;
}>;
/**
 * Capture a complete, bounded Shopify evidence set through an injected dispatcher.
 * The function returns no token, response envelope, customer field, raw error, or
 * cursor and never attempts token refresh.
 */
export declare function captureShopifyAuthoritativeEvidence(rawConfig: ShopifyReadCollectorConfig, dependencies: ShopifyReadCollectorDependencies): Promise<ShopifyAuthoritativeEvidence>;
