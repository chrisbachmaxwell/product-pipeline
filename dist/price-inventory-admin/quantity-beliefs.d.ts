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
export type QuantityBeliefStore = Readonly<{
    all: () => Map<string, QuantityBelief>;
    record: (belief: QuantityBelief) => void;
    forget: (sku: string) => void;
    close: () => void;
}>;
export declare function openQuantityBeliefStore(databasePath: string): QuantityBeliefStore;
