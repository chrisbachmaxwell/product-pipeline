import { fetchDetailedShopifyProduct, fetchAllShopifyProducts } from '../shopify/products.js';
import {
  createOrReplaceInventoryItem,
  createOffer,
  publishOffer,
  getInventoryItem,
  getLocation,
  createOrUpdateLocation,
  getOffersBySku,
  deleteOffer,
  getBusinessPolicies,
  type EbayInventoryItem,
  type EbayOffer,
} from '../ebay/inventory.js';
import { getDb } from '../db/client.js';
import { productMappings, syncLog } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { info, warn, error as logError } from '../utils/logger.js';
import { 
  getEbayCondition,
  getEbayUPC,
  getEbayTitle,
  getEbayDescription,
  getEbayHandlingTime,
  getMapping,
  resolveMapping 
} from '../sync/attribute-mapping-service.js';
import { cleanTitle, parsePrice } from './mapper.js';
import { getCategoryId, getCategoryName } from './category-mapper.js';
import { getAspects } from './aspect-mapper.js';
import { denyExternalWrite } from '../safety/writer-quarantine.js';

export interface ProductSyncResult {
  processed: number;
  created: number;
  updated: number;
  skipped: number;
  failed: number;
  errors: Array<{ productId: string; error: string }>;
}

/**
 * Cached business policies (fetched once per sync run).
 */
let cachedPolicies: { fulfillmentPolicyId: string; paymentPolicyId: string; returnPolicyId: string } | null = null;

/**
 * Default item location from settings.
 */
const DEFAULT_LOCATION = '305 W 700 S, Salt Lake City, UT 84101';

/**
 * Map a Shopify product to eBay inventory item and offer using attribute mappings.
 */
const mapShopifyProductToEbay = async (
  shopifyProduct: any,
  variant: any,
  settings: Record<string, string>,
): Promise<{ inventoryItem: Omit<EbayInventoryItem, 'sku'>; offer: Omit<EbayOffer, 'offerId' | 'sku'> }> => {
  
  // Use attribute mapping service to get mapped values
  const conditionId = await getEbayCondition(shopifyProduct);
  const upc = await getEbayUPC(shopifyProduct);
  const title = await getEbayTitle(shopifyProduct);
  const description = await getEbayDescription(shopifyProduct);
  const handlingTime = await getEbayHandlingTime(shopifyProduct);
  
  // Get category: prefer explicit mapping, fall back to smart category mapper
  const categoryMapping = await getMapping('listing', 'primary_category');
  const mappedCategory = await resolveMapping(categoryMapping, shopifyProduct);
  // mappedCategory is used later only if explicitly set; smart mapper is the primary
  
  const price = parsePrice(variant.price);
  const quantity = Math.max(0, variant.inventoryQuantity || 0);
  
  // Clean up description if needed
  let finalDescription = description;
  if (finalDescription.length > 2000) {
    finalDescription = finalDescription.slice(0, 1997) + '...';
  }
  
  // Build image URLs (eBay wants HTTPS)
  // Shopify REST API uses 'src', GraphQL uses 'url'
  const imageUrls = (shopifyProduct.images || [])
    .slice(0, 12)  // eBay max 12 images
    .map((img: any) => (img.url || img.src || '').replace(/^http:/, 'https:'))
    .filter((url: string) => url.length > 0);

  // Get condition description
  const conditionDesc = await getConditionDescription(conditionId, shopifyProduct);

  // Determine brand and MPN
  const brand = shopifyProduct.vendor || 'Unbranded';
  // Try to extract MPN from SKU (strip condition suffix like -U123)
  const rawSku = variant.sku || '';
  const mpn = rawSku.replace(/-U\d+$/, '') || 'Does Not Apply';
  
  // Handle UPC — eBay rejects all-zeros, use 'Does Not Apply' instead
  const effectiveUpc = upc && upc !== '0000000000000' && upc !== '000000000000' ? upc : undefined;

  // Smart category mapping based on product type
  const smartCategoryId = getCategoryId(shopifyProduct.productType);
  const smartCategoryName = getCategoryName(shopifyProduct.productType);
  info(`Category mapped: "${shopifyProduct.productType}" → ${smartCategoryId} (${smartCategoryName})`);

  // Dynamic item specifics based on category
  const aspects = getAspects(smartCategoryId, shopifyProduct, variant);

  const inventoryItem: Omit<EbayInventoryItem, 'sku'> = {
    product: {
      title: cleanTitle(title),
      description: finalDescription,
      imageUrls,
      aspects,
      brand,
      mpn,
      upc: effectiveUpc ? [effectiveUpc] : ['Does Not Apply'],
    },
    condition: mapConditionIdToText(conditionId),
    conditionDescription: conditionDesc,
    availability: {
      shipToLocationAvailability: {
        quantity,
      },
    },
    packageWeightAndSize: variant.weight ? {
      weight: {
        value: variant.weight,
        unit: variant.weightUnit === 'lb' ? 'POUND' : 'KILOGRAM',
      },
    } : undefined,
  };

  const offer: Omit<EbayOffer, 'offerId' | 'sku'> = {
    marketplaceId: 'EBAY_US',
    format: 'FIXED_PRICE',
    availableQuantity: quantity,
    pricingSummary: {
      price: {
        value: price.toFixed(2),
        currency: 'USD',
      },
    },
    listingPolicies: {
      fulfillmentPolicyId: cachedPolicies?.fulfillmentPolicyId || '',
      paymentPolicyId: cachedPolicies?.paymentPolicyId || '',
      returnPolicyId: cachedPolicies?.returnPolicyId || '',
    },
    merchantLocationKey: 'pictureline-slc',
    categoryId: mappedCategory || smartCategoryId,
    tax: {
      applyTax: true,
    },
  };

  return { inventoryItem, offer };
};

/**
 * Map eBay condition ID to condition text that eBay API expects.
 */
const mapConditionIdToText = (conditionId: string): string => {
  switch (conditionId) {
    case '1000':
      return 'NEW';
    case '1500':
      return 'NEW_OTHER';
    case '3000':
      return 'USED_EXCELLENT';
    case '7000':
      return 'FOR_PARTS_OR_NOT_WORKING';
    default:
      return 'USED_EXCELLENT';
  }
};

/**
 * Get condition description based on mapping or default.
 */
const getConditionDescription = async (conditionId: string, shopifyProduct: any): Promise<string | undefined> => {
  const conditionDescMapping = await getMapping('listing', 'condition_description');
  const mappedDesc = await resolveMapping(conditionDescMapping, shopifyProduct);
  
  if (mappedDesc) {
    return mappedDesc;
  }
  
  // Default descriptions based on condition
  switch (conditionId) {
    case '3000':
      return 'Used but in good working condition';
    case '1500':
      return 'New item with minor cosmetic imperfections';
    default:
      return undefined;
  }
};

/**
 * Sync a single Shopify product to eBay.
 * Creates inventory item and offer, publishes the listing.
 */
const syncProductToEbay = async (
  ebayToken: string,
  shopifyToken: string,
  productId: string,
  settings: Record<string, string>,
  options: { dryRun?: boolean; draft?: boolean } = {},
): Promise<{ success: boolean; error?: string; listingId?: string; offerId?: string }> => {
  
  try {
    const db = await getDb();
    
    // Check if already mapped
    const existing = await db
      .select()
      .from(productMappings)
      .where(eq(productMappings.shopifyProductId, productId))
      .get();
    
    if (existing) {
      return { success: false, error: 'Already mapped to eBay' };
    }
    
    // Get detailed product info
    const product = await fetchDetailedShopifyProduct(shopifyToken, productId);
    if (!product) {
      return { success: false, error: 'Product not found' };
    }
    
    if (product.status !== 'active') {
      return { success: false, error: 'Product not active' };
    }
    
    // For now, only handle single variant products
    // Multi-variant support would need more complex eBay variation handling
    if (product.variants.length > 1) {
      return { success: false, error: 'Multi-variant products not supported yet' };
    }
    
    const variant = product.variants[0];
    if (!variant.sku) {
      return { success: false, error: 'Product variant missing SKU' };
    }
    
    if (variant.inventoryQuantity <= 0) {
      return { success: false, error: 'No inventory available' };
    }
    
    // eBay requires at least one image
    if (!product.images || product.images.length === 0) {
      return { success: false, error: 'Product has no images — eBay requires at least one image' };
    }
    
    if (options.dryRun) {
      info(`[DRY RUN] Would create eBay listing: ${product.title} (SKU: ${variant.sku})`);
      return { success: true };
    }
    
    // Ensure eBay inventory location exists
    const locationKey = 'pictureline-slc';
    const existingLocation = await getLocation(ebayToken, locationKey);
    if (!existingLocation) {
      info(`Creating eBay inventory location: ${locationKey}`);
      await createOrUpdateLocation(ebayToken, locationKey, {
        name: 'Pictureline - Salt Lake City',
        location: {
          address: {
            addressLine1: '305 W 700 S',
            city: 'Salt Lake City',
            stateOrProvince: 'UT',
            postalCode: '84101',
            country: 'US',
          },
        },
        merchantLocationStatus: 'ENABLED',
        locationTypes: ['WAREHOUSE'],
      });
      info(`Created eBay inventory location: ${locationKey}`);
    }
    
    // Check if inventory item already exists on eBay
    const existingItem = await getInventoryItem(ebayToken, variant.sku);
    
    // Map to eBay format
    const { inventoryItem, offer } = await mapShopifyProductToEbay(product, variant, settings);
    
    // Create/update inventory item
    await createOrReplaceInventoryItem(ebayToken, variant.sku, inventoryItem);
    info(`Created eBay inventory item: ${variant.sku}`);
    
    // Clean up any orphaned offers from previous failed attempts
    const existingOffers = await getOffersBySku(ebayToken, variant.sku);
    if (existingOffers.offers && existingOffers.offers.length > 0) {
      for (const oldOffer of existingOffers.offers) {
        info(`Deleting orphaned eBay offer: ${oldOffer.offerId}`);
        await deleteOffer(ebayToken, oldOffer.offerId!);
      }
    }
    
    // Create offer
    const offerResponse = await createOffer(ebayToken, {
      ...offer,
      sku: variant.sku,
    });
    info(`Created eBay offer: ${offerResponse.offerId}`);
    
    // Publish the listing (unless draft mode)
    let listingId: string;
    if (options.draft) {
      listingId = `draft-${offerResponse.offerId}`;
      info(`Created eBay DRAFT offer: ${offerResponse.offerId} (not published)`);
    } else {
      const publishResponse = await publishOffer(ebayToken, offerResponse.offerId);
      listingId = publishResponse.listingId;
      info(`Published eBay listing: ${listingId}`);
    }
    
    // Save mapping (with cached Shopify metadata for list view)
    await db
      .insert(productMappings)
      .values({
        shopifyProductId: productId,
        ebayListingId: listingId,
        ebayInventoryItemId: variant.sku,
        status: options.draft ? 'draft' : 'active',
        shopifyTitle: product.title || null,
        shopifyPrice: parseFloat(variant.price) || null,
        shopifySku: variant.sku || null,
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .run();
    
    // Log sync
    await db
      .insert(syncLog)
      .values({
        direction: 'shopify_to_ebay',
        entityType: 'product',
        entityId: productId,
        status: 'success',
        detail: `Created eBay listing ${listingId} for SKU ${variant.sku}`,
        createdAt: new Date(),
      })
      .run();
    
    return { success: true, listingId, offerId: offerResponse.offerId };
    
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    logError(`Failed to sync product ${productId}: ${errorMsg}`);
    
    // Log failure
    const db = await getDb();
    await db
      .insert(syncLog)
      .values({
        direction: 'shopify_to_ebay',
        entityType: 'product',
        entityId: productId,
        status: 'failed',
        detail: errorMsg,
        createdAt: new Date(),
      })
      .run();
    
    return { success: false, error: errorMsg };
  }
};

/**
 * Sync multiple Shopify products to eBay.
 */
export const syncProducts = async (
  ebayToken: string,
  shopifyToken: string,
  productIds: string[],
  settings: Record<string, string> = {},
  options: { dryRun?: boolean; draft?: boolean } = {},
): Promise<ProductSyncResult> => {
  denyExternalWrite('listingLifecycle', 'sync Shopify products to eBay');

  const result: ProductSyncResult = {
    processed: 0,
    created: 0,
    updated: 0,
    skipped: 0,
    failed: 0,
    errors: [],
  };
  
  info(`Starting product sync for ${productIds.length} products...`);
  
  // Fetch real business policies from eBay (cached per sync run)
  if (!cachedPolicies) {
    info('Fetching eBay business policies...');
    cachedPolicies = await getBusinessPolicies(ebayToken);
    info(`Policies: fulfillment=${cachedPolicies.fulfillmentPolicyId}, payment=${cachedPolicies.paymentPolicyId}, return=${cachedPolicies.returnPolicyId}`);
  }
  
  for (const productId of productIds) {
    result.processed++;
    
    const syncResult = await syncProductToEbay(
      ebayToken,
      shopifyToken,
      productId,
      settings,
      options,
    );
    
    if (syncResult.success) {
      result.created++;
      info(`✅ ${productId} → eBay listing ${syncResult.listingId || 'N/A'}`);
    } else {
      if (syncResult.error?.includes('Already mapped')) {
        result.skipped++;
      } else {
        result.failed++;
        result.errors.push({ productId, error: syncResult.error || 'Unknown error' });
      }
      info(`❌ ${productId}: ${syncResult.error}`);
    }
    
    // Rate limiting: eBay allows 5 requests/sec
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  
  info(`Product sync complete: ${result.created} created, ${result.skipped} skipped, ${result.failed} failed`);
  return result;
};

/**
 * Auto-sync new Shopify products to eBay based on settings.
 */
export const autoSyncNewProducts = async (
  ebayToken: string,
  shopifyToken: string,
  settings: Record<string, string> = {},
): Promise<ProductSyncResult> => {
  denyExternalWrite('listingLifecycle', 'auto-list new Shopify products on eBay');

  if (settings.auto_list !== 'true') {
    info('[AutoSync] Auto-list disabled');
    return {
      processed: 0,
      created: 0,
      updated: 0,
      skipped: 0,
      failed: 0,
      errors: [],
    };
  }
  
  const db = await getDb();
  
  // Get all active Shopify products
  const products = await fetchAllShopifyProducts(shopifyToken, { 
    status: 'active',
    limit: 50,  // Start small for testing
  });
  
  // Filter out already mapped products
  const unmappedProducts = [];
  for (const product of products) {
    const existing = await db
      .select()
      .from(productMappings)
      .where(eq(productMappings.shopifyProductId, product.id))
      .get();
    
    if (!existing) {
      unmappedProducts.push(product.id);
    }
  }
  
  if (unmappedProducts.length === 0) {
    info('[AutoSync] No new products to sync');
    return {
      processed: 0,
      created: 0,
      updated: 0,
      skipped: 0,
      failed: 0,
      errors: [],
    };
  }
  
  info(`[AutoSync] Found ${unmappedProducts.length} new products to sync`);
  return syncProducts(ebayToken, shopifyToken, unmappedProducts, settings);
};

/**
 * Update an existing eBay listing from Shopify product data.
 * Updates inventory item (title, description, images, etc.) and offer (price).
 * Does NOT delete/recreate the offer — preserves listing history.
 */
export const updateProductOnEbay = async (
  ebayToken: string,
  shopifyToken: string,
  productId: string,
  settings: Record<string, string> = {},
): Promise<{ success: boolean; error?: string; updated: string[] }> => {
  denyExternalWrite('listingLifecycle', 'update eBay listing from Shopify product');
  const updated: string[] = [];
  
  try {
    const db = await getDb();
    
    // Find existing mapping
    const mapping = await db
      .select()
      .from(productMappings)
      .where(eq(productMappings.shopifyProductId, productId))
      .get();
    
    if (!mapping || !mapping.ebayInventoryItemId) {
      return { success: false, error: 'Product not mapped to eBay', updated };
    }
    
    const sku = mapping.ebayInventoryItemId;
    
    // Get current Shopify product data
    const product = await fetchDetailedShopifyProduct(shopifyToken, productId);
    if (!product) {
      return { success: false, error: 'Product not found in Shopify', updated };
    }
    
    const variant = product.variants[0];
    if (!variant) {
      return { success: false, error: 'No variant found', updated };
    }
    
    // Fetch business policies if not cached
    if (!cachedPolicies) {
      cachedPolicies = await getBusinessPolicies(ebayToken);
    }
    
    // Map to eBay format
    const { inventoryItem, offer } = await mapShopifyProductToEbay(product, variant, settings);
    
    // Update inventory item (title, description, images, aspects, quantity)
    await createOrReplaceInventoryItem(ebayToken, sku, inventoryItem);
    updated.push('inventoryItem');
    info(`Updated eBay inventory item: ${sku} — title="${inventoryItem.product.title}"`);
    
    // Update offer (price, policies) if it exists
    const offersResult = await getOffersBySku(ebayToken, sku);
    const existingOffer = offersResult.offers?.[0];
    
    if (existingOffer?.offerId) {
      // Build the full offer update (eBay requires all fields on PUT)
      const { updateOffer } = await import('../ebay/inventory.js');
      await updateOffer(ebayToken, existingOffer.offerId, {
        ...offer,
        sku,
        availableQuantity: inventoryItem.availability.shipToLocationAvailability.quantity,
      });
      updated.push('offer');
      info(`Updated eBay offer: ${existingOffer.offerId} — price=$${offer.pricingSummary.price.value}`);
    }
    
    // Log sync
    await db
      .insert(syncLog)
      .values({
        direction: 'shopify_to_ebay',
        entityType: 'product',
        entityId: productId,
        status: 'success',
        detail: `Updated: ${updated.join(', ')}`,
        createdAt: new Date(),
      })
      .run();
    
    // Update mapping timestamp and cached Shopify metadata
    await db
      .update(productMappings)
      .set({
        updatedAt: new Date(),
        shopifyTitle: product.title || undefined,
        shopifyPrice: parseFloat(variant.price) || undefined,
        shopifySku: variant.sku || undefined,
      })
      .where(eq(productMappings.shopifyProductId, productId))
      .run();
    
    return { success: true, updated };
    
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    logError(`Failed to update eBay product for Shopify ${productId}: ${errorMsg}`);
    return { success: false, error: errorMsg, updated };
  }
};

/**
 * End an eBay listing when a Shopify product is deleted/archived.
 * Withdraws the offer and updates mapping status to 'ended'.
 */
export const endEbayListing = async (
  ebayToken: string,
  productId: string,
): Promise<{ success: boolean; error?: string }> => {
  denyExternalWrite('listingLifecycle', 'end eBay listing');
  try {
    const db = await getDb();
    
    // Find mapping
    const mapping = await db
      .select()
      .from(productMappings)
      .where(eq(productMappings.shopifyProductId, productId))
      .get();
    
    if (!mapping || !mapping.ebayInventoryItemId) {
      return { success: false, error: 'Product not mapped to eBay' };
    }
    
    if (mapping.status === 'ended') {
      return { success: false, error: 'Listing already ended' };
    }
    
    const sku = mapping.ebayInventoryItemId;
    const { withdrawOffer: doWithdraw, getOffersBySku: getOffers } = await import('../ebay/inventory.js');
    
    // Get the offer
    const offersResult = await getOffers(ebayToken, sku);
    const offer = offersResult.offers?.[0];
    
    if (offer?.offerId) {
      try {
        await doWithdraw(ebayToken, offer.offerId);
        info(`✅ eBay listing ENDED for Shopify product ${productId} (offer ${offer.offerId})`);
      } catch (err: any) {
        if (err.message?.includes('INVALID_OFFER_STATUS') || err.message?.includes('25014')) {
          info(`Offer ${offer.offerId} was already unpublished`);
        } else {
          throw err;
        }
      }
    }
    
    // Update mapping
    await db
      .update(productMappings)
      .set({ status: 'ended', updatedAt: new Date() })
      .where(eq(productMappings.shopifyProductId, productId))
      .run();
    
    // Log
    await db
      .insert(syncLog)
      .values({
        direction: 'shopify_to_ebay',
        entityType: 'product',
        entityId: productId,
        status: 'success',
        detail: `Listing ENDED (product archived/deleted)`,
        createdAt: new Date(),
      })
      .run();
    
    return { success: true };
    
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    logError(`Failed to end eBay listing for Shopify ${productId}: ${errorMsg}`);
    return { success: false, error: errorMsg };
  }
};
