/**
 * Orchestrates product image processing for listings.
 *
 * Uses the configured image processing service (self-hosted or PhotoRoom)
 * via the factory. If no service is available, returns original URLs.
 */
export declare function processProductImages(shopifyProduct: any): Promise<string[]>;
/**
 * Upload processed images back to Shopify, replacing the product's
 * existing images so raw originals don't linger next to processed copies.
 * Returns the new image URLs from Shopify.
 */
export declare function uploadToShopify(productId: string, imageBuffers: Buffer[]): Promise<string[]>;
