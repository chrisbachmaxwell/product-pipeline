import {
  MIGRATION_RESPONSIBILITIES,
  WRITER_RESPONSIBILITIES,
  type MigrationResponsibility,
  type WriterResponsibility,
} from '../safety/responsibilities.js';

export { MIGRATION_RESPONSIBILITIES, WRITER_RESPONSIBILITIES };
export type Responsibility = MigrationResponsibility;
export type { MigrationResponsibility, WriterResponsibility };

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
] as const;

/**
 * Actions admitted by the schema-v5 rebuilt idempotency_intents table only.
 * `recover_create_ebay_listing` is the one-shot residue-removal recovery for
 * an unresolved production listing-create job (Brain L34): it deletes the
 * exact unpublished offer and inventory item that job left behind, never
 * creates or publishes anything, and is structurally bound to an outstanding
 * unresolved create job on the identical target.
 */
export const RECOVERY_INTENT_ACTIONS = ['recover_create_ebay_listing'] as const;

export const ALL_INTENT_ACTIONS = [...INTENT_ACTIONS, ...RECOVERY_INTENT_ACTIONS] as const;

export type IntentAction = (typeof ALL_INTENT_ACTIONS)[number];

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
} as const satisfies Record<(typeof INTENT_ACTIONS)[number], WriterResponsibility>;

/** The complete runtime action→responsibility map (schema v5). */
export const ALL_INTENT_ACTION_RESPONSIBILITY = {
  ...INTENT_ACTION_RESPONSIBILITY,
  recover_create_ebay_listing: 'listingCreate',
} as const satisfies Record<IntentAction, WriterResponsibility>;

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

/**
 * `resolved_residue_removed` (schema v5) is the truthful terminal outcome for
 * a listingCreate job whose dispatch left a durable remote artifact (an
 * unpublished offer / inventory item) that a separately approved recovery
 * ceremony later verifiably removed. It is neither `resolved_existing` (no
 * listing exists) nor `confirmed_missing` (the artifact was not absent from
 * the start).
 */
export type AttemptResolution =
  | 'resolved_existing'
  | 'confirmed_missing'
  | 'resolved_residue_removed';

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
export const TARGET_EFFECT_RESPONSIBILITIES = [
  'listingCreate',
  'listingEndRelist',
  'price',
  'inventory',
  'fulfillment',
] as const;

export type TargetEffectResponsibility = (typeof TARGET_EFFECT_RESPONSIBILITIES)[number];

/**
 * `effect_residue_removed` (schema v5) records that the exact remote residue
 * a listingCreate dispatch left behind has been verified removed. The schema
 * restricts it to listingCreate observations, and it pairs exclusively with
 * the `resolved_residue_removed` attempt resolution.
 */
export type TargetEffect = 'effect_observed' | 'effect_absent' | 'effect_residue_removed';

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

export type OperationalStoreMonitoring = Readonly<{
  currentJobs: Readonly<{
    reserved: number;
    dispatching: number;
    reconciliationRequired: number;
    resolvedExisting: number;
    confirmedMissing: number;
    resolvedResidueRemoved: number;
  }>;
  previousUtcDay: Readonly<{
    dateUtc: string;
    windowStartUtc: string;
    windowEndUtc: string;
    writes: Readonly<{
      performed: number;
      succeeded: number;
      failed: number;
      unresolved: number;
    }>;
    reconciliations: Readonly<{
      passed: number;
      blocked: number;
      failed: number;
    }>;
    exceptions: Readonly<{
      info: number;
      warning: number;
      critical: number;
    }>;
  }>;
}>;
