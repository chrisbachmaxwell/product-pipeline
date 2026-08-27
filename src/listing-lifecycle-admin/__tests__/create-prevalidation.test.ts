/**
 * Bounded local pre-publish validation matrix (Brain L30/L34, task G16):
 * every documented publish prerequisite that can be proven locally is proven
 * with its own fixed CREATE_PREVALIDATION_* code BEFORE any provider write —
 * these are exactly the facts eBay's opaque post-hoc `25019` rejection never
 * names. No provider text is ever echoed.
 */
import { describe, expect, it } from 'vitest';
import { LISTING_DRAFT_SCOPE } from '../../listing-control-config.js';
import { sha256Digest } from '../../listing-control-store/index.js';
import {
  ListingLifecycleManifestError,
  MAX_INVENTORY_PRODUCT_DESCRIPTION_LENGTH,
  MAX_OFFER_LISTING_DESCRIPTION_LENGTH,
  prevalidateListingCreateManifest,
  type ListingCreateManifest,
} from '../manifest.js';

function validManifest(): ListingCreateManifest {
  return {
    schemaVersion: 2,
    scope: LISTING_DRAFT_SCOPE,
    action: 'create_ebay_listing',
    descriptionPlacement: 'inventory_product_and_offer_listing_split',
    identity: {
      shopifyProductGid: 'gid://shopify/Product/10310708200003',
      shopifyVariantGid: 'gid://shopify/ProductVariant/55396000700003',
      rawSku: 'CAN2470-U302',
      ebaySellerId: LISTING_DRAFT_SCOPE.ebaySellerId,
      ebayMarketplaceId: LISTING_DRAFT_SCOPE.ebayMarketplaceId,
      managementModel: 'unmanaged',
      ebayInventorySku: null,
      ebayOfferId: null,
      ebayListingId: null,
    },
    revisionId: 'revision:prevalidation',
    revisionNumber: 1,
    revisionDigest: sha256Digest('revision'),
    baseSourceDigest: sha256Digest('source'),
    baseEbayObservationDigest: sha256Digest('ebay'),
    proposed: {
      title: 'Canon EF 24-70mm f/2.8L',
      categoryId: '3323',
      conditionId: '3000',
      conditionEnum: 'USED_EXCELLENT',
      conditionDescription: null,
      description: '<p>Clean plain text description</p>',
      inventoryProductDescription: 'Clean plain text description',
      images: ['https://cdn.shopify.com/s/files/1/0001/products/canon-2470.jpg'],
      aspects: { Brand: ['Canon'] },
      fulfillmentPolicyId: '111',
      paymentPolicyId: '222',
      returnPolicyId: '333',
      merchantLocationKey: 'warehouse-1',
      price: { amount: '149.95', currency: 'USD' },
      quantity: 2,
      listingDuration: 'GTC',
    },
  } as ListingCreateManifest;
}

function withProposed(
  overrides: Partial<ListingCreateManifest['proposed']>,
): ListingCreateManifest {
  const manifest = validManifest();
  return { ...manifest, proposed: { ...manifest.proposed, ...overrides } };
}

function expectDenied(
  manifest: ListingCreateManifest,
  code: string,
  field?: string,
): void {
  try {
    prevalidateListingCreateManifest(manifest);
  } catch (error) {
    expect(error).toBeInstanceOf(ListingLifecycleManifestError);
    const denial = error as ListingLifecycleManifestError;
    expect(denial.code).toBe(code);
    if (field !== undefined) expect(denial.field).toBe(field);
    return;
  }
  throw new Error(`expected ${code} for the mutated manifest`);
}

describe('create pre-publish validation matrix', () => {
  it('accepts a fully valid manifest', () => {
    expect(() => prevalidateListingCreateManifest(validManifest())).not.toThrow();
  });

  it('requires a numeric-leaf-shaped category id', () => {
    for (const categoryId of ['', 'abc', '0', '033', '3323x', '3323 ', '1'.repeat(11)]) {
      expectDenied(
        withProposed({ categoryId }),
        'CREATE_PREVALIDATION_CATEGORY_ID',
        'category',
      );
    }
    expect(() => prevalidateListingCreateManifest(withProposed({ categoryId: '625' })))
      .not.toThrow();
  });

  it('requires the condition id to map through the fixed table to the exact enum', () => {
    expectDenied(
      withProposed({ conditionId: '2010' }),
      'CREATE_PREVALIDATION_CONDITION',
      'condition',
    );
    expectDenied(
      withProposed({ conditionEnum: 'USED_GOOD' }),
      'CREATE_PREVALIDATION_CONDITION',
      'condition',
    );
  });

  it('requires the three policy ids to be shape-valid, naming the family member', () => {
    expectDenied(
      withProposed({ fulfillmentPolicyId: 'policy-1' }),
      'CREATE_PREVALIDATION_POLICY_IDS',
      'fulfillment_policy',
    );
    expectDenied(
      withProposed({ paymentPolicyId: '' }),
      'CREATE_PREVALIDATION_POLICY_IDS',
      'payment_policy',
    );
    expectDenied(
      withProposed({ returnPolicyId: '0333' }),
      'CREATE_PREVALIDATION_POLICY_IDS',
      'return_policy',
    );
  });

  it('requires a shape-valid merchant location key', () => {
    for (const merchantLocationKey of ['', 'ware house', 'x'.repeat(37), 'käse']) {
      expectDenied(
        withProposed({ merchantLocationKey }),
        'CREATE_PREVALIDATION_MERCHANT_LOCATION',
        'merchant_location',
      );
    }
  });

  it('requires non-empty product aspects with non-empty values', () => {
    expectDenied(
      withProposed({ aspects: {} }),
      'CREATE_PREVALIDATION_ASPECTS',
      'item_specifics',
    );
    expectDenied(
      withProposed({ aspects: { Brand: [] } }),
      'CREATE_PREVALIDATION_ASPECTS',
      'item_specifics',
    );
  });

  it('requires the fixed GTC listing duration', () => {
    expectDenied(
      withProposed({ listingDuration: 'DAYS_7' as 'GTC' }),
      'CREATE_PREVALIDATION_LISTING_DURATION',
    );
  });

  it('enforces the split description bounds per L30', () => {
    expectDenied(
      withProposed({ inventoryProductDescription: '' }),
      'CREATE_PREVALIDATION_INVENTORY_DESCRIPTION',
      'description',
    );
    expectDenied(
      withProposed({
        inventoryProductDescription:
          'x'.repeat(MAX_INVENTORY_PRODUCT_DESCRIPTION_LENGTH + 1),
      }),
      'CREATE_PREVALIDATION_INVENTORY_DESCRIPTION',
      'description',
    );
    expectDenied(
      withProposed({ description: '' }),
      'CREATE_PREVALIDATION_LISTING_DESCRIPTION',
      'description',
    );
    expectDenied(
      withProposed({ description: 'x'.repeat(MAX_OFFER_LISTING_DESCRIPTION_LENGTH + 1) }),
      'CREATE_PREVALIDATION_LISTING_DESCRIPTION',
      'description',
    );
    // The exact bounds themselves stay accepted: 4,000 product characters
    // and a branded offer description larger than the product bound.
    expect(() => prevalidateListingCreateManifest(withProposed({
      inventoryProductDescription: 'x'.repeat(MAX_INVENTORY_PRODUCT_DESCRIPTION_LENGTH),
      description: 'x'.repeat(4_470),
    }))).not.toThrow();
  });
});
