/**
 * Capabilities Registry — auto-discovery system for chat and UI.
 *
 * Every feature registers itself here. The chat system prompt and the
 * frontend welcome screen pull from this registry so new features are
 * surfaced automatically.
 */

export interface Capability {
  id: string;
  name: string;
  description: string;
  category: 'shopify' | 'ebay' | 'pipeline' | 'images' | 'analytics' | 'settings';
  examplePrompts: string[];
  apiEndpoints: string[];
  addedAt: string;   // ISO date
  isNew?: boolean;   // computed — true if added in last 7 days
}

// ---------------------------------------------------------------------------
// Internal store
// ---------------------------------------------------------------------------
const capabilities: Map<string, Capability> = new Map();

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Register (or replace) a capability. */
export function registerCapability(cap: Capability): void {
  capabilities.set(cap.id, cap);
}

/** Return every registered capability with `isNew` computed. */
export function getCapabilities(): Capability[] {
  const now = Date.now();
  const sevenDays = 7 * 24 * 60 * 60 * 1000;

  return Array.from(capabilities.values()).map((c) => ({
    ...c,
    isNew: now - new Date(c.addedAt).getTime() < sevenDays,
  }));
}

/** Return only capabilities added in the last 7 days. */
export function getNewCapabilities(): Capability[] {
  return getCapabilities().filter((c) => c.isNew);
}

// ---------------------------------------------------------------------------
// Pre-register all existing capabilities
// ---------------------------------------------------------------------------

registerCapability({
  id: 'local-listing-drafts',
  name: 'Local Listing Drafts',
  description: 'Preview local listing drafts and, when configured, save local revisions without changing Shopify or eBay.',
  category: 'ebay',
  examplePrompts: ['open a listing draft', 'save this local draft'],
  apiEndpoints: ['GET /api/listing-draft', 'POST /api/listing-draft'],
  addedAt: '2026-08-13',
});

registerCapability({
  id: 'operational-monitoring',
  name: 'Operational Monitoring',
  description: 'View a redacted read-only daily digest of ceremony outcomes, reconciliation exceptions, shadow parity, and catalog read health.',
  category: 'analytics',
  examplePrompts: ['show operational monitoring', 'show the daily operations digest'],
  apiEndpoints: ['GET /api/monitoring/digest', 'GET /health'],
  addedAt: '2026-08-26',
});

registerCapability({
  id: 'product-sync',
  name: 'Product Sync',
  description: 'Sync products from Shopify to eBay — push titles, prices, inventory and images.',
  category: 'shopify',
  examplePrompts: ['sync all products', 'sync products', 'push products to ebay'],
  apiEndpoints: ['POST /api/sync/products'],
  addedAt: '2025-12-01',
});

registerCapability({
  id: 'order-sync',
  name: 'Order Sync',
  description: 'Import eBay orders into Shopify for unified fulfilment.',
  category: 'ebay',
  examplePrompts: ['sync orders', 'import ebay orders'],
  apiEndpoints: ['POST /api/sync/trigger'],
  addedAt: '2025-12-01',
});

registerCapability({
  id: 'listings-browse',
  name: 'Browse Listings',
  description: 'View all eBay listings with search, filtering and pagination.',
  category: 'ebay',
  examplePrompts: ['list products', 'show listings', 'show my ebay listings'],
  apiEndpoints: ['GET /api/listings'],
  addedAt: '2025-12-01',
});

registerCapability({
  id: 'listings-stale',
  name: 'Stale Listings',
  description: 'Find listings that haven\'t been updated recently and may need attention.',
  category: 'ebay',
  examplePrompts: ['show stale listings', 'which listings are stale'],
  apiEndpoints: ['GET /api/listings/stale'],
  addedAt: '2025-12-15',
});

registerCapability({
  id: 'listings-health',
  name: 'Listing Health Report',
  description: 'Get an overall health report for your eBay listings — missing images, bad prices, etc.',
  category: 'analytics',
  examplePrompts: ['show listing health', 'listing health check', 'how healthy are my listings'],
  apiEndpoints: ['GET /api/listings/health'],
  addedAt: '2025-12-15',
});

registerCapability({
  id: 'listings-republish',
  name: 'Republish Stale Listings',
  description: 'Automatically republish stale eBay listings to boost visibility.',
  category: 'ebay',
  examplePrompts: ['republish stale listings', 'refresh old listings'],
  apiEndpoints: ['POST /api/listings/republish-stale'],
  addedAt: '2025-12-20',
});

registerCapability({
  id: 'listings-price-drops',
  name: 'Apply Price Drops',
  description: 'Automatically apply price drops to listings that haven\'t sold.',
  category: 'ebay',
  examplePrompts: ['apply price drops', 'drop prices on stale items'],
  apiEndpoints: ['POST /api/listings/apply-price-drops'],
  addedAt: '2025-12-20',
});

registerCapability({
  id: 'mappings',
  name: 'Category & Field Mappings',
  description: 'View and edit how Shopify fields map to eBay categories and item specifics.',
  category: 'settings',
  examplePrompts: ['show mappings', 'check mappings', 'update mapping'],
  apiEndpoints: ['GET /api/mappings', 'PUT /api/mappings'],
  addedAt: '2025-12-01',
});

registerCapability({
  id: 'mappings-bulk',
  name: 'Bulk Mapping Update',
  description: 'Import or export mappings in bulk, or update many at once.',
  category: 'settings',
  examplePrompts: ['export mappings', 'import mappings', 'bulk update mappings'],
  apiEndpoints: ['POST /api/mappings/bulk', 'GET /api/mappings/export', 'POST /api/mappings/import'],
  addedAt: '2026-01-10',
});

registerCapability({
  id: 'product-overrides',
  name: 'Per-Product Overrides',
  description: 'Set custom eBay title, price, or category for individual products.',
  category: 'ebay',
  examplePrompts: ['override product settings', 'set custom ebay title'],
  apiEndpoints: ['GET /api/product-overrides/:id', 'PUT /api/product-overrides/:id'],
  addedAt: '2026-01-15',
});

registerCapability({
  id: 'ebay-listing-metadata',
  name: 'eBay Listing Metadata',
  description: 'Fetch eBay category options and condition grade descriptions for listing prep.',
  category: 'ebay',
  examplePrompts: ['show ebay categories', 'list condition descriptions', 'fetch listing metadata'],
  apiEndpoints: ['GET /api/ebay/categories', 'GET /api/ebay/condition-descriptions'],
  addedAt: '2026-02-24',
});

registerCapability({
  id: 'auto-list',
  name: 'Auto-Listing Pipeline',
  description: 'Automatically list new Shopify products on eBay with AI-generated titles and descriptions.',
  category: 'pipeline',
  examplePrompts: ['auto list product', 'run auto listing', 'list new products on ebay'],
  apiEndpoints: ['POST /api/auto-list/:id', 'POST /api/auto-list/batch'],
  addedAt: '2026-01-20',
});

registerCapability({
  id: 'pipeline-status',
  name: 'Pipeline Job Status',
  description: 'Check the status of running or queued auto-listing pipeline jobs.',
  category: 'pipeline',
  examplePrompts: ['pipeline status', 'show pipeline jobs', 'check job status'],
  apiEndpoints: ['GET /api/pipeline/jobs'],
  addedAt: '2026-01-20',
});

registerCapability({
  id: 'image-processing',
  name: 'Image Processing',
  description: 'Process and optimize product images — remove backgrounds, resize, and enhance.',
  category: 'images',
  examplePrompts: ['process images', 'image status', 'optimize product photos'],
  apiEndpoints: ['GET /api/images/status', 'POST /api/images/process/:id'],
  addedAt: '2026-01-25',
});

registerCapability({
  id: 'chat-ai',
  name: 'AI Chat Assistant',
  description: 'Ask questions in natural language — the assistant can run commands, call APIs, and navigate the app.',
  category: 'analytics',
  examplePrompts: ['help', 'what can you do', 'how do I sync products'],
  apiEndpoints: ['POST /api/chat'],
  addedAt: '2025-12-01',
});

registerCapability({
  id: 'settings',
  name: 'App Settings',
  description: 'View and update sync intervals, pricing rules, auto-sync toggles, and more.',
  category: 'settings',
  examplePrompts: ['show settings', 'update settings', 'change sync interval'],
  apiEndpoints: ['GET /api/settings', 'PUT /api/settings'],
  addedAt: '2025-12-01',
});

registerCapability({
  id: 'analytics-logs',
  name: 'Analytics & Logs',
  description: 'View sync logs, error history, and performance analytics.',
  category: 'analytics',
  examplePrompts: ['show logs', 'recent errors', 'sync history'],
  apiEndpoints: ['GET /api/logs'],
  addedAt: '2025-12-01',
});

registerCapability({
  id: 'help-faq',
  name: 'Help & FAQ',
  description: 'Browse frequently asked questions or submit a new question for support.',
  category: 'settings',
  examplePrompts: ['help', 'FAQ', 'ask a question', 'how do I', 'frequently asked questions'],
  apiEndpoints: ['GET /api/help/faq', 'POST /api/help/questions', 'GET /api/help/questions'],
  addedAt: '2026-02-12',
});

registerCapability({
  id: 'feature-requests',
  name: 'Feature Requests',
  description: 'Submit, browse, and manage feature requests. Users can suggest improvements and track their status.',
  category: 'settings',
  examplePrompts: ['submit a feature request', 'show feature requests', 'what features are planned'],
  apiEndpoints: ['GET /api/features', 'POST /api/features', 'PUT /api/features/:id', 'DELETE /api/features/:id'],
  addedAt: '2026-02-12',
});

registerCapability({
  id: 'description-prompt-settings',
  name: 'Description Prompt Settings',
  description:
    'Configure the AI prompt template used to generate product descriptions in the auto-listing pipeline. Also manage PhotoRoom template, pipeline toggles, and other Shopify-related settings.',
  category: 'settings',
  examplePrompts: [
    'update the description prompt',
    'change AI prompt for listings',
    'configure photoroom template',
    'enable auto descriptions',
  ],
  apiEndpoints: ['GET /api/settings', 'PUT /api/settings'],
  addedAt: '2026-02-12',
});

registerCapability({
  id: 'status',
  name: 'System Status',
  description: 'Quick overview of connections, product counts, order counts, and uptime.',
  category: 'analytics',
  examplePrompts: ['show status', 'check status', 'is everything working'],
  apiEndpoints: ['GET /api/status'],
  addedAt: '2025-12-01',
});

// Phase 3: Photo Editing + Templates
registerCapability({
  id: 'photo-templates',
  name: 'Photo Templates',
  description: 'Create, manage, and apply reusable PhotoRoom settings templates. Set defaults per StyleShoots category for auto-apply on new photos.',
  category: 'images',
  examplePrompts: [
    'list templates',
    'what templates do we have',
    'save settings as small lenses template',
    'apply the small lens template',
    'set this as default for small cameras',
  ],
  apiEndpoints: [
    'GET /api/templates',
    'POST /api/templates',
    'PUT /api/templates/:id',
    'DELETE /api/templates/:id',
    'POST /api/templates/:id/apply/:productId',
    'POST /api/templates/:id/set-default',
  ],
  addedAt: '2026-02-16',
});

registerCapability({
  id: 'chat-photo-editing',
  name: 'Chat Photo Editing',
  description: 'Edit product photos through natural language chat commands. Adjust background color, padding, shadow, and trigger reprocessing.',
  category: 'images',
  examplePrompts: [
    'add more white space',
    'remove the shadow',
    'make background gray',
    'tighter crop',
    'reprocess all photos',
  ],
  apiEndpoints: [
    'POST /api/products/:id/images/reprocess',
    'POST /api/products/:id/images/reprocess-all',
  ],
  addedAt: '2026-02-16',
});
