import { createProductionDispatchTokenProvider } from '../listing-revise-admin/dispatch-adapter.js';
export { createProductionDispatchTokenProvider };
export declare class ListingEndDispatchError extends Error {
    readonly code: 'END_DISPATCH_AUTHORITY_UNAVAILABLE' | 'END_DISPATCH_TARGET_INVALID' | 'END_DISPATCH_PAYLOAD_INVALID' | 'END_DISPATCH_WRITE_FAILED' | 'END_DISPATCH_REJECTED';
    constructor(code: 'END_DISPATCH_AUTHORITY_UNAVAILABLE' | 'END_DISPATCH_TARGET_INVALID' | 'END_DISPATCH_PAYLOAD_INVALID' | 'END_DISPATCH_WRITE_FAILED' | 'END_DISPATCH_REJECTED');
}
type FetchLike = typeof fetch;
export type TradingEndDispatchAdapter = Readonly<{
    endFixedPriceItem: (input: {
        listingId: string;
    }) => Promise<void>;
}>;
export type InventoryWithdrawDispatchAdapter = Readonly<{
    withdrawOffer: (offerId: string) => Promise<void>;
}>;
/**
 * Serialize the one bounded EndFixedPriceItem request: exactly the ItemID and
 * the fixed EndingReason, nothing else. The serialized document is asserted
 * to contain no StartPrice or Quantity element under any input.
 */
export declare function buildEndFixedPriceItemXml(listingId: string): string;
export declare function createTradingEndDispatchAdapter(dependencies: Readonly<{
    fetchImpl?: FetchLike;
    getAccessToken: () => Promise<string>;
}>): TradingEndDispatchAdapter;
export declare function createInventoryWithdrawDispatchAdapter(dependencies: Readonly<{
    fetchImpl?: FetchLike;
    getAccessToken: () => Promise<string>;
}>): InventoryWithdrawDispatchAdapter;
