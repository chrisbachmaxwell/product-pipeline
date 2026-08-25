import { MIGRATION_RESPONSIBILITIES, WRITER_RESPONSIBILITIES, } from '../safety/responsibilities.js';
export { MIGRATION_RESPONSIBILITIES, WRITER_RESPONSIBILITIES };
export const INTENT_ACTIONS = [
    'create_ebay_listing',
    'revise_ebay_listing',
    'end_or_relist_ebay_listing',
    'update_mapping',
    'update_ebay_price',
    'update_ebay_inventory',
    'import_shopify_order',
    'sync_fulfillment',
    'sync_feedback',
];
export const INTENT_ACTION_RESPONSIBILITY = {
    create_ebay_listing: 'listingCreate',
    revise_ebay_listing: 'listingRevise',
    end_or_relist_ebay_listing: 'listingEndRelist',
    update_mapping: 'mapping',
    update_ebay_price: 'price',
    update_ebay_inventory: 'inventory',
    import_shopify_order: 'orderImport',
    sync_fulfillment: 'fulfillment',
    sync_feedback: 'feedback',
};
/**
 * Responsibilities whose post-dispatch reconciliation records a durable
 * target-effect observation in the schema-v3 slice. orderImport binds to
 * order_links and listingRevise to listing_revise_observations instead.
 */
export const TARGET_EFFECT_RESPONSIBILITIES = [
    'listingCreate',
    'listingEndRelist',
    'price',
    'inventory',
    'fulfillment',
];
