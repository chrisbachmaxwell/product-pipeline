import type { ListingFieldName } from '../listing-control-store/index.js';
export declare class TradingDispatchError extends Error {
    readonly code: 'TRADING_DISPATCH_AUTHORITY_UNAVAILABLE' | 'TRADING_DISPATCH_TARGET_INVALID' | 'TRADING_DISPATCH_PAYLOAD_INVALID' | 'TRADING_DISPATCH_PAYLOAD_TOO_LARGE' | 'TRADING_DISPATCH_WRITE_FAILED' | 'TRADING_DISPATCH_REJECTED';
    constructor(code: 'TRADING_DISPATCH_AUTHORITY_UNAVAILABLE' | 'TRADING_DISPATCH_TARGET_INVALID' | 'TRADING_DISPATCH_PAYLOAD_INVALID' | 'TRADING_DISPATCH_PAYLOAD_TOO_LARGE' | 'TRADING_DISPATCH_WRITE_FAILED' | 'TRADING_DISPATCH_REJECTED');
}
type FetchLike = typeof fetch;
export type TradingReviseChange = Readonly<{
    field: ListingFieldName;
    after: string;
}>;
export type TradingReviseFixedPriceItemInput = Readonly<{
    listingId: string;
    changes: readonly TradingReviseChange[];
}>;
export type TradingDispatchAdapter = Readonly<{
    reviseFixedPriceItem: (input: TradingReviseFixedPriceItemInput) => Promise<void>;
}>;
/**
 * Serialize the one bounded ReviseFixedPriceItem request. Only the exact
 * ItemID plus one element per changed field is emitted, in a fixed order,
 * with every text value XML-escaped. Any non-Trading-dispatchable field,
 * duplicate field, or empty value fails closed, and the serialized document
 * is asserted to contain no StartPrice or Quantity element.
 */
export declare function buildReviseFixedPriceItemXml(input: TradingReviseFixedPriceItemInput): string;
export declare function createTradingDispatchAdapter(dependencies: Readonly<{
    fetchImpl?: FetchLike;
    getAccessToken: () => Promise<string>;
}>): TradingDispatchAdapter;
export {};
