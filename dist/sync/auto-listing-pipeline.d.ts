export declare function processNewProduct(shopifyProduct: any): Promise<{
    description: string;
    ebayCategory: string;
    ready: boolean;
}>;
/**
 * Process product images via PhotoRoom template rendering.
 *
 * If PHOTOROOM_API_KEY is not set, falls back to returning the original
 * Shopify image URLs (no processing). Processed images are saved to a local
 * temp directory and their file paths are returned.
 */
export declare function processProductImages(shopifyProduct: any): Promise<string[]>;
export interface AutoListOptions {
    /**
     * Reuse a previously generated AI description/category if one exists
     * instead of calling OpenAI again. Used when the pipeline re-runs because
     * photos arrived after the product was first processed.
     */
    reuseExistingDescription?: boolean;
    /**
     * Never auto-publish — always leave the draft for manual review.
     * Set when the photo→product match is low-confidence.
     */
    requireReview?: boolean;
}
export declare function autoListProduct(shopifyProductId: string, options?: AutoListOptions): Promise<{
    success: boolean;
    jobId?: string;
    description?: string;
    categoryId?: string;
    images?: string[];
    error?: string;
}>;
