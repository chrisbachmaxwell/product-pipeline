import { describe, expect, it } from 'vitest';
import { deriveAlignmentManifest, AlignmentManifestError } from '../manifest.js';
import type { ListingDraftBasis } from '../../server/listing-draft-service.js';

/**
 * Drift detection previously compared the canonical money JSON as raw text,
 * so representation differences read as real drift.
 *
 * Found on live data: eBay returned {"amount":"1899.0"} for a listing whose
 * Shopify price is {"amount":"1899.00"}. Planning that as drift would have
 * dispatched a ReviseFixedPriceItem to eBay that changed nothing — a wasted
 * provider write, audit-chain noise, and an avoidable failure surface on a
 * listing needing no work. Across 121 active listings that multiplies.
 */
const TRADING_IDENTITY = Object.freeze({
  shopifyProductGid: 'gid://shopify/Product/9988473192739',
  shopifyVariantGid: 'gid://shopify/ProductVariant/54313761079587',
  rawSku: 'AP30126A20-DISP',
  ebaySellerId: 'usedcameragear',
  ebayMarketplaceId: 'EBAY_US',
  managementModel: 'trading_api' as const,
  ebayInventorySku: null,
  ebayOfferId: null,
  ebayListingId: '147531648756',
});

function basis(observedPrice: string | null, sourcePrice: string): ListingDraftBasis {
  return {
    identity: TRADING_IDENTITY,
    observed: { price: observedPrice },
    source: { price: sourcePrice },
  } as unknown as ListingDraftBasis;
}

const money = (amount: string) => JSON.stringify({ amount, currency: 'USD' });

function planPrice(observed: string | null, source: string) {
  return deriveAlignmentManifest({ basis: basis(observed, source), field: 'price' });
}

function expectNoDrift(observed: string, source: string) {
  try {
    planPrice(observed, source);
    throw new Error(`expected PLAN_NO_DRIFT for ${observed} vs ${source}`);
  } catch (error) {
    expect(error).toBeInstanceOf(AlignmentManifestError);
    expect((error as { code?: string }).code).toBe('PLAN_NO_DRIFT');
  }
}

describe('price alignment drift detection', () => {
  it('treats trailing fractional zeros as the same price', () => {
    // The exact live case.
    expectNoDrift(money('1899.0'), money('1899.00'));
    expectNoDrift(money('1899.00'), money('1899.0'));
    expectNoDrift(money('164.950'), money('164.95'));
    expectNoDrift(money('20'), money('20.00'));
  });

  it('does not fold a malformed amount into a well-formed one', () => {
    // "20." is not a valid decimal. Normalization deliberately leaves
    // anything it does not recognize untouched, so a malformed value can
    // never silently compare equal to a real price.
    expect(() => planPrice(money('20.'), money('20'))).not.toThrow();
  });

  it('still plans a genuine price change', () => {
    const derived = planPrice(money('1899.00'), money('1799.00'));
    expect(derived.manifest.field).toBe('price');
    expect(derived.manifest.before).toBe(money('1899.00'));
    // The dispatched value stays Shopify's own string, not a rewritten one.
    expect(derived.manifest.after).toBe(money('1799.00'));
  });

  it('does not fold a real sub-cent or magnitude difference', () => {
    expect(() => planPrice(money('1899.00'), money('1899.01'))).not.toThrow();
    expect(() => planPrice(money('189.90'), money('1899.00'))).not.toThrow();
    expect(() => planPrice(money('1899.001'), money('1899.00'))).not.toThrow();
  });

  it('never folds across a currency difference', () => {
    const before = JSON.stringify({ amount: '1899.0', currency: 'CAD' });
    const after = JSON.stringify({ amount: '1899.00', currency: 'USD' });
    expect(() => deriveAlignmentManifest({
      basis: basis(before, after), field: 'price',
    })).not.toThrow();
  });

  it('leaves quantity comparison exact', () => {
    const quantityBasis = {
      identity: TRADING_IDENTITY,
      observed: { quantity: '5' },
      source: { quantity: '5' },
    } as unknown as ListingDraftBasis;
    expect(() => deriveAlignmentManifest({ basis: quantityBasis, field: 'quantity' }))
      .toThrow(expect.objectContaining({ code: 'PLAN_NO_DRIFT' }));
    const changed = {
      identity: TRADING_IDENTITY,
      observed: { quantity: '5' },
      source: { quantity: '4' },
    } as unknown as ListingDraftBasis;
    expect(deriveAlignmentManifest({ basis: changed, field: 'quantity' })
      .manifest.after).toBe('4');
  });
});
