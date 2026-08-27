import { MIGRATION_RESPONSIBILITIES, WRITER_RESPONSIBILITIES, } from '../safety/responsibilities.js';
export { MIGRATION_RESPONSIBILITIES, WRITER_RESPONSIBILITIES };
/**
 * The exact schema-v1 intent-action vocabulary. This list (and the matching
 * responsibility map below) is interpolated into the immutable schema-v1
 * migration SQL, whose checksum every existing store carries; it must NEVER
 * change. Actions added by later schema versions live in
 * RECOVERY_INTENT_ACTIONS and join the runtime vocabulary through
 * ALL_INTENT_ACTIONS.
 */
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
/**
 * Actions admitted by the schema-v5 rebuilt idempotency_intents table only.
 * `recover_create_ebay_listing` is the one-shot residue-removal recovery for
 * an unresolved production listing-create job (Brain L34): it deletes the
 * exact unpublished offer and inventory item that job left behind, never
 * creates or publishes anything, and is structurally bound to an outstanding
 * unresolved create job on the identical target.
 */
export const RECOVERY_INTENT_ACTIONS = ['recover_create_ebay_listing'];
export const ALL_INTENT_ACTIONS = [...INTENT_ACTIONS, ...RECOVERY_INTENT_ACTIONS];
/** Schema-v1 map — interpolated into immutable v1 SQL; never change it. */
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
/** The complete runtime action→responsibility map (schema v5). */
export const ALL_INTENT_ACTION_RESPONSIBILITY = {
    ...INTENT_ACTION_RESPONSIBILITY,
    recover_create_ebay_listing: 'listingCreate',
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
