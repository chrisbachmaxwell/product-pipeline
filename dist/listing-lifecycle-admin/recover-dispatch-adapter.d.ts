/**
 * Bounded eBay Inventory-API adapter for the isolated listing-lifecycle
 * operator CLI's RECOVER-CREATE cleanup dispatch. It can reach exactly two
 * resource paths on exactly one host, with exactly two methods each:
 *
 *   GET    /sell/inventory/v1/offer/{offerId}
 *   DELETE /sell/inventory/v1/offer/{offerId}
 *   GET    /sell/inventory/v1/inventory_item/{sku}
 *   DELETE /sell/inventory/v1/inventory_item/{sku}
 *
 * Every other host, path, or method is structurally impossible — in
 * particular no publish, create, or revise call exists here, so this adapter
 * can never finish, replay, or alter a listing; it can only observe and
 * remove the exact named residue. Requests and responses are bounded
 * (2 MB / 20 s), redirects are errors, and errors are redacted to fixed
 * codes; no token, URL, payload, or provider body is ever thrown or logged.
 *
 * This module is intentionally not imported by the server, webhooks,
 * schedulers, or any legacy sync path. Its writes are reachable only from the
 * recover-create ceremony in `program.ts`, which requires a reserved
 * migration-store job under a live one-action approval before calling them.
 */
import { createProductionDispatchTokenProvider } from '../listing-revise-admin/dispatch-adapter.js';
export { createProductionDispatchTokenProvider };
export type ListingRecoverDispatchOutcomeClass = 'definite_no_effect' | 'outcome_unknown';
declare const OFFER_STATUSES: readonly ["PUBLISHED", "UNPUBLISHED"];
export type RecoveredOfferStatus = (typeof OFFER_STATUSES)[number];
export declare class ListingRecoverDispatchError extends Error {
    readonly code: 'RECOVER_DISPATCH_AUTHORITY_UNAVAILABLE' | 'RECOVER_DISPATCH_TARGET_INVALID' | 'RECOVER_DISPATCH_READ_FAILED' | 'RECOVER_DISPATCH_WRITE_FAILED' | 'RECOVER_DISPATCH_RESPONSE_INVALID';
    readonly outcomeClass: ListingRecoverDispatchOutcomeClass;
    constructor(code: 'RECOVER_DISPATCH_AUTHORITY_UNAVAILABLE' | 'RECOVER_DISPATCH_TARGET_INVALID' | 'RECOVER_DISPATCH_READ_FAILED' | 'RECOVER_DISPATCH_WRITE_FAILED' | 'RECOVER_DISPATCH_RESPONSE_INVALID', outcomeClass: ListingRecoverDispatchOutcomeClass);
}
type FetchLike = typeof fetch;
export type RecoveredOfferState = Readonly<{
    found: boolean;
    /** Present only when found. */
    sku: string | null;
    status: RecoveredOfferStatus | null;
}>;
export type RecoveredInventoryItemState = Readonly<{
    found: boolean;
    /** Present only when found. */
    sku: string | null;
}>;
export type ListingRecoverDispatchAdapter = Readonly<{
    /** GET the one exact offer; 404 reports found: false. */
    getOffer: (offerId: string) => Promise<RecoveredOfferState>;
    /** DELETE the one exact offer; only 204 is success. */
    deleteOffer: (offerId: string) => Promise<void>;
    /** GET the one exact inventory item; 404 reports found: false. */
    getInventoryItem: (sku: string) => Promise<RecoveredInventoryItemState>;
    /** DELETE the one exact inventory item; only 204 is success. */
    deleteInventoryItem: (sku: string) => Promise<void>;
}>;
export declare function createListingRecoverDispatchAdapter(dependencies: Readonly<{
    fetchImpl?: FetchLike;
    getAccessToken: () => Promise<string>;
}>): ListingRecoverDispatchAdapter;
