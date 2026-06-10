/**
 * Shared Shopify product image upload helpers.
 *
 * Used by the draft approval flow, the template-apply route, and the
 * automated photo pipeline so they all behave the same way:
 * REPLACE semantics — existing images are deleted, then the new set is
 * uploaded in order. This prevents the raw+processed duplication that
 * happened when processed photos were appended next to originals.
 */
/** An image to upload: an http(s) URL, a local file path, or a raw buffer. */
export type ImageInput = string | {
    buffer: Buffer;
    filename?: string;
};
export interface UploadResult {
    uploaded: number;
    failed: number;
    deleted: number;
}
/**
 * List a product's current images.
 */
export declare function listProductImages(accessToken: string, storeDomain: string, productId: string): Promise<Array<{
    id: number;
    src: string;
    position: number;
    alt: string | null;
}>>;
/**
 * Delete all existing images on a product. Non-fatal on per-image failure.
 */
export declare function deleteAllProductImages(accessToken: string, storeDomain: string, productId: string): Promise<number>;
/**
 * Append a single image to a product without touching existing images.
 */
export declare function appendProductImage(accessToken: string, storeDomain: string, productId: string, image: ImageInput, options?: {
    position?: number;
    alt?: string | null;
}): Promise<boolean>;
/**
 * Replace a product's images: delete all existing, then upload `images`
 * in order (position 1..n). Mixed inputs are fine — URLs are passed as
 * `src`, local paths and buffers are base64 `attachment`s.
 */
export declare function replaceProductImages(accessToken: string, storeDomain: string, productId: string, images: ImageInput[], options?: {
    alts?: Array<string | null>;
}): Promise<UploadResult>;
