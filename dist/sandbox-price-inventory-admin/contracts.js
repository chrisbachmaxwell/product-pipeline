import { createHash } from 'node:crypto';
export const SANDBOX_ALIGNMENT_SCOPE = Object.freeze({
    schemaVersion: 1,
    environment: 'sandbox',
    shopify: Object.freeze({
        storeDomain: 'usedcameragear.myshopify.com',
        shopId: 'gid://shopify/Shop/86254518563',
        appClientId: '2db0555e4848a8264383dc0edfcfb8fe',
        apiVersion: '2026-07',
        productId: 'gid://shopify/Product/10345525412131',
        variantId: 'gid://shopify/ProductVariant/55519196250403',
        title: 'Pipeline Test',
        sku: 'PIPELINE-TEST-20260826',
        requiredTag: 'product-pipeline-test-lane',
        currency: 'USD',
        price: '99.99',
        quantity: 1,
    }),
    ebay: Object.freeze({
        identityHost: 'apiz.sandbox.ebay.com',
        sellHost: 'api.sandbox.ebay.com',
        sellerId: 'testuser_ppcanary-3c55629b',
        marketplaceId: 'EBAY_US',
        merchantLocationKey: 'pp-test-lane',
        sku: 'PIPELINE-TEST-20260826',
        format: 'FIXED_PRICE',
        listingDuration: 'GTC',
    }),
});
export class SandboxAlignmentError extends Error {
    code;
    constructor(code) {
        super('Sandbox price/inventory operation denied');
        this.code = code;
        this.name = 'SandboxAlignmentError';
    }
}
export const deny = (code) => {
    throw new SandboxAlignmentError(code);
};
function canonicalize(value) {
    if (value === null || typeof value !== 'object')
        return JSON.stringify(value);
    if (Array.isArray(value))
        return `[${value.map(canonicalize).join(',')}]`;
    return `{${Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalize(entry)}`)
        .join(',')}}`;
}
export function digest(value) {
    return `sha256:${createHash('sha256').update(canonicalize(value), 'utf8').digest('hex')}`;
}
export const SANDBOX_ALIGNMENT_SCOPE_DIGEST = digest(SANDBOX_ALIGNMENT_SCOPE);
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const EXACT_ID = /^[0-9]{1,19}$/;
const PRICE = /^(0|[1-9][0-9]{0,9})\.[0-9]{2}$/;
export function assertDigest(value) {
    if (!DIGEST.test(value))
        deny('DIGEST_INVALID');
}
export function assertTarget(input) {
    if (input.sku !== SANDBOX_ALIGNMENT_SCOPE.ebay.sku
        || !EXACT_ID.test(input.offerId) || !EXACT_ID.test(input.listingId)) {
        deny('EXACT_TARGET_INVALID');
    }
}
export function assertSource(source) {
    const expected = SANDBOX_ALIGNMENT_SCOPE.shopify;
    const expectedScopes = ['read_fulfillments', 'read_inventory', 'read_orders', 'read_products'];
    if (source.storeDomain !== expected.storeDomain || source.shopId !== expected.shopId
        || source.appClientId !== expected.appClientId
        || JSON.stringify([...source.scopes].sort()) !== JSON.stringify(expectedScopes)
        || source.productId !== expected.productId || source.variantId !== expected.variantId
        || source.title !== expected.title || source.status !== 'ACTIVE'
        || JSON.stringify([...source.tags].sort()) !== JSON.stringify([expected.requiredTag])
        || source.publishedAt !== null || source.sku !== expected.sku
        || source.currency !== expected.currency || source.price !== expected.price
        || source.quantity !== expected.quantity) {
        deny('SHOPIFY_SOURCE_MISMATCH');
    }
}
export function assertEbay(state, target) {
    const expected = SANDBOX_ALIGNMENT_SCOPE.ebay;
    assertTarget(target);
    if (state.sellerId !== expected.sellerId
        || state.registrationMarketplaceId !== expected.marketplaceId
        || state.sku !== target.sku || state.offerId !== target.offerId
        || state.listingId !== target.listingId || state.marketplaceId !== expected.marketplaceId
        || state.merchantLocationKey !== expected.merchantLocationKey
        || state.format !== expected.format || state.listingDuration !== expected.listingDuration
        || state.status !== 'PUBLISHED' || state.listingStatus !== 'ACTIVE'
        || !Number.isSafeInteger(state.itemQuantity) || state.itemQuantity < 0
        || !Number.isSafeInteger(state.offerQuantity) || state.offerQuantity < 0
        || !Number.isSafeInteger(state.tradingQuantity) || state.tradingQuantity < 0
        || state.itemQuantity !== state.offerQuantity || state.itemQuantity !== state.tradingQuantity
        || state.price.currency !== 'USD' || !PRICE.test(state.price.value)
        || state.tradingPrice.currency !== 'USD' || !PRICE.test(state.tradingPrice.value)
        || state.price.value !== state.tradingPrice.value) {
        deny('EBAY_SANDBOX_STATE_MISMATCH');
    }
}
export function deriveManifest(input) {
    assertDigest(input.listingProvenanceDigest);
    assertSource(input.source);
    assertEbay(input.ebay, input.target);
    let before;
    let after;
    if (input.action === 'price-align') {
        if (input.ebay.price.value !== '1.00')
            deny('PRICE_SEED_STATE_REQUIRED');
        if (input.ebay.itemQuantity !== 1)
            deny('ACTION_SEQUENCE_INVALID');
        before = Object.freeze({ price: Object.freeze({ currency: 'USD', value: '1.00' }) });
        after = Object.freeze({ price: Object.freeze({ currency: 'USD', value: input.source.price }) });
    }
    else if (input.action === 'quantity-seed') {
        if (input.ebay.itemQuantity !== 1)
            deny('QUANTITY_ONE_REQUIRED');
        if (input.ebay.price.value !== input.source.price)
            deny('ACTION_SEQUENCE_INVALID');
        before = Object.freeze({ quantity: 1 });
        after = Object.freeze({ quantity: 2 });
    }
    else if (input.action === 'quantity-align') {
        if (input.ebay.itemQuantity !== 2)
            deny('QUANTITY_TWO_REQUIRED');
        if (input.ebay.price.value !== input.source.price)
            deny('ACTION_SEQUENCE_INVALID');
        before = Object.freeze({ quantity: 2 });
        after = Object.freeze({ quantity: input.source.quantity });
    }
    else {
        return deny('ACTION_INVALID');
    }
    const manifest = Object.freeze({
        schemaVersion: 1,
        scope: SANDBOX_ALIGNMENT_SCOPE,
        listingProvenanceDigest: input.listingProvenanceDigest,
        action: input.action,
        target: Object.freeze({ ...input.target, sku: SANDBOX_ALIGNMENT_SCOPE.ebay.sku }),
        sourceDigest: digest(input.source),
        before,
        after,
    });
    return Object.freeze({ manifest, manifestDigest: digest(manifest) });
}
export function classifyObserved(manifest, state) {
    assertEbay(state, manifest.target);
    if (manifest.action === 'price-align') {
        if (state.price.value === manifest.after.price?.value
            && state.tradingPrice.value === manifest.after.price?.value)
            return 'effect_observed';
        if (state.price.value === manifest.before.price?.value
            && state.tradingPrice.value === manifest.before.price?.value)
            return 'effect_absent';
        return 'partial';
    }
    const after = manifest.after.quantity;
    const before = manifest.before.quantity;
    if (state.itemQuantity === after && state.offerQuantity === after
        && state.tradingQuantity === after)
        return 'effect_observed';
    if (state.itemQuantity === before && state.offerQuantity === before
        && state.tradingQuantity === before)
        return 'effect_absent';
    return 'partial';
}
