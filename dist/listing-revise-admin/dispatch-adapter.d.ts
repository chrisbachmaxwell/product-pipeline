export declare class ListingReviseDispatchError extends Error {
    readonly code: 'DISPATCH_AUTHORITY_UNAVAILABLE' | 'DISPATCH_TARGET_INVALID' | 'DISPATCH_READ_FAILED' | 'DISPATCH_WRITE_FAILED' | 'DISPATCH_PAYLOAD_TOO_LARGE';
    constructor(code: 'DISPATCH_AUTHORITY_UNAVAILABLE' | 'DISPATCH_TARGET_INVALID' | 'DISPATCH_READ_FAILED' | 'DISPATCH_WRITE_FAILED' | 'DISPATCH_PAYLOAD_TOO_LARGE');
}
type FetchLike = typeof fetch;
export type ListingReviseDispatchAdapter = Readonly<{
    getInventoryItem: (sku: string) => Promise<Record<string, unknown>>;
    getOffer: (offerId: string) => Promise<Record<string, unknown>>;
    putInventoryItem: (sku: string, payload: Record<string, unknown>) => Promise<void>;
    putOffer: (offerId: string, payload: Record<string, unknown>) => Promise<void>;
}>;
export declare function createListingReviseDispatchAdapter(dependencies: Readonly<{
    fetchImpl?: FetchLike;
    getAccessToken: () => Promise<string>;
}>): ListingReviseDispatchAdapter;
/**
 * Default production dispatch authority: mints one transient in-memory user
 * token from the existing eBay refresh grant with the same two scopes the
 * read path uses (`api_scope` + `sell.inventory`). The token is never
 * persisted, logged, or returned outside the adapter.
 */
export declare function createProductionDispatchTokenProvider(): () => Promise<string>;
export {};
