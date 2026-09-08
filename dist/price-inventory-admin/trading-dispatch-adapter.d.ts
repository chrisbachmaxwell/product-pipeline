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
    /**
     * End one fixed-price listing because the item is no longer available.
     * This is the sell-out path for this seller account: eBay refuses an
     * available-quantity-0 revision when the account's out-of-stock option is
     * off, which is also why the Marketplace Connect incumbent must have ended
     * listings rather than zeroing them.
     */
    endFixedPriceItem: (input: Readonly<{
        listingId: string;
    }>) => Promise<void>;
    /**
     * Relist one previously ended fixed-price listing because stock returned,
     * overriding quantity and price to the current Shopify source values so the
     * revived listing matches the store the moment it reappears. eBay restores
     * everything else (title, photos, description, policies) from the ended
     * listing, refuses a relist of anything that is not this seller's ended
     * listing, and ages the option out ~90 days after ending. Returns the NEW
     * listing id.
     */
    relistFixedPriceItem: (input: Readonly<{
        listingId: string;
        quantity: number;
        price: Readonly<{
            value: string;
            currency: string;
        }>;
    }>) => Promise<string>;
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
/**
 * Serialize the one bounded EndFixedPriceItem request: exactly one exact
 * ItemID and the fixed NotAvailable reason -- the only reason that truthfully
 * describes a sell-out. Nothing else may appear: no price, no quantity, so a
 * defect can never turn an end into a revise or vice versa.
 */
export declare function buildEndFixedPriceItemXml(input: Readonly<{
    listingId: string;
}>): string;
/**
 * Serialize the one bounded RelistFixedPriceItem request: the exact ended
 * ItemID plus the two Shopify source values the revived listing must carry.
 * Same strict grammars as the revise serializer; anything else is refused.
 */
export declare function buildRelistFixedPriceItemXml(input: Readonly<{
    listingId: string;
    quantity: number;
    price: Readonly<{
        value: string;
        currency: string;
    }>;
}>): string;
export declare function createTradingAlignDispatchAdapter(dependencies: Readonly<{
    fetchImpl?: FetchLike;
    getAccessToken: () => Promise<string>;
}>): TradingAlignDispatchAdapter;
export {};
