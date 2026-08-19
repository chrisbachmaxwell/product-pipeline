/**
 * Bounded read-only eBay Fulfillment adapter for the isolated order-import
 * operator CLI. It can reach exactly one host and exactly one resource family
 * (`/sell/fulfillment/v1/order`) with exactly one method (GET). Every other
 * host, path, or method is structurally impossible. Errors are redacted to
 * fixed codes; no token, URL, payload, or provider body is ever thrown or
 * logged.
 *
 * PII boundary: the adapter extracts ONLY the fields the ceremony needs.
 * Poll reads never touch buyer data at all. The single-order read used by
 * `import` additionally extracts a shipping pass-through block that exists
 * only in process memory for the one Shopify provider call — it is never
 * persisted, logged, digested into stored payloads, or echoed in output.
 *
 * This module is intentionally not imported by the server, webhooks,
 * schedulers, or any legacy sync path.
 */
import { type RuntimeAuthMaterial } from '../server/live-listing-catalog-source.js';
/**
 * The exact transient token scope pair for the order-read boundary: the base
 * scope plus sell.fulfillment, nothing else. The exchange fails closed when
 * the provider echoes any other scope set.
 */
export declare const EBAY_ORDER_TOKEN_SCOPES: readonly ["https://api.ebay.com/oauth/api_scope", "https://api.ebay.com/oauth/api_scope/sell.fulfillment"];
export declare class EbayOrderReadError extends Error {
    readonly code: 'ORDER_READ_AUTHORITY_UNAVAILABLE' | 'ORDER_READ_TARGET_INVALID' | 'ORDER_READ_FAILED';
    constructor(code: 'ORDER_READ_AUTHORITY_UNAVAILABLE' | 'ORDER_READ_TARGET_INVALID' | 'ORDER_READ_FAILED');
}
type FetchLike = typeof fetch;
export type PolledEbayOrderLineItem = Readonly<{
    lineItemId: string;
    sku: string | null;
    title: string;
    quantity: number;
    cost: Readonly<{
        value: string;
        currency: string;
    }> | null;
}>;
export type PolledEbayOrder = Readonly<{
    orderId: string;
    creationDateUtc: string;
    fulfillmentStatus: string;
    paymentStatus: string;
    total: Readonly<{
        value: string;
        currency: string;
    }> | null;
    lineItems: readonly PolledEbayOrderLineItem[];
}>;
/**
 * Shipping details pass through to exactly one Shopify provider call and are
 * never persisted, logged, or included in any stored or printed payload.
 */
export type EbayShippingPassthrough = Readonly<{
    fullName: string | null;
    email: string | null;
    phone: string | null;
    addressLine1: string | null;
    addressLine2: string | null;
    city: string | null;
    stateOrProvince: string | null;
    postalCode: string | null;
    countryCode: string | null;
}>;
export type FetchedEbayOrder = PolledEbayOrder & Readonly<{
    shippingPassthrough: EbayShippingPassthrough | null;
}>;
export type EbayOrderReadAdapter = Readonly<{
    /** GET /sell/fulfillment/v1/order filtered to creationdate:[since..]. */
    listOrdersCreatedSince: (sinceUtc: string, maxOrders: number) => Promise<PolledEbayOrder[]>;
    /** GET /sell/fulfillment/v1/order/{orderId} — one fresh order. */
    getOrder: (orderId: string) => Promise<FetchedEbayOrder>;
}>;
export declare function createEbayOrderReadAdapter(dependencies: Readonly<{
    fetchImpl?: FetchLike;
    getAccessToken: () => Promise<string>;
}>): EbayOrderReadAdapter;
/**
 * Bounded token exchange for the order-read boundary, modeled byte-for-byte
 * on `exchangeRuntimeEbayToken` but requesting exactly the base +
 * sell.fulfillment scope pair. When the provider echoes a scope set that is
 * not exactly that pair, the exchange fails closed and no token is used.
 */
export declare function exchangeOrderImportEbayToken(auth: RuntimeAuthMaterial, fetchImpl?: FetchLike): Promise<Readonly<{
    accessToken: string;
    expiresIn: number;
}>>;
/**
 * Default production order-read authority: mints one transient in-memory user
 * token from the existing eBay refresh grant with exactly the base +
 * sell.fulfillment scope pair. The token is never persisted, logged, or
 * returned outside the adapter.
 */
export declare function createProductionOrderReadTokenProvider(): () => Promise<string>;
export {};
