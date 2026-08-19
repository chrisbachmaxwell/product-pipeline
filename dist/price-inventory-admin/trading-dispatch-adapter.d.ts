export declare class TradingAlignDispatchError extends Error {
    readonly code: 'TRADING_ALIGN_AUTHORITY_UNAVAILABLE' | 'TRADING_ALIGN_TARGET_INVALID' | 'TRADING_ALIGN_PAYLOAD_INVALID' | 'TRADING_ALIGN_PAYLOAD_TOO_LARGE' | 'TRADING_ALIGN_WRITE_FAILED' | 'TRADING_ALIGN_REJECTED';
    constructor(code: 'TRADING_ALIGN_AUTHORITY_UNAVAILABLE' | 'TRADING_ALIGN_TARGET_INVALID' | 'TRADING_ALIGN_PAYLOAD_INVALID' | 'TRADING_ALIGN_PAYLOAD_TOO_LARGE' | 'TRADING_ALIGN_WRITE_FAILED' | 'TRADING_ALIGN_REJECTED');
}
type FetchLike = typeof fetch;
export type TradingAlignInput = Readonly<{
    listingId: string;
    field: 'price';
    price: Readonly<{
        value: string;
        currency: string;
    }>;
}> | Readonly<{
    listingId: string;
    field: 'quantity';
    quantity: number;
}>;
export type TradingAlignDispatchAdapter = Readonly<{
    reviseInventoryStatus: (input: TradingAlignInput) => Promise<void>;
}>;
/**
 * Serialize the one bounded ReviseInventoryStatus request: exactly one
 * InventoryStatus element with the exact ItemID plus exactly one aligned
 * element. Every serialized value is validated against a strict safe
 * grammar (numeric item id, decimal amount, ISO currency, safe integer), so
 * no XML escaping surface exists; the price/quantity cross-contamination
 * assertion runs on the final serialized document.
 */
export declare function buildReviseInventoryStatusXml(input: TradingAlignInput): string;
export declare function createTradingAlignDispatchAdapter(dependencies: Readonly<{
    fetchImpl?: FetchLike;
    getAccessToken: () => Promise<string>;
}>): TradingAlignDispatchAdapter;
export {};
