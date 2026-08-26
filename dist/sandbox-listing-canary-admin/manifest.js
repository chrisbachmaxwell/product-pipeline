import fs from 'node:fs';
import { createHash } from 'node:crypto';
export const SANDBOX_API_ORIGIN = 'https://api.sandbox.ebay.com';
export const SANDBOX_IDENTITY_ORIGIN = 'https://apiz.sandbox.ebay.com';
export const SANDBOX_MARKETPLACE = 'EBAY_US';
export const SANDBOX_MARKER = 'PRODUCT PIPELINE SANDBOX TEST - DO NOT BUY';
const PRODUCT_GID = /^gid:\/\/shopify\/Product\/[0-9]+$/;
const VARIANT_GID = /^gid:\/\/shopify\/ProductVariant\/[0-9]+$/;
const SAFE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const IMAGE_HOSTS = new Set(['cdn.shopify.com', 'i.ebayimg.com', 'thumbs.ebaystatic.com', 'secureir.ebaystatic.com', 'i.ebaystatic.com']);
const DIGEST = /^sha256:[a-f0-9]{64}$/;
export class SandboxManifestError extends Error {
    code;
    constructor(code) {
        super('Sandbox canary manifest denied');
        this.code = code;
        this.name = 'SandboxManifestError';
    }
}
const deny = (code) => { throw new SandboxManifestError(code); };
function exactKeys(value, keys) {
    return Object.keys(value).sort().join('|') === [...keys].sort().join('|');
}
function record(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        deny('MANIFEST_INVALID');
    return value;
}
function text(value, max = 256) {
    if (typeof value !== 'string' || value.length < 1 || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) {
        deny('MANIFEST_INVALID');
    }
    return value;
}
export function validateTarget(input) {
    if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(input.storeDomain)
        || !PRODUCT_GID.test(input.productGid)
        || !VARIANT_GID.test(input.variantGid)
        || !SAFE.test(input.sku)
        || !DIGEST.test(input.shopifyEvidenceDigest))
        deny('TARGET_INVALID');
    return Object.freeze({
        storeDomain: input.storeDomain,
        productGid: input.productGid,
        variantGid: input.variantGid,
        sku: input.sku,
        shopifyEvidenceDigest: input.shopifyEvidenceDigest,
    });
}
export function readSandboxManifest(filePath, exactTarget) {
    if (!filePath.startsWith('/') || fs.lstatSync(filePath).isSymbolicLink())
        deny('MANIFEST_PATH_DENIED');
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size > 64 * 1024 || (stat.mode & 0o077) !== 0)
        deny('MANIFEST_PATH_DENIED');
    let raw;
    try {
        raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    }
    catch {
        deny('MANIFEST_INVALID');
    }
    const root = record(raw);
    if (!exactKeys(root, ['schemaVersion', 'environment', 'marketplaceId', 'target', 'listing'])
        || root.schemaVersion !== 1 || root.environment !== 'sandbox' || root.marketplaceId !== SANDBOX_MARKETPLACE) {
        deny('MANIFEST_INVALID');
    }
    const target = record(root.target);
    if (!exactKeys(target, ['storeDomain', 'productGid', 'variantGid', 'sku', 'shopifyEvidenceDigest']))
        deny('MANIFEST_INVALID');
    const validatedTarget = validateTarget(target);
    if (JSON.stringify(validatedTarget) !== JSON.stringify(exactTarget))
        deny('TARGET_MISMATCH');
    const listing = record(root.listing);
    if (!exactKeys(listing, ['title', 'description', 'imageUrls', 'categoryId', 'condition', 'conditionDescription', 'quantity', 'price', 'merchantLocationKey', 'fulfillmentPolicyId', 'paymentPolicyId', 'returnPolicyId']))
        deny('MANIFEST_INVALID');
    const title = text(listing.title, 80);
    const description = text(listing.description, 50_000);
    if (!title.startsWith(SANDBOX_MARKER) || !description.includes(SANDBOX_MARKER))
        deny('MARKER_REQUIRED');
    const images = listing.imageUrls;
    if (!Array.isArray(images) || images.length < 1 || images.length > 12 || images.some((v) => {
        if (typeof v !== 'string' || v.length > 2048)
            return true;
        try {
            const u = new URL(v);
            return u.protocol !== 'https:' || u.username !== '' || u.password !== '' || u.port !== '' || u.search !== '' || u.hash !== '' || !IMAGE_HOSTS.has(u.hostname.toLowerCase());
        }
        catch {
            return true;
        }
    }))
        deny('MANIFEST_INVALID');
    const price = record(listing.price);
    if (!exactKeys(price, ['currency', 'value']) || price.currency !== 'USD' || price.value !== '1.00' || listing.quantity !== 1)
        deny('CANARY_COMMERCE_LIMIT');
    const manifest = Object.freeze({
        schemaVersion: 1, environment: 'sandbox', marketplaceId: SANDBOX_MARKETPLACE,
        target: validatedTarget,
        listing: Object.freeze({
            title, description, imageUrls: Object.freeze([...images]),
            categoryId: text(listing.categoryId, 32), condition: text(listing.condition, 64),
            conditionDescription: text(listing.conditionDescription, 1000), quantity: 1,
            price: Object.freeze({ currency: 'USD', value: '1.00' }),
            merchantLocationKey: text(listing.merchantLocationKey, 128),
            fulfillmentPolicyId: text(listing.fulfillmentPolicyId, 128),
            paymentPolicyId: text(listing.paymentPolicyId, 128),
            returnPolicyId: text(listing.returnPolicyId, 128),
        }),
    });
    const digest = `sha256:${createHash('sha256').update(JSON.stringify(manifest)).digest('hex')}`;
    return { manifest, digest };
}
export function buildPayloads(manifest) {
    const l = manifest.listing;
    return {
        inventory: { availability: { shipToLocationAvailability: { quantity: 1 } }, condition: l.condition,
            conditionDescription: l.conditionDescription, product: { title: l.title, description: l.description, imageUrls: l.imageUrls } },
        offer: { sku: manifest.target.sku, marketplaceId: SANDBOX_MARKETPLACE, format: 'FIXED_PRICE',
            availableQuantity: 1, categoryId: l.categoryId, listingDescription: l.description,
            listingPolicies: { fulfillmentPolicyId: l.fulfillmentPolicyId, paymentPolicyId: l.paymentPolicyId, returnPolicyId: l.returnPolicyId },
            merchantLocationKey: l.merchantLocationKey, pricingSummary: { price: l.price } },
    };
}
