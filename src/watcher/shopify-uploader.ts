/**
 * shopify-uploader.ts — Upload local JPEG files to a Shopify product as images.
 *
 * Uses Shopify's REST Admin API to upload product images with base64-encoded
 * file data (the "attachment" field).
 */

import fs from 'node:fs';
import path from 'node:path';
import { loadShopifyCredentials } from '../config/credentials.js';
import { getRawDb } from '../db/client.js';
import { info, warn, error as logError } from '../utils/logger.js';
import { denyExternalWrite } from '../safety/writer-quarantine.js';

/**
 * Get the Shopify access token from the DB.
 */
async function getShopifyToken(): Promise<string> {
  const db = await getRawDb();
  const row = db
    .prepare(`SELECT access_token FROM auth_tokens WHERE platform = 'shopify'`)
    .get() as { access_token: string } | undefined;

  if (!row?.access_token) {
    throw new Error('Shopify access token not found in database');
  }
  return row.access_token;
}

/**
 * Upload a single local image file to a Shopify product.
 *
 * Uses the REST Admin API:
 *   POST /admin/api/2024-01/products/{product_id}/images.json
 *   { image: { attachment: "<base64>", filename: "...", position: N } }
 */
async function uploadSingleImage(
  accessToken: string,
  storeDomain: string,
  productId: string,
  filePath: string,
  position: number,
): Promise<{ id: string; src: string } | null> {
  const filename = path.basename(filePath);
  const fileBuffer = fs.readFileSync(filePath);
  const base64 = fileBuffer.toString('base64');

  const url = `https://${storeDomain}/admin/api/2024-01/products/${productId}/images.json`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': accessToken,
    },
    body: JSON.stringify({
      image: {
        attachment: base64,
        filename,
        position: position + 1, // Shopify positions are 1-indexed
      },
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    logError(`[ShopifyUploader] Failed to upload ${filename} to product ${productId}: ${response.status} — ${text}`);
    return null;
  }

  const data = (await response.json()) as {
    image: { id: number; src: string };
  };

  return {
    id: String(data.image.id),
    src: data.image.src,
  };
}

/**
 * Upload multiple local image files to a Shopify product.
 *
 * @param shopifyProductId - The numeric Shopify product ID
 * @param imagePaths - Array of local file paths (JPEGs)
 * @returns Number of successfully uploaded images
 */
export async function uploadImagesToShopify(
  shopifyProductId: string,
  imagePaths: string[],
): Promise<{ uploaded: number; failed: number; imageUrls: string[] }> {
  denyExternalWrite('listingLifecycle', 'upload watcher images to Shopify');
  const accessToken = await getShopifyToken();
  const creds = await loadShopifyCredentials();

  info(`[ShopifyUploader] Uploading ${imagePaths.length} images to Shopify product ${shopifyProductId}`);

  let uploaded = 0;
  let failed = 0;
  const imageUrls: string[] = [];

  for (let i = 0; i < imagePaths.length; i++) {
    const filePath = imagePaths[i];

    // Verify file exists and is readable
    if (!fs.existsSync(filePath)) {
      warn(`[ShopifyUploader] File not found: ${filePath}`);
      failed++;
      continue;
    }

    const stat = fs.statSync(filePath);
    if (stat.size === 0) {
      warn(`[ShopifyUploader] Empty file: ${filePath}`);
      failed++;
      continue;
    }

    try {
      info(`[ShopifyUploader] Uploading image ${i + 1}/${imagePaths.length}: ${path.basename(filePath)} (${(stat.size / 1024 / 1024).toFixed(1)}MB)`);

      const result = await uploadSingleImage(
        accessToken,
        creds.storeDomain,
        shopifyProductId,
        filePath,
        i,
      );

      if (result) {
        uploaded++;
        imageUrls.push(result.src);
        info(`[ShopifyUploader] ✅ Uploaded: ${path.basename(filePath)} → ${result.src.substring(0, 80)}...`);
      } else {
        failed++;
      }

      // Rate limiting: Shopify allows ~2 requests/second for REST API
      // Wait 600ms between uploads to stay safe
      if (i < imagePaths.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 600));
      }
    } catch (err) {
      logError(`[ShopifyUploader] Error uploading ${path.basename(filePath)}: ${err}`);
      failed++;
    }
  }

  info(`[ShopifyUploader] Upload complete: ${uploaded} uploaded, ${failed} failed`);
  return { uploaded, failed, imageUrls };
}
