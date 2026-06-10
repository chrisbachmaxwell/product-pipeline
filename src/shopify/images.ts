/**
 * Shared Shopify product image upload helpers.
 *
 * Used by the draft approval flow, the template-apply route, and the
 * automated photo pipeline so they all behave the same way:
 * REPLACE semantics — existing images are deleted, then the new set is
 * uploaded in order. This prevents the raw+processed duplication that
 * happened when processed photos were appended next to originals.
 */

import fs from 'node:fs';
import path from 'node:path';
import { info, warn, error as logError } from '../utils/logger.js';

const API_VERSION = '2024-01';

/** An image to upload: an http(s) URL, a local file path, or a raw buffer. */
export type ImageInput =
  | string
  | { buffer: Buffer; filename?: string };

export interface UploadResult {
  uploaded: number;
  failed: number;
  deleted: number;
}

function imagesUrl(storeDomain: string, productId: string): string {
  return `https://${storeDomain}/admin/api/${API_VERSION}/products/${productId}/images.json`;
}

/**
 * List a product's current images.
 */
export async function listProductImages(
  accessToken: string,
  storeDomain: string,
  productId: string,
): Promise<Array<{ id: number; src: string; position: number; alt: string | null }>> {
  const res = await fetch(imagesUrl(storeDomain, productId), {
    headers: { 'X-Shopify-Access-Token': accessToken },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Shopify image fetch failed (${res.status}): ${text}`);
  }
  const data = (await res.json()) as any;
  return (data.images ?? []).map((img: any) => ({
    id: img.id,
    src: img.src,
    position: img.position,
    alt: img.alt ?? null,
  }));
}

/**
 * Delete all existing images on a product. Non-fatal on per-image failure.
 */
export async function deleteAllProductImages(
  accessToken: string,
  storeDomain: string,
  productId: string,
): Promise<number> {
  let deleted = 0;
  try {
    const existing = await listProductImages(accessToken, storeDomain, productId);
    for (const img of existing) {
      const delUrl = `https://${storeDomain}/admin/api/${API_VERSION}/products/${productId}/images/${img.id}.json`;
      const res = await fetch(delUrl, {
        method: 'DELETE',
        headers: { 'X-Shopify-Access-Token': accessToken },
      });
      if (res.ok) deleted++;
      await new Promise((r) => setTimeout(r, 300)); // rate limit
    }
    if (existing.length > 0) {
      info(`[ShopifyImages] Deleted ${deleted}/${existing.length} existing images on product ${productId}`);
    }
  } catch (err) {
    warn(`[ShopifyImages] Failed to clear existing images (non-fatal): ${err}`);
  }
  return deleted;
}

/**
 * Append a single image to a product without touching existing images.
 */
export async function appendProductImage(
  accessToken: string,
  storeDomain: string,
  productId: string,
  image: ImageInput,
  options?: { position?: number; alt?: string | null },
): Promise<boolean> {
  const body = buildImageBody(image, options?.position, options?.alt);
  if (!body) return false;

  const res = await fetch(imagesUrl(storeDomain, productId), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': accessToken,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    warn(`[ShopifyImages] Image upload failed: ${res.status} — ${text}`);
    return false;
  }
  return true;
}

/**
 * Replace a product's images: delete all existing, then upload `images`
 * in order (position 1..n). Mixed inputs are fine — URLs are passed as
 * `src`, local paths and buffers are base64 `attachment`s.
 */
export async function replaceProductImages(
  accessToken: string,
  storeDomain: string,
  productId: string,
  images: ImageInput[],
  options?: { alts?: Array<string | null> },
): Promise<UploadResult> {
  const deleted = await deleteAllProductImages(accessToken, storeDomain, productId);

  let uploaded = 0;
  let failed = 0;

  for (let i = 0; i < images.length; i++) {
    try {
      const ok = await appendProductImage(accessToken, storeDomain, productId, images[i], {
        position: i + 1,
        alt: options?.alts?.[i] ?? null,
      });
      if (ok) uploaded++;
      else failed++;

      // Rate limit: ~2 req/sec for Shopify REST
      if (i < images.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, 600));
      }
    } catch (err) {
      logError(`[ShopifyImages] Image upload error: ${err}`);
      failed++;
    }
  }

  info(`[ShopifyImages] Replaced images on product ${productId}: ${uploaded} uploaded, ${failed} failed`);
  return { uploaded, failed, deleted };
}

function buildImageBody(
  image: ImageInput,
  position?: number,
  alt?: string | null,
): Record<string, any> | null {
  const meta: Record<string, any> = {};
  if (position !== undefined) meta.position = position;
  if (alt) meta.alt = alt;

  if (typeof image !== 'string') {
    return {
      image: {
        attachment: image.buffer.toString('base64'),
        filename: image.filename ?? `image-${Date.now()}.png`,
        ...meta,
      },
    };
  }

  if (image.startsWith('http://') || image.startsWith('https://')) {
    return { image: { src: image, ...meta } };
  }

  // Local file path — base64 encode
  if (!fs.existsSync(image)) {
    warn(`[ShopifyImages] Image file not found: ${image}`);
    return null;
  }
  return {
    image: {
      attachment: fs.readFileSync(image).toString('base64'),
      filename: path.basename(image),
      ...meta,
    },
  };
}
