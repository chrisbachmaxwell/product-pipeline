/**
 * ORDER SAFETY GUARDS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * This module provides critical safety mechanisms to prevent duplicate Shopify
 * order creation and runaway syncs.
 *
 * INCIDENT (2026-02-11): Syncing without a date filter pulled ALL historical
 * eBay orders into Shopify. These cascaded into Lightspeed POS and required
 * hours of manual cleanup. These guards ensure it NEVER happens again.
 *
 * THREE LAYERS OF PROTECTION:
 *   1. SAFETY_MODE rate limiter (1 order/10s, 5 orders/hr in safe mode)
 *   2. Dry-run default — must pass confirm=true to actually create
 *   3. Enhanced duplicate detection: DB + Shopify tag + total+date+buyer
 *
 * ═══════════════════════════════════════════════════════════════════════════
 */

import { loadShopifyCredentials } from '../config/credentials.js';
import { warn } from '../utils/logger.js';

// ─────────────────────────────────────────────────────────────────────────────
// SAFETY MODE — Rate Limiting
// ─────────────────────────────────────────────────────────────────────────────

/** SAFETY_MODE defaults to "safe". Set to "off" to disable rate limiting (NOT recommended). */
export const SAFETY_MODE = (process.env.SAFETY_MODE ?? 'safe').toLowerCase() as 'safe' | 'off';

const SAFE_MODE_MAX_PER_HOUR = 5;          // Max Shopify order creations per hour
const SAFE_MODE_MIN_INTERVAL_MS = 10_000;  // Min 10 seconds between creations

/** In-memory creation timestamps — process-scoped, resets on restart */
const _creationTimestamps: number[] = [];

/**
 * Assert that creating another Shopify order is permitted right now.
 * Throws `DuplicateOrderError` if the rate limit would be exceeded in safe mode.
 */
export function assertRateLimit(): void {
  if (SAFETY_MODE === 'off') return;

  const now = Date.now();
  const oneHourAgo = now - 60 * 60 * 1000;

  // Purge timestamps older than 1 hour
  while (_creationTimestamps.length > 0 && _creationTimestamps[0]! < oneHourAgo) {
    _creationTimestamps.shift();
  }

  // Hourly cap
  if (_creationTimestamps.length >= SAFE_MODE_MAX_PER_HOUR) {
    throw new OrderSafetyError(
      `SAFETY_MODE=safe: Rate limit — cannot create more than ${SAFE_MODE_MAX_PER_HOUR} Shopify orders per hour. ` +
        `Already created ${_creationTimestamps.length} in the last hour. ` +
        `Set SAFETY_MODE=off to bypass (not recommended).`,
    );
  }

  // Minimum interval between creations
  const lastTs = _creationTimestamps[_creationTimestamps.length - 1];
  if (lastTs !== undefined) {
    const elapsed = now - lastTs;
    if (elapsed < SAFE_MODE_MIN_INTERVAL_MS) {
      const waitSecs = Math.ceil((SAFE_MODE_MIN_INTERVAL_MS - elapsed) / 1000);
      throw new OrderSafetyError(
        `SAFETY_MODE=safe: Rate limit — must wait ${waitSecs}s between order creations. ` +
          `Set SAFETY_MODE=off to bypass (not recommended).`,
      );
    }
  }
}

/**
 * Record a successful Shopify order creation for rate-limit tracking.
 * Must be called immediately after each successful createShopifyOrder().
 */
export function recordOrderCreation(): void {
  _creationTimestamps.push(Date.now());
}

/** Get current rate-limit status for diagnostics */
export function getRateLimitStatus(): {
  safetyMode: string;
  createdLastHour: number;
  maxPerHour: number;
  lastCreatedAt: string | null;
  nextAllowedAt: string | null;
} {
  const now = Date.now();
  const oneHourAgo = now - 60 * 60 * 1000;
  const recent = _creationTimestamps.filter((t) => t > oneHourAgo);
  const lastTs = recent[recent.length - 1];
  const nextAllowed =
    lastTs !== undefined ? new Date(lastTs + SAFE_MODE_MIN_INTERVAL_MS).toISOString() : null;
  return {
    safetyMode: SAFETY_MODE,
    createdLastHour: recent.length,
    maxPerHour: SAFE_MODE_MAX_PER_HOUR,
    lastCreatedAt: lastTs !== undefined ? new Date(lastTs).toISOString() : null,
    nextAllowedAt: nextAllowed,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// ENHANCED DUPLICATE DETECTION — Total + Date + Buyer
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Third layer of duplicate detection: check Shopify for existing orders
 * matching the eBay order's total amount, creation date window, and buyer username.
 *
 * This catches cases where:
 *   - The order_mappings DB was cleared or corrupted
 *   - The eBay-{orderId} tag was stripped from the Shopify order
 *   - The order was created by a different app (e.g. Codisto / legacy)
 *
 * Returns the matching Shopify order if found, null otherwise.
 * Non-fatal — errors are logged and null is returned so the caller can decide.
 */
export async function findDuplicateByTotalDateBuyer(
  accessToken: string,
  params: {
    total: string;         // eBay order total, e.g. "149.99"
    createdAt: string;     // ISO date string of the eBay order
    buyerUsername: string; // eBay buyer username
    ebayOrderId: string;   // eBay order ID (for note search)
  },
): Promise<{ id: number; name: string } | null> {
  try {
    const creds = await loadShopifyCredentials();

    // Search ±2 days around the eBay order's creation date
    const ebayDate = new Date(params.createdAt);
    const minDate = new Date(ebayDate.getTime() - 2 * 24 * 60 * 60 * 1000).toISOString();
    const maxDate = new Date(ebayDate.getTime() + 2 * 24 * 60 * 60 * 1000).toISOString();

    // NOTE: deliberately NOT filtered by source_name — orders created by
    // other apps (Marketplace Connect, Codisto) carry their own source_name,
    // and the whole point of this layer is to catch those.
    const url = new URL(`https://${creds.storeDomain}/admin/api/2024-01/orders.json`);
    url.searchParams.set('status', 'any');
    url.searchParams.set('created_at_min', minDate);
    url.searchParams.set('created_at_max', maxDate);
    url.searchParams.set('limit', '250');

    const response = await fetch(url.toString(), {
      headers: { 'X-Shopify-Access-Token': accessToken },
    });

    if (!response.ok) return null;

    const data = (await response.json()) as {
      orders: Array<{
        id: number;
        name: string;
        total_price: string;
        note?: string;
        tags?: string;
        source_name?: string;
      }>;
    };

    const targetTotal = parseFloat(params.total);

    for (const order of data.orders) {
      const orderTotal = parseFloat(order.total_price);

      // Totals must match within $0.01
      if (Math.abs(orderTotal - targetTotal) >= 0.01) continue;

      // Look for buyer username or eBay order ID in note or tags
      const note = order.note ?? '';
      const tags = order.tags ?? '';
      const buyerMatch = note.includes(params.buyerUsername) || tags.includes(params.buyerUsername);
      const idMatch = note.includes(params.ebayOrderId) || tags.includes(params.ebayOrderId);

      if (buyerMatch || idMatch) {
        warn(
          `[OrderSafety] Duplicate found via total+date+buyer: Shopify ${order.name} ` +
            `(total $${orderTotal}, buyer ${params.buyerUsername})`,
        );
        return { id: order.id, name: order.name };
      }
    }

    return null;
  } catch (err) {
    // Non-fatal: log and return null so the caller can make the final decision
    warn(`[OrderSafety] findDuplicateByTotalDateBuyer check error (non-fatal): ${err}`);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CUSTOM ERROR TYPES
// ─────────────────────────────────────────────────────────────────────────────

/** Thrown when a safety guard blocks order creation */
export class OrderSafetyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OrderSafetyError';
  }
}

/** Thrown when a duplicate order is detected */
export class DuplicateOrderError extends Error {
  public readonly existingOrderName: string;
  public readonly existingOrderId: number;
  public readonly detectionMethod: string;

  constructor(
    ebayOrderId: string,
    existingOrder: { id: number; name: string },
    detectionMethod: string,
  ) {
    super(
      `DUPLICATE DETECTED: eBay order ${ebayOrderId} already exists as Shopify ${existingOrder.name} ` +
        `(detected via: ${detectionMethod}). Refusing to create duplicate.`,
    );
    this.name = 'DuplicateOrderError';
    this.existingOrderName = existingOrder.name;
    this.existingOrderId = existingOrder.id;
    this.detectionMethod = detectionMethod;
  }
}
