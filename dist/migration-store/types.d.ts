import { MIGRATION_RESPONSIBILITIES, WRITER_RESPONSIBILITIES, type MigrationResponsibility, type WriterResponsibility } from '../safety/responsibilities.js';
export { MIGRATION_RESPONSIBILITIES, WRITER_RESPONSIBILITIES };
export type Responsibility = MigrationResponsibility;
export type { MigrationResponsibility, WriterResponsibility };
export declare const INTENT_ACTIONS: readonly ["create_ebay_listing", "revise_ebay_listing", "end_or_relist_ebay_listing", "update_mapping", "update_ebay_price", "update_ebay_inventory", "import_shopify_order", "sync_fulfillment", "sync_feedback"];
export type IntentAction = (typeof INTENT_ACTIONS)[number];
export declare const INTENT_ACTION_RESPONSIBILITY: {
    readonly create_ebay_listing: "listingCreate";
    readonly revise_ebay_listing: "listingRevise";
    readonly end_or_relist_ebay_listing: "listingEndRelist";
    readonly update_mapping: "mapping";
    readonly update_ebay_price: "price";
    readonly update_ebay_inventory: "inventory";
    readonly import_shopify_order: "orderImport";
    readonly sync_fulfillment: "fulfillment";
    readonly sync_feedback: "feedback";
};
export type EbayEnvironment = 'sandbox' | 'production';
export type OwnershipOwner = 'marketplace_connect' | 'paused' | 'product_pipeline';
export type ShopifyResourceKind = 'product' | 'variant' | 'order';
export type EbayResourceKind = 'inventory_sku' | 'offer' | 'listing' | 'order';
export type SourcePlatform = 'shopify' | 'ebay' | 'marketplace_connect';
export type IntegrationScope = {
    shopifyStoreDomain: string;
    ebayEnvironment: EbayEnvironment;
    ebaySellerId: string;
    ebayMarketplaceId: string;
};
export type AuditContext = {
    eventId: string;
    occurredAtUtc: string;
};
export type Digest = `sha256:${string}`;
export type ShopifyIdentityInput = {
    platform: 'shopify';
    kind: ShopifyResourceKind;
    bindingKey: string;
    storeDomain: string;
    externalGid: string;
};
export type EbayIdentityInput = {
    platform: 'ebay';
    kind: EbayResourceKind;
    bindingKey: string;
    environment: EbayEnvironment;
    sellerId: string;
    marketplaceId: string;
    externalId: string;
};
export type ExternalIdentityInput = ShopifyIdentityInput | EbayIdentityInput;
export type ExternalIdentity = {
    identityKey: Digest;
    scopeKey: Digest;
    platform: 'shopify' | 'ebay';
    resourceKind: ShopifyResourceKind | EbayResourceKind;
    bindingKey: string;
    externalId: string;
    createdAtUtc: string;
};
export type AttemptOutcome = 'outcome_unknown';
export type AttemptResolution = 'resolved_existing' | 'confirmed_missing';
export type ReconciliationMode = 'shadow' | 'test_lane' | 'production_canary';
export type ReconciliationStatus = 'passed' | 'blocked' | 'failed';
export type ReconciliationSeverity = 'info' | 'warning' | 'critical';
export type ReconciliationExceptionInput = {
    exceptionId: string;
    code: string;
    severity: ReconciliationSeverity;
    subjectIdentityKey?: string | null;
    detailsDigest: string;
};
export type ListingReviseEffect = 'revised_state_observed' | 'revised_state_absent';
export type ListingReviseObservationInput = {
    observationId: string;
    intentKey: string;
    effect: ListingReviseEffect;
    observedDigest: string;
};
/**
 * Responsibilities whose post-dispatch reconciliation records a durable
 * target-effect observation in the schema-v3 slice. orderImport binds to
 * order_links and listingRevise to listing_revise_observations instead.
 */
export declare const TARGET_EFFECT_RESPONSIBILITIES: readonly ["listingCreate", "listingEndRelist", "price", "inventory", "fulfillment"];
export type TargetEffectResponsibility = (typeof TARGET_EFFECT_RESPONSIBILITIES)[number];
export type TargetEffect = 'effect_observed' | 'effect_absent';
export type TargetEffectObservationInput = {
    observationId: string;
    intentKey: string;
    responsibility: TargetEffectResponsibility;
    effect: TargetEffect;
    observedDigest: string;
};
export type AuditVerification = {
    valid: boolean;
    recordCount: number;
    headHash: string | null;
    error?: string;
};
