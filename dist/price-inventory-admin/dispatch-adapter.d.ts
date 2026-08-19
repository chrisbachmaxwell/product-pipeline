/**
 * Bounded eBay Inventory-API alignment adapter for the isolated
 * price/inventory operator CLI. It can reach exactly one resource path on
 * exactly one host with exactly one method: POST
 * `/sell/inventory/v1/bulk_update_price_quantity`, carrying exactly ONE
 * request entry for exactly one SKU and one offer. A price dispatch and a
 * quantity dispatch are structurally cross-contamination-proof: before the
 * request leaves this module the serialized body is re-parsed and every key
 * is asserted — a price body can never contain a quantity/availability key
 * and a quantity body can never contain a price key. Errors are redacted to
 * fixed codes; no token, URL, payload, or provider body is ever thrown or
 * logged.
 *
 * This module is intentionally not imported by the server, webhooks,
 * schedulers, or any legacy sync path. Its single POST is reachable only
 * from the dispatch ceremony in `program.ts`, which requires a reserved
 * migration-store job under a live one-action approval before calling it.
 */
import { createProductionDispatchTokenProvider } from '../listing-revise-admin/dispatch-adapter.js';
export { createProductionDispatchTokenProvider };
export declare class AlignDispatchError extends Error {
    readonly code: 'ALIGN_DISPATCH_AUTHORITY_UNAVAILABLE' | 'ALIGN_DISPATCH_TARGET_INVALID' | 'ALIGN_DISPATCH_PAYLOAD_INVALID' | 'ALIGN_DISPATCH_PAYLOAD_TOO_LARGE' | 'ALIGN_DISPATCH_WRITE_FAILED' | 'ALIGN_DISPATCH_REJECTED';
    constructor(code: 'ALIGN_DISPATCH_AUTHORITY_UNAVAILABLE' | 'ALIGN_DISPATCH_TARGET_INVALID' | 'ALIGN_DISPATCH_PAYLOAD_INVALID' | 'ALIGN_DISPATCH_PAYLOAD_TOO_LARGE' | 'ALIGN_DISPATCH_WRITE_FAILED' | 'ALIGN_DISPATCH_REJECTED');
}
type FetchLike = typeof fetch;
export type AlignPriceInput = Readonly<{
    sku: string;
    offerId: string;
    price: Readonly<{
        value: string;
        currency: string;
    }>;
}>;
export type AlignQuantityInput = Readonly<{
    sku: string;
    offerId: string;
    quantity: number;
}>;
export type PriceInventoryDispatchAdapter = Readonly<{
    updateOfferPrice: (input: AlignPriceInput) => Promise<void>;
    updateOfferQuantity: (input: AlignQuantityInput) => Promise<void>;
}>;
/**
 * Serialize the one bounded bulk_update_price_quantity body and assert its
 * structure on the serialized form: exactly one request entry, exactly one
 * offer, and zero cross-field contamination between price and quantity.
 */
export declare function buildBulkUpdateBody(field: 'price' | 'quantity', input: AlignPriceInput | AlignQuantityInput): string;
export declare function createPriceInventoryDispatchAdapter(dependencies: Readonly<{
    fetchImpl?: FetchLike;
    getAccessToken: () => Promise<string>;
}>): PriceInventoryDispatchAdapter;
