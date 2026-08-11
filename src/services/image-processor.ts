import { info, warn } from '../utils/logger.js';
import { getImageService, timedImageCall } from './image-service-factory.js';
import { denyExternalWrite } from '../safety/writer-quarantine.js';

/**
 * Orchestrates product image processing for listings.
 *
 * Uses the configured image processing service (self-hosted or PhotoRoom)
 * via the factory. If no service is available, returns original URLs.
 */

export async function processProductImages(
  shopifyProduct: any,
): Promise<string[]> {
  const images: Array<{ src: string }> = shopifyProduct?.images ?? [];

  if (images.length === 0) {
    warn('[ImageProcessor] Product has no images — nothing to process');
    return [];
  }

  const imageUrls = images.map((img) => img.src);

  let imageService;
  try {
    imageService = await getImageService();
  } catch {
    warn('[ImageProcessor] No image service available — returning original image URLs');
    return imageUrls;
  }

  info(`[ImageProcessor] Processing ${imageUrls.length} images`);

  const processedBuffers = await timedImageCall(
    `batch ${imageUrls.length} images`,
    () => imageService.processAllImages(imageUrls, {
      background: 'FFFFFF',
      shadow: true,
      padding: 0.1,
    }),
  );

  // Convert buffers to base64 data URLs so they can be used directly
  const dataUrls = processedBuffers.map((buf) => {
    const base64 = buf.toString('base64');
    return `data:image/png;base64,${base64}`;
  });

  info(`[ImageProcessor] Returned ${dataUrls.length} processed images as data URLs`);
  return dataUrls;
}

/**
 * Upload processed images back to Shopify, replacing the product's
 * existing images so raw originals don't linger next to processed copies.
 * Returns the new image URLs from Shopify.
 */
export async function uploadToShopify(
  productId: string,
  imageBuffers: Buffer[],
): Promise<string[]> {
  denyExternalWrite('listingLifecycle', 'upload processed images to Shopify');
  const { getRawDb } = await import('../db/client.js');
  const { loadShopifyCredentials } = await import('../config/credentials.js');
  const { replaceProductImages, listProductImages } = await import('../shopify/images.js');

  const db = await getRawDb();
  const tokenRow = db
    .prepare(`SELECT access_token FROM auth_tokens WHERE platform = 'shopify'`)
    .get() as { access_token: string } | undefined;
  if (!tokenRow?.access_token) {
    throw new Error('Shopify access token not found — cannot upload images');
  }
  const creds = await loadShopifyCredentials();

  const result = await replaceProductImages(
    tokenRow.access_token,
    creds.storeDomain,
    productId,
    imageBuffers.map((buffer, i) => ({ buffer, filename: `processed-${productId}-${i + 1}.png` })),
  );
  info(
    `[ImageProcessor] Uploaded ${result.uploaded}/${imageBuffers.length} processed images to product ${productId} (${result.failed} failed)`,
  );

  const uploaded = await listProductImages(tokenRow.access_token, creds.storeDomain, productId);
  return uploaded.sort((a, b) => a.position - b.position).map((img) => img.src);
}
