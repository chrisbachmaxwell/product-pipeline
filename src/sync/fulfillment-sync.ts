import {
  createShippingFulfillment,
  fetchEbayOrder,
} from '../ebay/fulfillment.js';
import { getDb } from '../db/client.js';
import { orderMappings, syncLog } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { info, warn, error as logError } from '../utils/logger.js';
import { loadShopifyCredentials } from '../config/credentials.js';
import { mapShippingCarrier } from './mapper.js';
import { denyExternalWrite } from '../safety/writer-quarantine.js';

export interface FulfillmentSyncResult {
  updated: number;
  skipped: number;
  failed: number;
  errors: Array<{ orderId: string; error: string }>;
}

interface ShopifyFulfillment {
  id: number;
  order_id: number;
  status: string;
  tracking_number: string | null;
  tracking_company: string | null;
  created_at: string;
}

/**
 * Fetch fulfilled Shopify orders that have eBay mappings.
 */
const fetchFulfilledShopifyOrders = async (
  accessToken: string,
  shopifyOrderIds: string[],
): Promise<Map<string, ShopifyFulfillment[]>> => {
  const creds = await loadShopifyCredentials();
  const fulfillments = new Map<string, ShopifyFulfillment[]>();

  for (const orderId of shopifyOrderIds) {
    const numericId = orderId.replace(/\D/g, '');
    const url = `https://${creds.storeDomain}/admin/api/2024-01/orders/${numericId}/fulfillments.json`;

    try {
      const response = await fetch(url, {
        headers: { 'X-Shopify-Access-Token': accessToken },
      });

      if (!response.ok) continue;

      const data = (await response.json()) as {
        fulfillments: ShopifyFulfillment[];
      };

      if (data.fulfillments?.length) {
        fulfillments.set(orderId, data.fulfillments);
      }
    } catch {
      // Skip orders that fail to fetch
    }
  }

  return fulfillments;
};

/**
 * Sync fulfillments from Shopify to eBay.
 * When an order is shipped in Shopify, mark it shipped on eBay with tracking.
 */
export const syncFulfillments = async (
  ebayAccessToken: string,
  shopifyAccessToken: string,
  options: { dryRun?: boolean } = {},
): Promise<FulfillmentSyncResult> => {
  denyExternalWrite('fulfillment', 'sync Shopify fulfillment to eBay');
  const result: FulfillmentSyncResult = {
    updated: 0,
    skipped: 0,
    failed: 0,
    errors: [],
  };

  const db = await getDb();

  // Get synced order mappings
  const mappings = await db
    .select()
    .from(orderMappings)
    .where(eq(orderMappings.status, 'synced'))
    .all();

  if (!mappings.length) {
    info('No synced orders to check for fulfillment.');
    return result;
  }

  info(`Checking fulfillment for ${mappings.length} synced orders...`);

  // Get Shopify fulfillments
  const shopifyOrderIds = mappings.map((m) => m.shopifyOrderId);
  const shopifyFulfillments = await fetchFulfilledShopifyOrders(
    shopifyAccessToken,
    shopifyOrderIds,
  );

  for (const mapping of mappings) {
    const fulfillments = shopifyFulfillments.get(mapping.shopifyOrderId);

    if (!fulfillments?.length) {
      result.skipped++;
      continue;
    }

    // Find fulfillments with tracking
    const withTracking = fulfillments.filter(
      (f) => f.tracking_number && f.status === 'success',
    );

    if (!withTracking.length) {
      result.skipped++;
      continue;
    }

    try {
      // Get eBay order to get line item IDs
      const ebayOrder = await fetchEbayOrder(
        ebayAccessToken,
        mapping.ebayOrderId,
      );

      if (ebayOrder.orderFulfillmentStatus === 'FULFILLED') {
        result.skipped++;
        continue;
      }

      for (const fulfillment of withTracking) {
        if (options.dryRun) {
          info(
            `[DRY RUN] Would mark shipped: ${mapping.ebayOrderId} — tracking: ${fulfillment.tracking_number}`,
          );
          result.updated++;
          continue;
        }

        const carrierCode = mapShippingCarrier(
          fulfillment.tracking_company || 'OTHER',
        );

        await createShippingFulfillment(
          ebayAccessToken,
          mapping.ebayOrderId,
          {
            lineItems: ebayOrder.lineItems.map((li) => ({
              lineItemId: li.lineItemId,
              quantity: li.quantity,
            })),
            shippedDate: new Date(fulfillment.created_at).toISOString(),
            shippingCarrierCode: carrierCode,
            trackingNumber: fulfillment.tracking_number!,
          },
        );

        // Update mapping status
        await db
          .update(orderMappings)
          .set({ status: 'fulfilled' })
          .where(eq(orderMappings.ebayOrderId, mapping.ebayOrderId))
          .run();

        await db
          .insert(syncLog)
          .values({
            direction: 'shopify_to_ebay',
            entityType: 'fulfillment',
            entityId: mapping.ebayOrderId,
            status: 'success',
            detail: `Marked shipped — ${carrierCode} ${fulfillment.tracking_number}`,
            createdAt: new Date(),
          })
          .run();

        info(
          `Shipped: ${mapping.ebayOrderId} — ${carrierCode} ${fulfillment.tracking_number}`,
        );
        result.updated++;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logError(`Failed to sync fulfillment for ${mapping.ebayOrderId}: ${msg}`);
      result.failed++;
      result.errors.push({ orderId: mapping.ebayOrderId, error: msg });
    }
  }

  return result;
};
