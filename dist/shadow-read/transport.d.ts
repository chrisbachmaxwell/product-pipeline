import { type ShadowReadErrorCode } from './errors.js';
import { type ReadLimits } from './limits.js';
import { type BoundedOrderReadWindow } from './order-window.js';
import { type ReadProvider, type ValidatedEphemeralReadToken } from './token.js';
export type ReadMethod = 'GET' | 'HEAD';
export type ShopifyReadAuthority = Readonly<{
    host: string;
    storeDomain: string;
    allowedPathTemplates: readonly string[];
    allowedOrderPathTemplates: readonly string[];
    allowedQueryParameters: readonly string[];
}>;
export type EbayReadAuthority = Readonly<{
    host: string;
    environment: 'sandbox' | 'production';
    sellerAccount: string;
    marketplaceId: 'EBAY_US';
    allowedPathTemplates: readonly string[];
    allowedOrderPathTemplates: readonly string[];
    allowedQueryParameters: readonly string[];
}>;
export type FixtureReadTransportConfig = Readonly<{
    shopify: ShopifyReadAuthority;
    ebay: EbayReadAuthority;
    limits: ReadLimits;
}>;
export type FixtureReadRequest = Readonly<{
    source: ReadProvider;
    method: ReadMethod;
    path: string;
    query: Readonly<Record<string, string>>;
    pageNumber: number;
    requiredScopes: readonly string[];
    token: ValidatedEphemeralReadToken;
    orderWindow: BoundedOrderReadWindow | null;
}>;
/** The request has deliberately no body, redirect override, or credential mode. */
export type InjectedFixtureReadRequest = Readonly<{
    method: ReadMethod;
    url: string;
    headers: Readonly<{
        Accept: 'application/json';
    }>;
    authority: Readonly<{
        kind: 'validated-ephemeral-read-token';
        secretExposed: false;
    }>;
    redirect: 'error';
    signal: AbortSignal;
}>;
export type InjectedFixtureReadResponse<T = unknown> = Readonly<{
    status: number;
    records: readonly T[];
}>;
/** Test/fixture seam only. There is intentionally no global-fetch implementation. */
export type FixtureReadDispatcher = (request: InjectedFixtureReadRequest) => Promise<InjectedFixtureReadResponse<unknown>>;
export type ReadAuditEvent = Readonly<{
    sequence: number;
    source: ReadProvider;
    method: ReadMethod;
    host: string;
    path: string;
    pageNumber: number;
    outcome: 'attempted' | 'succeeded' | 'denied' | 'failed';
    status: number | null;
    errorCode: ShadowReadErrorCode | null;
    fixtureOnly: true;
    liveProof: false;
}>;
export type FixtureReadResponse<T> = Readonly<{
    status: number;
    records: readonly T[];
    recordCount: number;
    responseBytes: number;
    datasetDigest: string;
    metadata: ReadAuditEvent;
    provenance: Readonly<{
        method: 'injected-fixture-read';
        attestation: 'not-runtime-observed';
        fixtureOnly: true;
        liveProof: false;
        productionParity: false;
    }>;
}>;
export type FixtureReadTransport = Readonly<{
    request: <T = unknown>(request: FixtureReadRequest) => Promise<FixtureReadResponse<T>>;
    auditEvents: () => readonly ReadAuditEvent[];
    policy: Readonly<{
        shopifyHost: string;
        shopifyStoreDomain: string;
        ebayHost: string;
        ebayEnvironment: 'sandbox' | 'production';
        ebaySellerAccount: string;
        ebayMarketplaceId: 'EBAY_US';
        limits: ReadLimits;
        fixtureOnly: true;
        liveProof: false;
    }>;
}>;
export declare function createFixtureReadTransport(rawConfig: unknown, rawDependencies?: unknown): FixtureReadTransport;
