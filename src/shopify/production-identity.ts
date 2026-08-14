/** Fixed tenant identity used by the bounded Shopify credential-maintenance path. */
export const PRODUCT_PIPELINE_SHOPIFY_IDENTITY = Object.freeze({
  clientId: '2db0555e4848a8264383dc0edfcfb8fe',
  storeDomain: 'usedcameragear.myshopify.com',
  shopGid: 'gid://shopify/Shop/86254518563',
  adminApiVersion: '2026-07',
  canonicalReadScopes: Object.freeze([
    'read_fulfillments',
    'read_inventory',
    'read_orders',
    'read_products',
  ] as const),
});
