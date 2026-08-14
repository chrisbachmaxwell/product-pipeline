import type { ListingControlScope } from './listing-control-store/index.js';

/** Fixed tenant/account boundary for the Used Camera Gear local draft store. */
export const LISTING_DRAFT_SCOPE: ListingControlScope = Object.freeze({
  shopifyStoreDomain: 'usedcameragear.myshopify.com',
  ebayEnvironment: 'production',
  ebaySellerId: 'usedcameragear',
  ebayMarketplaceId: 'EBAY_US',
});

export const LISTING_DRAFT_SINGLE_WRITER_ACK = 'product-pipeline-local-draft-v1';
