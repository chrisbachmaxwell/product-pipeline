export declare const MAX_ORDER_READ_WINDOW_MS: number;
export type OrderReadWindowInput = Readonly<{
    creationDateStartUtc: string;
    creationDateEndUtc: string;
}>;
export type BoundedOrderReadWindow = Readonly<{
    kind: 'bounded-order-observation-window';
    eventTimeField: 'creationDate';
    lowerBoundInclusiveUtc: string;
    upperBoundExclusiveUtc: string;
    durationMs: number;
    notCutoverWatermark: true;
    historicalBackfillAuthorized: false;
    fixtureBoundarySemantics: 'normalized-half-open';
    liveEbayBoundarySemanticsVerified: false;
}>;
/**
 * Creates a read observation window, never a cutover watermark. Both explicit
 * creationDate bounds are mandatory and the end cannot be in the future.
 */
export declare function validateBoundedOrderReadWindow(rawWindow: unknown, nowUtc: string): BoundedOrderReadWindow;
/** Internal transport seam: forged/plain objects cannot supply order bounds. */
export declare function orderWindowQueryForTransport(window: BoundedOrderReadWindow, source: 'shopify' | 'ebay'): Readonly<Record<string, string>>;
