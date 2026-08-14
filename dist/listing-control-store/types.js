export const LISTING_MANAGEMENT_MODELS = [
    'inventory_api',
    'trading_api',
    'unmanaged',
    'unknown',
];
export const LISTING_DRAFT_STATES = ['draft', 'reviewed', 'stale'];
export const LISTING_FIELD_NAMES = [
    'title',
    'category',
    'condition',
    'condition_description',
    'price',
    'quantity',
    'description',
    'images',
    'item_specifics',
    'identifiers',
    'fulfillment_policy',
    'payment_policy',
    'return_policy',
    'merchant_location',
];
export const LISTING_AI_PROPOSABLE_FIELDS = [
    'title',
    'category',
    'condition',
    'condition_description',
    'description',
    'images',
    'fulfillment_policy',
    'payment_policy',
    'return_policy',
    'merchant_location',
];
export const LISTING_PROPOSAL_OUTCOMES = [
    'ready',
    'no_change',
    'needs_human',
    'failed',
];
export const LISTING_PROPOSAL_EVENT_TYPES = [
    'queued',
    'generating',
    ...LISTING_PROPOSAL_OUTCOMES,
    'approved',
    'rejected',
    'stale',
];
export const LISTING_PROPOSAL_CONFIDENCE_LEVELS = ['high', 'medium', 'low'];
export const LISTING_PROPOSAL_FIELD_REASON_CODES = [
    'shopify_authoritative',
    'ebay_authoritative',
    'preserve_current',
    'operator_override',
    'policy_selected',
    'missing_source',
    'conflicting_sources',
    'unsupported_change',
];
export const LISTING_PROPOSAL_WARNING_CODES = [
    'missing_required',
    'source_conflict',
    'policy_exception',
    'low_confidence',
    'unsupported_fact',
];
export const LISTING_PROPOSAL_FAILURE_CODES = [
    'model_unavailable',
    'invalid_output',
    'policy_blocked',
    'stale_base',
    'rate_limited',
    'internal_error',
];
export const LISTING_PROPOSAL_REVIEW_REASON_CODES = [
    'accepted',
    'operator_rejected',
    'base_changed',
    'superseded',
];
