/**
 * Bounded eBay Inventory-API adapter for the isolated listing-lifecycle
 * operator CLI's CREATE dispatch. It can reach exactly three resource paths
 * on exactly one host, with exactly one method each:
 *
 *   PUT  /sell/inventory/v1/inventory_item/{sku}
 *   POST /sell/inventory/v1/offer
 *   POST /sell/inventory/v1/offer/{offerId}/publish
 *
 * Every other host, path, or method is structurally impossible. Requests and
 * responses are bounded (2 MB / 20 s), redirects are errors, and errors are
 * redacted to fixed codes; no token, URL, payload, or provider body is ever
 * thrown or logged.
 *
 * This module is intentionally not imported by the server, webhooks,
 * schedulers, or any legacy sync path. Its writes are reachable only from the
 * dispatch ceremony in `program.ts`, which requires a reserved
 * migration-store job under a live one-action approval before calling them.
 */
import { createProductionDispatchTokenProvider } from '../listing-revise-admin/dispatch-adapter.js';
export { createProductionDispatchTokenProvider };
export declare class ListingCreateDispatchError extends Error {
    readonly code: 'CREATE_DISPATCH_AUTHORITY_UNAVAILABLE' | 'CREATE_DISPATCH_TARGET_INVALID' | 'CREATE_DISPATCH_PAYLOAD_TOO_LARGE' | 'CREATE_DISPATCH_WRITE_FAILED' | 'CREATE_DISPATCH_RESPONSE_INVALID';
    constructor(code: 'CREATE_DISPATCH_AUTHORITY_UNAVAILABLE' | 'CREATE_DISPATCH_TARGET_INVALID' | 'CREATE_DISPATCH_PAYLOAD_TOO_LARGE' | 'CREATE_DISPATCH_WRITE_FAILED' | 'CREATE_DISPATCH_RESPONSE_INVALID');
}
type FetchLike = typeof fetch;
export type ListingCreateDispatchAdapter = Readonly<{
    putInventoryItem: (sku: string, payload: Record<string, unknown>) => Promise<void>;
    /** POST the offer payload; returns the provider-assigned offerId. */
    createOffer: (payload: Record<string, unknown>) => Promise<string>;
    /** POST the publish call for one exact offer; returns the new listingId. */
    publishOffer: (offerId: string) => Promise<string>;
}>;
export declare function createListingCreateDispatchAdapter(dependencies: Readonly<{
    fetchImpl?: FetchLike;
    getAccessToken: () => Promise<string>;
}>): ListingCreateDispatchAdapter;
