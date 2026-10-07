/**
 * The operator's "keep this off eBay" Shopify product tag. A product
 * carrying it never enters the ready queue (so no Publish-All run, box
 * runner, or schedule lists it) and the restock sweep never relists it.
 * Removing the tag in Shopify makes the product eligible again on the next
 * catalog refresh. Tags arrive lowercased and trimmed from the capture.
 */
export const EBAY_HOLD_TAG = 'no-ebay';

export function hasEbayHoldTag(tags: readonly string[] | null | undefined): boolean {
  return (tags ?? []).some((tag) => tag.trim().toLowerCase() === EBAY_HOLD_TAG);
}
