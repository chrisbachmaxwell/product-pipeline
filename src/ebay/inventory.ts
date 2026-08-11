import { ebayRequest } from './client.js';
import { denyExternalWrite } from '../safety/writer-quarantine.js';

/**
 * eBay Inventory API — manage inventory items and offers.
 * Docs: https://developer.ebay.com/api-docs/sell/inventory/resources/methods
 */

export interface EbayInventoryItem {
  sku: string;
  locale?: string;
  product: {
    title: string;
    description: string;
    imageUrls: string[];
    aspects?: Record<string, string[]>;
    brand?: string;
    mpn?: string;
    upc?: string[];
    ean?: string[];
  };
  condition: string; // NEW, LIKE_NEW, VERY_GOOD, GOOD, ACCEPTABLE, FOR_PARTS_OR_NOT_WORKING
  conditionDescription?: string;
  availability: {
    shipToLocationAvailability: {
      quantity: number;
    };
  };
  packageWeightAndSize?: {
    weight?: { value: number; unit: string };
    dimensions?: {
      length: number;
      width: number;
      height: number;
      unit: string;
    };
  };
}

export interface EbayOffer {
  offerId?: string;
  sku: string;
  marketplaceId: string; // EBAY_US
  format: string; // FIXED_PRICE
  listingDescription?: string;
  availableQuantity: number;
  pricingSummary: {
    price: { value: string; currency: string };
  };
  listingPolicies: {
    fulfillmentPolicyId: string;
    paymentPolicyId: string;
    returnPolicyId: string;
  };
  categoryId: string;
  merchantLocationKey?: string;
  tax?: {
    applyTax: boolean;
  };
  status?: string; // PUBLISHED, UNPUBLISHED, etc
  listingId?: string; // eBay listing ID when published
  listing?: { listingId?: string }; // nested format from some endpoints
}

export interface EbayOfferResponse {
  offerId: string;
  listingId?: string;
  statusCode?: number;
}

/**
 * Create or replace an inventory item on eBay.
 * PUT /sell/inventory/v1/inventory_item/{sku}
 */
export const createOrReplaceInventoryItem = async (
  accessToken: string,
  sku: string,
  item: Omit<EbayInventoryItem, 'sku'>,
): Promise<void> => {
  denyExternalWrite('listingLifecycle', 'create or replace eBay inventory item');
  await ebayRequest({
    method: 'PUT',
    path: `/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`,
    accessToken,
    body: item,
    headers: { 'Content-Language': 'en-US' },
  });
};

/**
 * Get an inventory item by SKU.
 */
export const getInventoryItem = async (
  accessToken: string,
  sku: string,
): Promise<EbayInventoryItem | null> => {
  try {
    return await ebayRequest<EbayInventoryItem>({
      path: `/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`,
      accessToken,
    });
  } catch (err) {
    if (err instanceof Error && err.message.includes('404')) return null;
    throw err;
  }
};

/**
 * Get all inventory items with pagination.
 */
export const getInventoryItems = async (
  accessToken: string,
  options: { limit?: number; offset?: number } = {},
): Promise<{ inventoryItems: EbayInventoryItem[]; total: number }> => {
  const params = new URLSearchParams();
  if (options.limit) params.set('limit', String(options.limit));
  if (options.offset) params.set('offset', String(options.offset));
  const query = params.toString();

  return ebayRequest({
    path: `/sell/inventory/v1/inventory_item${query ? '?' + query : ''}`,
    accessToken,
  });
};

/**
 * Update the quantity of an inventory item.
 */
export const updateInventoryQuantity = async (
  accessToken: string,
  sku: string,
  quantity: number,
): Promise<void> => {
  denyExternalWrite('inventory', 'update eBay inventory quantity');
  // Get current item first
  const existing = await getInventoryItem(accessToken, sku);
  if (!existing) {
    throw new Error(`Inventory item not found: ${sku}`);
  }

  // Update with new quantity
  existing.availability.shipToLocationAvailability.quantity = quantity;
  const { sku: _sku, ...itemWithoutSku } = existing;
  await createOrReplaceInventoryItem(accessToken, sku, itemWithoutSku);
};

/**
 * Create an offer for an inventory item.
 * POST /sell/inventory/v1/offer
 */
export const createOffer = async (
  accessToken: string,
  offer: Omit<EbayOffer, 'offerId'>,
): Promise<EbayOfferResponse> => {
  denyExternalWrite('listingLifecycle', 'create eBay offer');
  return ebayRequest<EbayOfferResponse>({
    method: 'POST',
    path: '/sell/inventory/v1/offer',
    accessToken,
    body: offer,
    headers: { 'Content-Language': 'en-US' },
  });
};

/**
 * Update an existing offer.
 * PUT /sell/inventory/v1/offer/{offerId}
 */
export const updateOffer = async (
  accessToken: string,
  offerId: string,
  offer: Omit<EbayOffer, 'offerId'>,
): Promise<void> => {
  denyExternalWrite('price', 'update eBay offer');
  await ebayRequest({
    method: 'PUT',
    path: `/sell/inventory/v1/offer/${offerId}`,
    accessToken,
    body: offer,
    headers: { 'Content-Language': 'en-US' },
  });
};

/**
 * Get existing offers for a SKU.
 * GET /sell/inventory/v1/offer?sku={sku}
 */
export const getOffersBySku = async (
  accessToken: string,
  sku: string,
): Promise<{ offers: EbayOffer[]; total: number }> => {
  try {
    return await ebayRequest<{ offers: EbayOffer[]; total: number }>({
      path: `/sell/inventory/v1/offer?sku=${encodeURIComponent(sku)}`,
      accessToken,
    });
  } catch (err) {
    if (err instanceof Error && err.message.includes('404')) {
      return { offers: [], total: 0 };
    }
    throw err;
  }
};

/**
 * Get seller's business policies (fulfillment, payment, return).
 * GET /sell/account/v1/fulfillment_policy, /payment_policy, /return_policy
 */
export const getBusinessPolicies = async (
  accessToken: string,
): Promise<{
  fulfillmentPolicyId: string;
  fulfillmentPolicyName: string;
  paymentPolicyId: string;
  paymentPolicyName: string;
  returnPolicyId: string;
  returnPolicyName: string;
}> => {
  const [fulfillment, payment, returnPolicy] = await Promise.all([
    ebayRequest<{ fulfillmentPolicies?: Array<{ fulfillmentPolicyId: string; name: string }> }>({
      path: '/sell/account/v1/fulfillment_policy?marketplace_id=EBAY_US',
      accessToken,
    }),
    ebayRequest<{ paymentPolicies?: Array<{ paymentPolicyId: string; name: string }> }>({
      path: '/sell/account/v1/payment_policy?marketplace_id=EBAY_US',
      accessToken,
    }),
    ebayRequest<{ returnPolicies?: Array<{ returnPolicyId: string; name: string }> }>({
      path: '/sell/account/v1/return_policy?marketplace_id=EBAY_US',
      accessToken,
    }),
  ]);

  const fpId = fulfillment.fulfillmentPolicies?.[0]?.fulfillmentPolicyId;
  const ppId = payment.paymentPolicies?.[0]?.paymentPolicyId;
  const rpId = returnPolicy.returnPolicies?.[0]?.returnPolicyId;

  if (!fpId || !ppId || !rpId) {
    throw new Error(`Missing eBay business policies: fulfillment=${fpId}, payment=${ppId}, return=${rpId}. Set up policies in eBay Seller Hub.`);
  }

  return {
    fulfillmentPolicyId: fpId,
    fulfillmentPolicyName: fulfillment.fulfillmentPolicies?.[0]?.name || fpId,
    paymentPolicyId: ppId,
    paymentPolicyName: payment.paymentPolicies?.[0]?.name || ppId,
    returnPolicyId: rpId,
    returnPolicyName: returnPolicy.returnPolicies?.[0]?.name || rpId,
  };
};

/**
 * Delete an offer.
 * DELETE /sell/inventory/v1/offer/{offerId}
 */
export const deleteOffer = async (
  accessToken: string,
  offerId: string,
): Promise<void> => {
  denyExternalWrite('listingLifecycle', 'delete eBay offer');
  await ebayRequest({
    method: 'DELETE',
    path: `/sell/inventory/v1/offer/${offerId}`,
    accessToken,
  });
};

/**
 * Create or update an inventory location on eBay.
 * PUT /sell/inventory/v1/location/{merchantLocationKey}
 */
export const createOrUpdateLocation = async (
  accessToken: string,
  locationKey: string,
  location: {
    name: string;
    location: {
      address: {
        addressLine1: string;
        city: string;
        stateOrProvince: string;
        postalCode: string;
        country: string; // ISO 3166-1 alpha-2, e.g. 'US'
      };
    };
    merchantLocationStatus: string; // 'ENABLED'
    locationTypes: string[]; // ['WAREHOUSE']
  },
): Promise<void> => {
  denyExternalWrite('listingLifecycle', 'create or update eBay inventory location');
  await ebayRequest({
    method: 'POST',
    path: `/sell/inventory/v1/location/${encodeURIComponent(locationKey)}`,
    accessToken,
    body: location,
    headers: { 'Content-Language': 'en-US' },
  });
};

/**
 * Get an inventory location.
 */
export const getLocation = async (
  accessToken: string,
  locationKey: string,
): Promise<any | null> => {
  try {
    return await ebayRequest({
      path: `/sell/inventory/v1/location/${encodeURIComponent(locationKey)}`,
      accessToken,
    });
  } catch (err) {
    if (err instanceof Error && err.message.includes('404')) return null;
    throw err;
  }
};

/**
 * Publish an offer (makes it a live listing on eBay).
 * POST /sell/inventory/v1/offer/{offerId}/publish
 */
export const publishOffer = async (
  accessToken: string,
  offerId: string,
): Promise<{ listingId: string }> => {
  denyExternalWrite('listingLifecycle', 'publish eBay offer');
  return ebayRequest<{ listingId: string }>({
    method: 'POST',
    path: `/sell/inventory/v1/offer/${offerId}/publish`,
    accessToken,
  });
};

/**
 * Get offers for a SKU.
 */
export const getOffers = async (
  accessToken: string,
  sku: string,
): Promise<{ offers: EbayOffer[]; total: number }> => {
  return ebayRequest({
    path: `/sell/inventory/v1/offer?sku=${encodeURIComponent(sku)}`,
    accessToken,
  });
};

/**
 * Delete an inventory item.
 */
export const deleteInventoryItem = async (
  accessToken: string,
  sku: string,
): Promise<void> => {
  denyExternalWrite('listingLifecycle', 'delete eBay inventory item');
  await ebayRequest({
    method: 'DELETE',
    path: `/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`,
    accessToken,
  });
};

/**
 * Withdraw (end) an offer — takes the listing off eBay but keeps inventory item.
 * POST /sell/inventory/v1/offer/{offerId}/withdraw
 */
export const withdrawOffer = async (
  accessToken: string,
  offerId: string,
): Promise<void> => {
  denyExternalWrite('listingLifecycle', 'withdraw eBay offer');
  await ebayRequest({
    method: 'POST',
    path: `/sell/inventory/v1/offer/${offerId}/withdraw`,
    accessToken,
  });
};

/**
 * Get an offer by its ID.
 * GET /sell/inventory/v1/offer/{offerId}
 */
export const getOffer = async (
  accessToken: string,
  offerId: string,
): Promise<EbayOffer | null> => {
  try {
    return await ebayRequest<EbayOffer>({
      path: `/sell/inventory/v1/offer/${offerId}`,
      accessToken,
    });
  } catch (err) {
    if (err instanceof Error && err.message.includes('404')) return null;
    throw err;
  }
};
