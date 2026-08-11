/**
 * TIM Condition Tagging Service
 * Applies condition tags to Shopify products based on TIM data.
 * Tag format: condition-{value} (e.g., condition-excellent_plus)
 */
import { loadShopifyCredentials } from '../config/credentials.js';
import { fetchDetailedShopifyProduct } from '../shopify/products.js';
import { info, error as logError } from '../utils/logger.js';
import { denyExternalWrite } from '../safety/writer-quarantine.js';
const CONDITION_TAG_PREFIX = 'condition-';
/**
 * Apply a condition tag to a Shopify product.
 * Removes any existing condition-* tag before adding the new one.
 * Skips tagging if condition is null.
 */
export async function applyConditionTag(accessToken, productId, condition) {
    denyExternalWrite('listingLifecycle', 'apply Shopify product condition tag');
    if (!condition || condition === 'null') {
        return { success: true, productId, skipped: true };
    }
    const newTag = `${CONDITION_TAG_PREFIX}${condition}`;
    try {
        // Fetch current product to get existing tags
        const product = await fetchDetailedShopifyProduct(accessToken, productId);
        if (!product) {
            return { success: false, productId, error: 'Product not found' };
        }
        const currentTags = product.tags ?? [];
        const existingConditionTag = currentTags.find(t => t.startsWith(CONDITION_TAG_PREFIX));
        // Skip if already tagged with the same value
        if (existingConditionTag === newTag) {
            info(`[TIM-Tag] Product ${productId} already tagged: ${newTag}`);
            return { success: true, productId, previousTag: existingConditionTag, newTag };
        }
        // Remove existing condition tags and add the new one
        const updatedTags = currentTags.filter(t => !t.startsWith(CONDITION_TAG_PREFIX));
        updatedTags.push(newTag);
        // Write tags back to Shopify via REST API
        const creds = await loadShopifyCredentials();
        const url = `https://${creds.storeDomain}/admin/api/2024-01/products/${productId}.json`;
        const response = await fetch(url, {
            method: 'PUT',
            headers: {
                'X-Shopify-Access-Token': accessToken,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                product: {
                    id: Number(productId),
                    tags: updatedTags.join(', '),
                },
            }),
        });
        if (!response.ok) {
            const body = await response.text();
            throw new Error(`Shopify API error ${response.status}: ${body}`);
        }
        info(`[TIM-Tag] Product ${productId}: ${existingConditionTag ?? 'none'} → ${newTag}`);
        return {
            success: true,
            productId,
            previousTag: existingConditionTag,
            newTag,
        };
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logError(`[TIM-Tag] Failed to tag product ${productId}: ${msg}`);
        return { success: false, productId, error: msg };
    }
}
/**
 * Check if a product has a condition tag and return it.
 */
export function getConditionTagFromTags(tags) {
    const tag = tags.find(t => t.startsWith(CONDITION_TAG_PREFIX));
    return tag ?? null;
}
