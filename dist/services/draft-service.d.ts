/**
 * Draft Service — manages product drafts for the staging/review system.
 *
 * CRITICAL: The pipeline must NEVER overwrite live Shopify product data automatically.
 * All processed content goes through the draft system first.
 */
export declare function markdownToHtml(md: string): string;
export interface Draft {
    id: number;
    shopify_product_id: string;
    draft_title: string | null;
    draft_description: string | null;
    draft_images_json: string | null;
    original_title: string | null;
    original_description: string | null;
    original_images_json: string | null;
    tags: string | null;
    status: 'pending' | 'approved' | 'rejected' | 'partial';
    auto_publish: number;
    created_at: number;
    updated_at: number;
    reviewed_at: number | null;
    reviewed_by: string | null;
}
export interface DraftWithParsed extends Draft {
    draftImages: string[];
    originalImages: string[];
    parsedTags: string[];
}
export interface CreateDraftInput {
    title?: string;
    description?: string;
    images?: string[];
    originalTitle?: string;
    originalDescription?: string;
    originalImages?: string[];
    tags?: string[];
}
export interface ApproveOptions {
    photos: boolean;
    description: boolean;
    publish?: boolean;
}
/**
 * Create a draft for a Shopify product. If a pending draft already exists
 * for this product, it will be updated instead.
 */
export declare function createDraft(shopifyProductId: string, input: CreateDraftInput): Promise<number>;
/**
 * Get a single draft by ID.
 */
export declare function getDraft(draftId: number): Promise<DraftWithParsed | null>;
/**
 * Get the pending draft for a specific Shopify product.
 */
export declare function getDraftByProduct(shopifyProductId: string): Promise<DraftWithParsed | null>;
/**
 * List all pending drafts (for the review queue).
 */
export declare function listPendingDrafts(options?: {
    status?: string;
    limit?: number;
    offset?: number;
}): Promise<{
    data: DraftWithParsed[];
    total: number;
}>;
/**
 * Approve a draft and push selected content to Shopify.
 *
 * CRITICAL: Only pushes content explicitly approved. Never overwrites anything
 * without explicit user action.
 */
export interface ApproveDraftResult {
    success: boolean;
    error?: string;
    published?: boolean;
    publishError?: string;
}
export declare function approveDraft(draftId: number, options: ApproveOptions): Promise<ApproveDraftResult>;
/**
 * Reject a draft.
 */
export declare function rejectDraft(draftId: number): Promise<{
    success: boolean;
    error?: string;
}>;
/**
 * Update a draft's content before approving.
 */
export declare function updateDraft(draftId: number, changes: Partial<CreateDraftInput>): Promise<{
    success: boolean;
    error?: string;
}>;
/**
 * Get the pending draft count (for navigation badge).
 */
export declare function getPendingDraftCount(): Promise<number>;
/**
 * Check if a product type has auto-publish enabled.
 */
export declare function getAutoPublishSetting(productType: string): Promise<boolean>;
/**
 * Toggle auto-publish for a product type.
 */
export declare function setAutoPublishSetting(productType: string, enabled: boolean): Promise<void>;
/**
 * Get all auto-publish settings.
 */
export declare function getAllAutoPublishSettings(): Promise<{
    perType: Array<{
        product_type: string;
        enabled: boolean;
    }>;
    global: {
        autoPublishNoPhotos: boolean;
        autoPublishNoDescription: boolean;
    };
}>;
/**
 * Update global auto-publish settings.
 */
export declare function updateGlobalAutoPublishSettings(settings: {
    autoPublishNoPhotos?: boolean;
    autoPublishNoDescription?: boolean;
}): Promise<void>;
/**
 * Check if a Shopify product has existing content (photos and/or description).
 */
export declare function checkExistingContent(shopifyProductId: string): Promise<{
    hasPhotos: boolean;
    hasDescription: boolean;
    title: string;
    description: string;
    images: string[];
    tags: string[];
}>;
/**
 * Fetch tags for multiple products in parallel.
 * Returns a map of shopify_product_id → tags array.
 */
export declare function fetchProductTagsBatch(productIds: string[]): Promise<Record<string, string[]>>;
