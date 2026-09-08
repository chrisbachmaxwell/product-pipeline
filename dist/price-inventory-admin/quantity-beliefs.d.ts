export type QuantityBeliefSource = 
/** We wrote this value to eBay and reconciliation confirmed it landed. */
'aligned'
/** A real eBay read showed eBay already agreed with Shopify. */
 | 'observed_no_drift';
export type QuantityBelief = Readonly<{
    sku: string;
    listingId: string;
    quantity: number;
    source: QuantityBeliefSource;
    observedAtUtc: string;
}>;
/**
 * Memory of a listing OUR sweep ended at quantity zero, kept so a restock can
 * relist it automatically. Recorded only after reconciliation confirmed the
 * end landed. Like a belief this is a HINT, not authority: the relist
 * dispatch is what verifies -- eBay refuses a relist of a listing that is not
 * ours, not ended, or past the 90-day window, and the post-dispatch check
 * confirms a live listing actually exists before the job resolves. A stale
 * or deleted marker only costs an automatic relist, never a wrong write.
 */
export type EndedListingMarker = Readonly<{
    sku: string;
    listingId: string;
    endedAtUtc: string;
}>;
export type QuantityBeliefStore = Readonly<{
    all: () => Map<string, QuantityBelief>;
    record: (belief: QuantityBelief) => void;
    forget: (sku: string) => void;
    recordEnded: (marker: EndedListingMarker) => void;
    endedFor: (sku: string) => EndedListingMarker | null;
    forgetEnded: (sku: string) => void;
    close: () => void;
}>;
export declare function openQuantityBeliefStore(databasePath: string): QuantityBeliefStore;
