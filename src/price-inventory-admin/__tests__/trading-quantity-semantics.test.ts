import { describe, expect, it } from 'vitest';
import { tradingQuantityToWrite } from '../program.js';

/**
 * Shopify tracks AVAILABLE stock; eBay Trading tracks TOTAL listed quantity
 * and derives available as `total - sold`. Drift is detected on available,
 * but `ReviseInventoryStatus` sets the TOTAL — so writing Shopify's available
 * figure straight through leaves a listing with sales permanently short by
 * the sold count.
 *
 * Observed in Production on SKU 16437396: Shopify available 106, eBay total
 * 102 / sold 2 / available 100. Writing 106 yields available 104, the same
 * manifest re-derives next sweep, and because the intent key IS the manifest
 * digest, idempotency then blocks that listing from ever being re-aligned
 * (REALIGN_INTENT_ALREADY_RECORDED). It gets stuck wrong, silently.
 */
function target(commerce: unknown) {
  return {
    basis: { workspace: { ebayDetail: commerce === null ? null : { actual: { commerce } } } },
  } as never;
}

describe('trading quantity semantics', () => {
  it('adds the sold count so AVAILABLE converges, not total', () => {
    // The exact Production case.
    expect(tradingQuantityToWrite(
      target({ soldQuantity: 2, availableQuantityBasis: 'total_minus_sold' }),
      106,
    )).toBe(108);
  });

  it('is a no-op when nothing has sold', () => {
    expect(tradingQuantityToWrite(
      target({ soldQuantity: 0, availableQuantityBasis: 'total_minus_sold' }),
      5,
    )).toBe(5);
  });

  it('does not adjust when eBay reported available directly', () => {
    // Then Quantity already means available and adding sold would overshoot.
    expect(tradingQuantityToWrite(
      target({ soldQuantity: 4, availableQuantityBasis: 'reported' }),
      10,
    )).toBe(10);
  });

  it('does not adjust when the basis is unavailable or the detail is missing', () => {
    expect(tradingQuantityToWrite(
      target({ soldQuantity: 3, availableQuantityBasis: 'unavailable' }),
      7,
    )).toBe(7);
    expect(tradingQuantityToWrite(target(null), 7)).toBe(7);
    expect(tradingQuantityToWrite({ basis: {} } as never, 7)).toBe(7);
  });

  it('ignores a nonsensical sold count rather than corrupting the write', () => {
    for (const sold of [-1, 1.5, Number.NaN, null, undefined, '2']) {
      expect(tradingQuantityToWrite(
        target({ soldQuantity: sold, availableQuantityBasis: 'total_minus_sold' }),
        9,
      ), String(sold)).toBe(9);
    }
  });

  it('zeroing stock still zeroes AVAILABLE on a listing with sales', () => {
    // Shopify says 0 available, 2 sold: total must become 2 so available is 0.
    expect(tradingQuantityToWrite(
      target({ soldQuantity: 2, availableQuantityBasis: 'total_minus_sold' }),
      0,
    )).toBe(2);
  });
});
