import fs from 'node:fs/promises';
import path from 'node:path';
import { appendAuditRecord, DEFAULT_AUDIT_LOG_PATH, } from './audit.js';
import { assertPathInsideRoot, canonicalJson, loadOperatorConfig, sha256Digest, validateRepositoryRoot, } from './config.js';
export const RECONCILIATION_SNAPSHOT_DIRECTORY = '.local/operator-reconciliation';
export const MAX_RECONCILIATION_SNAPSHOT_BYTES = 4 * 1024 * 1024;
export const MAX_RECONCILIATION_RECORDS_PER_COLLECTION = 5_000;
export const MAX_RECONCILIATION_SNAPSHOT_AGE_MS = 24 * 60 * 60 * 1_000;
const MAX_FUTURE_CLOCK_SKEW_MS = 5 * 60 * 1_000;
export class ReconciliationSnapshotError extends Error {
    issues;
    constructor(issues) {
        super(`Reconciliation snapshot denied: ${issues.join('; ')}`);
        this.name = 'ReconciliationSnapshotError';
        this.issues = issues;
    }
}
const ROOT_KEYS = [
    'schemaVersion',
    'kind',
    'capturedAtUtc',
    'identities',
    'productPipeline',
    'shopify',
    'ebay',
    'marketplaceConnect',
];
const FORBIDDEN_KEY_PATTERN = /(?:token|secret|password|credential|api[_-]?key|authorization|cookie|buyer|customer|email|phone|address|full[_-]?name|first[_-]?name|last[_-]?name|line[_-]?items?|raw[_-]?json|notes?|tags?)/i;
const FORBIDDEN_VALUE_PATTERN = /^(?:Bearer\s+|shpat_|shpca_|shppa_|gh[pousr]_|sk-[A-Za-z0-9_-]{10,}|v\^1\.)/i;
const EMAIL_VALUE_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const EXACT_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/ -]{0,127}$/;
const STORE_DOMAIN_PATTERN = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;
const ACCOUNT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{1,79}$/;
const PRODUCT_GID_PATTERN = /^gid:\/\/shopify\/Product\/[0-9]+$/;
const VARIANT_GID_PATTERN = /^gid:\/\/shopify\/ProductVariant\/[0-9]+$/;
const ORDER_GID_PATTERN = /^gid:\/\/shopify\/Order\/[0-9]+$/;
const PRODUCT_ID_PATTERN = /^(?:[0-9]+|gid:\/\/shopify\/Product\/[0-9]+)$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;
const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
function inspectForbiddenMaterial(value, fieldPath, issues) {
    if (typeof value === 'string') {
        const trimmed = value.trim();
        if (FORBIDDEN_VALUE_PATTERN.test(trimmed) || EMAIL_VALUE_PATTERN.test(trimmed)) {
            issues.push(`${fieldPath} contains forbidden secret-like or personal data`);
        }
        return;
    }
    if (Array.isArray(value)) {
        value.forEach((child, index) => inspectForbiddenMaterial(child, `${fieldPath}[${index}]`, issues));
        return;
    }
    if (!isRecord(value))
        return;
    for (const [key, child] of Object.entries(value)) {
        const childPath = `${fieldPath}.${key}`;
        if (FORBIDDEN_KEY_PATTERN.test(key)) {
            issues.push(`${childPath} is a forbidden secret-like or personal-data field`);
            continue;
        }
        inspectForbiddenMaterial(child, childPath, issues);
    }
}
function requireRecord(value, fieldPath, issues) {
    if (!isRecord(value)) {
        issues.push(`${fieldPath} must be an object`);
        return undefined;
    }
    return value;
}
function requireExactKeys(value, allowed, fieldPath, issues) {
    const allowedSet = new Set(allowed);
    for (const key of Object.keys(value)) {
        if (!allowedSet.has(key))
            issues.push(`${fieldPath}.${key} is not supported`);
    }
    for (const key of allowed) {
        if (!Object.hasOwn(value, key))
            issues.push(`${fieldPath}.${key} is required`);
    }
}
function requireLiteral(value, expected, fieldPath, issues) {
    if (value !== expected) {
        issues.push(`${fieldPath} must be ${JSON.stringify(expected)}`);
        return undefined;
    }
    return expected;
}
function requireEnum(value, allowed, fieldPath, issues) {
    if (typeof value !== 'string' || !allowed.includes(value)) {
        issues.push(`${fieldPath} must be one of: ${allowed.join(', ')}`);
        return undefined;
    }
    return value;
}
function requireBoolean(value, fieldPath, issues) {
    if (typeof value !== 'boolean') {
        issues.push(`${fieldPath} must be a boolean`);
        return undefined;
    }
    return value;
}
function requireInteger(value, fieldPath, issues) {
    if (!Number.isSafeInteger(value) || value < 0) {
        issues.push(`${fieldPath} must be a non-negative safe integer`);
        return undefined;
    }
    return value;
}
function requireString(value, pattern, fieldPath, issues) {
    if (typeof value !== 'string' || !pattern.test(value)) {
        issues.push(`${fieldPath} is missing or malformed`);
        return undefined;
    }
    return value;
}
function requireNullableString(value, pattern, fieldPath, issues) {
    if (value === null)
        return null;
    return requireString(value, pattern, fieldPath, issues);
}
function requireCanonicalTimestamp(value, fieldPath, issues) {
    if (typeof value !== 'string' ||
        Number.isNaN(Date.parse(value)) ||
        new Date(value).toISOString() !== value) {
        issues.push(`${fieldPath} must be a canonical UTC timestamp`);
        return undefined;
    }
    return value;
}
function requireBoundedArray(value, fieldPath, issues) {
    if (!Array.isArray(value)) {
        issues.push(`${fieldPath} must be an array`);
        return undefined;
    }
    if (value.length > MAX_RECONCILIATION_RECORDS_PER_COLLECTION) {
        issues.push(`${fieldPath} exceeds the ${MAX_RECONCILIATION_RECORDS_PER_COLLECTION} record limit`);
        return undefined;
    }
    return value;
}
function parseIdentities(value, issues) {
    const record = requireRecord(value, 'snapshot.identities', issues);
    if (!record)
        return undefined;
    requireExactKeys(record, ['shopifyStoreDomain', 'ebayEnvironment', 'ebaySellerAccount', 'marketplaceConnectAccount'], 'snapshot.identities', issues);
    const shopifyStoreDomain = requireString(record.shopifyStoreDomain, STORE_DOMAIN_PATTERN, 'snapshot.identities.shopifyStoreDomain', issues);
    const ebayEnvironment = requireEnum(record.ebayEnvironment, ['sandbox', 'production'], 'snapshot.identities.ebayEnvironment', issues);
    const ebaySellerAccount = requireString(record.ebaySellerAccount, ACCOUNT_PATTERN, 'snapshot.identities.ebaySellerAccount', issues);
    const marketplaceConnectAccount = requireNullableString(record.marketplaceConnectAccount, ACCOUNT_PATTERN, 'snapshot.identities.marketplaceConnectAccount', issues);
    if (!shopifyStoreDomain ||
        !ebayEnvironment ||
        !ebaySellerAccount ||
        marketplaceConnectAccount === undefined) {
        return undefined;
    }
    return {
        shopifyStoreDomain,
        ebayEnvironment,
        ebaySellerAccount,
        marketplaceConnectAccount,
    };
}
function parseCollection(value, fieldPath, issues, parseItem) {
    const items = requireBoundedArray(value, fieldPath, issues);
    if (!items)
        return undefined;
    const result = [];
    items.forEach((item, index) => {
        const itemPath = `${fieldPath}[${index}]`;
        const record = requireRecord(item, itemPath, issues);
        if (!record)
            return;
        const parsed = parseItem(record, itemPath, issues);
        if (parsed)
            result.push(parsed);
    });
    return result;
}
function parseProductPipeline(value, issues) {
    const record = requireRecord(value, 'snapshot.productPipeline', issues);
    if (!record)
        return undefined;
    requireExactKeys(record, ['listings', 'orders'], 'snapshot.productPipeline', issues);
    const listings = parseCollection(record.listings, 'snapshot.productPipeline.listings', issues, (item, itemPath, itemIssues) => {
        requireExactKeys(item, ['shopifyProductId', 'shopifyVariantGid', 'sku', 'ebayInventoryItemSku', 'ebayOfferId', 'ebayListingId', 'status'], itemPath, itemIssues);
        const shopifyProductId = requireString(item.shopifyProductId, PRODUCT_ID_PATTERN, `${itemPath}.shopifyProductId`, itemIssues);
        const shopifyVariantGid = requireNullableString(item.shopifyVariantGid, VARIANT_GID_PATTERN, `${itemPath}.shopifyVariantGid`, itemIssues);
        const sku = requireString(item.sku, EXACT_IDENTIFIER_PATTERN, `${itemPath}.sku`, itemIssues);
        const ebayInventoryItemSku = requireNullableString(item.ebayInventoryItemSku, EXACT_IDENTIFIER_PATTERN, `${itemPath}.ebayInventoryItemSku`, itemIssues);
        const ebayOfferId = requireNullableString(item.ebayOfferId, EXACT_IDENTIFIER_PATTERN, `${itemPath}.ebayOfferId`, itemIssues);
        const ebayListingId = requireNullableString(item.ebayListingId, EXACT_IDENTIFIER_PATTERN, `${itemPath}.ebayListingId`, itemIssues);
        const status = requireEnum(item.status, ['active', 'ended', 'draft', 'unverified'], `${itemPath}.status`, itemIssues);
        if (!shopifyProductId || shopifyVariantGid === undefined || !sku || ebayInventoryItemSku === undefined || ebayOfferId === undefined || ebayListingId === undefined || !status)
            return undefined;
        return { shopifyProductId, shopifyVariantGid, sku, ebayInventoryItemSku, ebayOfferId, ebayListingId, status };
    });
    const orders = parseCollection(record.orders, 'snapshot.productPipeline.orders', issues, (item, itemPath, itemIssues) => {
        requireExactKeys(item, ['ebayOrderId', 'shopifyOrderGid', 'state'], itemPath, itemIssues);
        const ebayOrderId = requireString(item.ebayOrderId, EXACT_IDENTIFIER_PATTERN, `${itemPath}.ebayOrderId`, itemIssues);
        const shopifyOrderGid = requireNullableString(item.shopifyOrderGid, ORDER_GID_PATTERN, `${itemPath}.shopifyOrderGid`, itemIssues);
        const state = requireEnum(item.state, ['observed', 'mapped'], `${itemPath}.state`, itemIssues);
        if (!ebayOrderId || shopifyOrderGid === undefined || !state)
            return undefined;
        return { ebayOrderId, shopifyOrderGid, state };
    });
    if (!listings || !orders)
        return undefined;
    return { listings, orders };
}
function parseShopify(value, issues) {
    const record = requireRecord(value, 'snapshot.shopify', issues);
    if (!record)
        return undefined;
    requireExactKeys(record, ['variants', 'orders'], 'snapshot.shopify', issues);
    const variants = parseCollection(record.variants, 'snapshot.shopify.variants', issues, (item, itemPath, itemIssues) => {
        requireExactKeys(item, ['shopifyProductGid', 'shopifyVariantGid', 'sku', 'priceMinor', 'currency', 'inventoryQuantity'], itemPath, itemIssues);
        const shopifyProductGid = requireString(item.shopifyProductGid, PRODUCT_GID_PATTERN, `${itemPath}.shopifyProductGid`, itemIssues);
        const shopifyVariantGid = requireString(item.shopifyVariantGid, VARIANT_GID_PATTERN, `${itemPath}.shopifyVariantGid`, itemIssues);
        const sku = requireString(item.sku, EXACT_IDENTIFIER_PATTERN, `${itemPath}.sku`, itemIssues);
        const priceMinor = requireInteger(item.priceMinor, `${itemPath}.priceMinor`, itemIssues);
        const currency = requireString(item.currency, CURRENCY_PATTERN, `${itemPath}.currency`, itemIssues);
        const inventoryQuantity = requireInteger(item.inventoryQuantity, `${itemPath}.inventoryQuantity`, itemIssues);
        if (!shopifyProductGid || !shopifyVariantGid || !sku || priceMinor === undefined || !currency || inventoryQuantity === undefined)
            return undefined;
        return { shopifyProductGid, shopifyVariantGid, sku, priceMinor, currency, inventoryQuantity };
    });
    const orders = parseCollection(record.orders, 'snapshot.shopify.orders', issues, (item, itemPath, itemIssues) => {
        requireExactKeys(item, ['shopifyOrderGid', 'ebayOrderId', 'importOwner', 'createdAtUtc', 'status'], itemPath, itemIssues);
        const shopifyOrderGid = requireString(item.shopifyOrderGid, ORDER_GID_PATTERN, `${itemPath}.shopifyOrderGid`, itemIssues);
        const ebayOrderId = requireNullableString(item.ebayOrderId, EXACT_IDENTIFIER_PATTERN, `${itemPath}.ebayOrderId`, itemIssues);
        const importOwner = requireEnum(item.importOwner, ['marketplace-connect', 'product-pipeline', 'unknown'], `${itemPath}.importOwner`, itemIssues);
        const createdAtUtc = requireCanonicalTimestamp(item.createdAtUtc, `${itemPath}.createdAtUtc`, itemIssues);
        const status = requireEnum(item.status, ['open', 'closed', 'cancelled', 'unknown'], `${itemPath}.status`, itemIssues);
        if (!shopifyOrderGid || ebayOrderId === undefined || !importOwner || !createdAtUtc || !status)
            return undefined;
        return { shopifyOrderGid, ebayOrderId, importOwner, createdAtUtc, status };
    });
    if (!variants || !orders)
        return undefined;
    return { variants, orders };
}
function parseEbay(value, issues) {
    const record = requireRecord(value, 'snapshot.ebay', issues);
    if (!record)
        return undefined;
    requireExactKeys(record, ['listings', 'orders'], 'snapshot.ebay', issues);
    const listings = parseCollection(record.listings, 'snapshot.ebay.listings', issues, (item, itemPath, itemIssues) => {
        requireExactKeys(item, ['inventoryItemSku', 'offerId', 'listingId', 'status', 'priceMinor', 'currency', 'availableQuantity'], itemPath, itemIssues);
        const inventoryItemSku = requireString(item.inventoryItemSku, EXACT_IDENTIFIER_PATTERN, `${itemPath}.inventoryItemSku`, itemIssues);
        const offerId = requireNullableString(item.offerId, EXACT_IDENTIFIER_PATTERN, `${itemPath}.offerId`, itemIssues);
        const listingId = requireNullableString(item.listingId, EXACT_IDENTIFIER_PATTERN, `${itemPath}.listingId`, itemIssues);
        const status = requireEnum(item.status, ['published', 'unpublished', 'ended', 'unknown'], `${itemPath}.status`, itemIssues);
        const priceMinor = requireInteger(item.priceMinor, `${itemPath}.priceMinor`, itemIssues);
        const currency = requireString(item.currency, CURRENCY_PATTERN, `${itemPath}.currency`, itemIssues);
        const availableQuantity = requireInteger(item.availableQuantity, `${itemPath}.availableQuantity`, itemIssues);
        if (!inventoryItemSku || offerId === undefined || listingId === undefined || !status || priceMinor === undefined || !currency || availableQuantity === undefined)
            return undefined;
        return { inventoryItemSku, offerId, listingId, status, priceMinor, currency, availableQuantity };
    });
    const orders = parseCollection(record.orders, 'snapshot.ebay.orders', issues, (item, itemPath, itemIssues) => {
        requireExactKeys(item, ['ebayOrderId', 'createdAtUtc', 'status'], itemPath, itemIssues);
        const ebayOrderId = requireString(item.ebayOrderId, EXACT_IDENTIFIER_PATTERN, `${itemPath}.ebayOrderId`, itemIssues);
        const createdAtUtc = requireCanonicalTimestamp(item.createdAtUtc, `${itemPath}.createdAtUtc`, itemIssues);
        const status = requireEnum(item.status, ['active', 'completed', 'cancelled', 'unknown'], `${itemPath}.status`, itemIssues);
        if (!ebayOrderId || !createdAtUtc || !status)
            return undefined;
        return { ebayOrderId, createdAtUtc, status };
    });
    if (!listings || !orders)
        return undefined;
    return { listings, orders };
}
function parseMarketplaceConnect(value, issues) {
    const record = requireRecord(value, 'snapshot.marketplaceConnect', issues);
    if (!record)
        return undefined;
    requireExactKeys(record, ['orderImportEnabled', 'priceSyncEnabled', 'inventorySyncEnabled'], 'snapshot.marketplaceConnect', issues);
    const orderImportEnabled = requireBoolean(record.orderImportEnabled, 'snapshot.marketplaceConnect.orderImportEnabled', issues);
    const priceSyncEnabled = requireBoolean(record.priceSyncEnabled, 'snapshot.marketplaceConnect.priceSyncEnabled', issues);
    const inventorySyncEnabled = requireBoolean(record.inventorySyncEnabled, 'snapshot.marketplaceConnect.inventorySyncEnabled', issues);
    if (orderImportEnabled === undefined || priceSyncEnabled === undefined || inventorySyncEnabled === undefined)
        return undefined;
    return { orderImportEnabled, priceSyncEnabled, inventorySyncEnabled };
}
export function parseReconciliationSnapshot(value) {
    const issues = [];
    inspectForbiddenMaterial(value, 'snapshot', issues);
    const root = requireRecord(value, 'snapshot', issues);
    if (!root)
        throw new ReconciliationSnapshotError(issues);
    requireExactKeys(root, ROOT_KEYS, 'snapshot', issues);
    const schemaVersion = requireLiteral(root.schemaVersion, 1, 'snapshot.schemaVersion', issues);
    const kind = requireLiteral(root.kind, 'product-pipeline-shadow-reconciliation', 'snapshot.kind', issues);
    const capturedAtUtc = requireCanonicalTimestamp(root.capturedAtUtc, 'snapshot.capturedAtUtc', issues);
    const identities = parseIdentities(root.identities, issues);
    const productPipeline = parseProductPipeline(root.productPipeline, issues);
    const shopify = parseShopify(root.shopify, issues);
    const ebay = parseEbay(root.ebay, issues);
    const marketplaceConnect = parseMarketplaceConnect(root.marketplaceConnect, issues);
    if (issues.length > 0)
        throw new ReconciliationSnapshotError(issues);
    return {
        schemaVersion: schemaVersion,
        kind: kind,
        capturedAtUtc: capturedAtUtc,
        identities: identities,
        productPipeline: productPipeline,
        shopify: shopify,
        ebay: ebay,
        marketplaceConnect: marketplaceConnect,
    };
}
async function loadReconciliationSnapshot(repoRoot, requestedPath) {
    const expectedDirectory = path.join(repoRoot, RECONCILIATION_SNAPSHOT_DIRECTORY);
    const requestedAbsolute = assertPathInsideRoot(repoRoot, requestedPath, 'Snapshot path');
    const relativeToExpected = path.relative(expectedDirectory, requestedAbsolute);
    if (relativeToExpected === '' ||
        relativeToExpected === '..' ||
        relativeToExpected.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relativeToExpected)) {
        throw new ReconciliationSnapshotError([
            `snapshot file must be beneath ${RECONCILIATION_SNAPSHOT_DIRECTORY}`,
        ]);
    }
    const stat = await fs.lstat(requestedAbsolute).catch(() => null);
    if (!stat || !stat.isFile() || stat.isSymbolicLink()) {
        throw new ReconciliationSnapshotError(['snapshot file must be a regular, non-symlink file']);
    }
    if (stat.size > MAX_RECONCILIATION_SNAPSHOT_BYTES) {
        throw new ReconciliationSnapshotError([
            `snapshot file exceeds the ${MAX_RECONCILIATION_SNAPSHOT_BYTES} byte limit`,
        ]);
    }
    const realPath = await fs.realpath(requestedAbsolute);
    assertPathInsideRoot(repoRoot, realPath, 'Snapshot path');
    const realRelative = path.relative(expectedDirectory, realPath);
    if (realRelative === '' ||
        realRelative === '..' ||
        realRelative.startsWith(`..${path.sep}`) ||
        path.isAbsolute(realRelative)) {
        throw new ReconciliationSnapshotError([
            `snapshot file must resolve beneath ${RECONCILIATION_SNAPSHOT_DIRECTORY}`,
        ]);
    }
    let parsed;
    try {
        parsed = JSON.parse(await fs.readFile(realPath, 'utf8'));
    }
    catch {
        throw new ReconciliationSnapshotError(['snapshot file is not valid JSON']);
    }
    const snapshot = parseReconciliationSnapshot(parsed);
    return {
        snapshot,
        path: realPath,
        digest: sha256Digest(snapshot),
    };
}
function addDiscrepancy(target, value) {
    target.push(value);
}
function duplicateValues(values) {
    const seen = new Set();
    const duplicates = new Set();
    for (const value of values) {
        if (value === null)
            continue;
        if (seen.has(value))
            duplicates.add(value);
        seen.add(value);
    }
    return [...duplicates].sort();
}
function compareSnapshots(snapshot, config, now) {
    const discrepancies = [];
    const snapshotAgeMs = now.getTime() - Date.parse(snapshot.capturedAtUtc);
    const owner = (responsibility) => config.ownership[responsibility].currentOwner;
    if (snapshotAgeMs < -MAX_FUTURE_CLOCK_SKEW_MS) {
        addDiscrepancy(discrepancies, {
            code: 'snapshot.capture-time-in-future',
            severity: 'critical',
            responsibility: 'reconciliation',
            entityType: 'snapshot',
            entityKey: 'snapshot',
            owner: owner('reconciliation'),
            summary: 'Snapshot capture time is beyond the permitted clock skew.',
        });
    }
    else if (snapshotAgeMs > MAX_RECONCILIATION_SNAPSHOT_AGE_MS) {
        addDiscrepancy(discrepancies, {
            code: 'snapshot.stale',
            severity: 'warning',
            responsibility: 'reconciliation',
            entityType: 'snapshot',
            entityKey: 'snapshot',
            owner: owner('reconciliation'),
            summary: 'Snapshot is older than the 24-hour shadow-evidence window.',
        });
    }
    for (const responsibility of ['price', 'inventory', 'orderImport']) {
        const declaration = config.ownership[responsibility];
        if (declaration.currentOwner !== 'marketplace-connect' ||
            declaration.productPipelineAccess !== 'read-only') {
            addDiscrepancy(discrepancies, {
                code: `ownership.${responsibility}.baseline-mismatch`,
                severity: 'critical',
                responsibility,
                entityType: 'configuration',
                entityKey: responsibility,
                owner: declaration.currentOwner,
                summary: 'Current migration baseline requires Marketplace Connect ownership and ProductPipeline read-only access.',
            });
        }
    }
    for (const [responsibility, declaration] of Object.entries(config.ownership)) {
        if (declaration.currentOwner === 'unverified') {
            addDiscrepancy(discrepancies, {
                code: `ownership.${responsibility}.unverified`,
                severity: 'warning',
                responsibility,
                entityType: 'configuration',
                entityKey: responsibility,
                owner: declaration.currentOwner,
                summary: 'Responsibility ownership is not established by the operator configuration.',
            });
        }
    }
    const marketplaceSettings = [
        { enabled: snapshot.marketplaceConnect.priceSyncEnabled, responsibility: 'price' },
        { enabled: snapshot.marketplaceConnect.inventorySyncEnabled, responsibility: 'inventory' },
        { enabled: snapshot.marketplaceConnect.orderImportEnabled, responsibility: 'orderImport' },
    ];
    for (const setting of marketplaceSettings) {
        if (!setting.enabled) {
            addDiscrepancy(discrepancies, {
                code: `marketplace-connect.${setting.responsibility}.not-observed-enabled`,
                severity: 'critical',
                responsibility: setting.responsibility,
                entityType: 'configuration',
                entityKey: setting.responsibility,
                owner: owner(setting.responsibility),
                summary: 'Snapshot does not match the accepted incumbent-owner baseline.',
            });
        }
    }
    for (const duplicate of duplicateValues(snapshot.productPipeline.listings.map((item) => item.shopifyVariantGid))) {
        addDiscrepancy(discrepancies, {
            code: 'listing.duplicate-local-shopify-variant',
            severity: 'critical',
            responsibility: 'mapping',
            entityType: 'listing',
            entityKey: duplicate,
            owner: owner('mapping'),
            summary: 'Multiple local listing rows claim the same Shopify variant.',
        });
    }
    for (const duplicate of duplicateValues(snapshot.productPipeline.listings.map((item) => item.ebayListingId))) {
        addDiscrepancy(discrepancies, {
            code: 'listing.duplicate-local-ebay-listing',
            severity: 'critical',
            responsibility: 'mapping',
            entityType: 'listing',
            entityKey: duplicate,
            owner: owner('mapping'),
            summary: 'Multiple local listing rows claim the same eBay listing.',
        });
    }
    for (const duplicate of duplicateValues(snapshot.shopify.variants.map((item) => item.shopifyVariantGid))) {
        addDiscrepancy(discrepancies, {
            code: 'listing.duplicate-shopify-variant',
            severity: 'critical',
            responsibility: 'reconciliation',
            entityType: 'listing',
            entityKey: duplicate,
            owner: owner('reconciliation'),
            summary: 'Shopify snapshot repeats a stable variant identity.',
        });
    }
    for (const duplicate of duplicateValues(snapshot.ebay.listings.map((item) => item.listingId))) {
        addDiscrepancy(discrepancies, {
            code: 'listing.duplicate-ebay-listing',
            severity: 'critical',
            responsibility: 'reconciliation',
            entityType: 'listing',
            entityKey: duplicate,
            owner: owner('reconciliation'),
            summary: 'eBay snapshot repeats a stable listing identity.',
        });
    }
    for (const duplicate of duplicateValues(snapshot.ebay.listings.map((item) => item.offerId))) {
        addDiscrepancy(discrepancies, {
            code: 'listing.duplicate-ebay-offer',
            severity: 'critical',
            responsibility: 'reconciliation',
            entityType: 'listing',
            entityKey: duplicate,
            owner: owner('reconciliation'),
            summary: 'eBay snapshot repeats a stable offer identity.',
        });
    }
    const shopifyByVariant = new Map(snapshot.shopify.variants.map((item) => [item.shopifyVariantGid, item]));
    const ebayByListing = new Map(snapshot.ebay.listings
        .filter((item) => item.listingId !== null)
        .map((item) => [item.listingId, item]));
    const ebayBySku = new Map(snapshot.ebay.listings.map((item) => [item.inventoryItemSku, item]));
    const locallyClaimedEbayListings = new Set(snapshot.productPipeline.listings.flatMap((item) => item.ebayListingId ? [item.ebayListingId] : []));
    for (const local of snapshot.productPipeline.listings) {
        if (local.shopifyVariantGid === null) {
            addDiscrepancy(discrepancies, {
                code: 'listing.local-variant-identity-missing',
                severity: 'warning',
                responsibility: 'mapping',
                entityType: 'listing',
                entityKey: local.sku,
                owner: owner('mapping'),
                summary: 'Local mapping lacks a stable Shopify variant GID.',
            });
        }
        else {
            const shopifyVariant = shopifyByVariant.get(local.shopifyVariantGid);
            if (!shopifyVariant) {
                addDiscrepancy(discrepancies, {
                    code: 'listing.local-shopify-orphan',
                    severity: 'critical',
                    responsibility: 'mapping',
                    entityType: 'listing',
                    entityKey: local.shopifyVariantGid,
                    owner: owner('mapping'),
                    summary: 'Local listing link has no matching Shopify variant in the snapshot.',
                });
            }
            else if (shopifyVariant.sku !== local.sku) {
                addDiscrepancy(discrepancies, {
                    code: 'listing.local-shopify-sku-mismatch',
                    severity: 'warning',
                    responsibility: 'mapping',
                    entityType: 'listing',
                    entityKey: local.shopifyVariantGid,
                    owner: owner('mapping'),
                    summary: 'Local and Shopify snapshot SKUs do not agree.',
                });
            }
        }
        if (local.ebayListingId === null) {
            addDiscrepancy(discrepancies, {
                code: 'listing.local-ebay-link-missing',
                severity: 'warning',
                responsibility: 'mapping',
                entityType: 'listing',
                entityKey: local.sku,
                owner: owner('mapping'),
                summary: 'Local listing row has no stable eBay listing ID.',
            });
            continue;
        }
        const ebayListing = ebayByListing.get(local.ebayListingId);
        if (!ebayListing) {
            addDiscrepancy(discrepancies, {
                code: 'listing.local-ebay-orphan',
                severity: 'critical',
                responsibility: 'mapping',
                entityType: 'listing',
                entityKey: local.ebayListingId,
                owner: owner('mapping'),
                summary: 'Local listing link has no matching eBay listing in the snapshot.',
            });
            continue;
        }
        if (local.ebayInventoryItemSku !== null && local.ebayInventoryItemSku !== ebayListing.inventoryItemSku) {
            addDiscrepancy(discrepancies, {
                code: 'listing.inventory-item-sku-mismatch',
                severity: 'warning',
                responsibility: 'mapping',
                entityType: 'listing',
                entityKey: local.ebayListingId,
                owner: owner('mapping'),
                summary: 'Local and eBay inventory-item SKUs do not agree.',
            });
        }
        if (local.ebayOfferId !== null && local.ebayOfferId !== ebayListing.offerId) {
            addDiscrepancy(discrepancies, {
                code: 'listing.offer-id-mismatch',
                severity: 'warning',
                responsibility: 'mapping',
                entityType: 'listing',
                entityKey: local.ebayListingId,
                owner: owner('mapping'),
                summary: 'Local and eBay offer IDs do not agree.',
            });
        }
    }
    for (const ebayListing of snapshot.ebay.listings) {
        if (ebayListing.listingId !== null && !locallyClaimedEbayListings.has(ebayListing.listingId)) {
            addDiscrepancy(discrepancies, {
                code: 'listing.missing-local-link',
                severity: 'info',
                responsibility: 'mapping',
                entityType: 'listing',
                entityKey: ebayListing.listingId,
                owner: owner('mapping'),
                summary: 'Observed eBay listing is not represented by a local listing link.',
            });
        }
    }
    for (const shopifyVariant of snapshot.shopify.variants) {
        const ebayListing = ebayBySku.get(shopifyVariant.sku);
        if (!ebayListing)
            continue;
        if (shopifyVariant.priceMinor !== ebayListing.priceMinor ||
            shopifyVariant.currency !== ebayListing.currency) {
            addDiscrepancy(discrepancies, {
                code: 'price.observed-difference',
                severity: 'warning',
                responsibility: 'price',
                entityType: 'listing',
                entityKey: shopifyVariant.sku,
                owner: owner('price'),
                summary: 'Shopify and eBay snapshot prices differ; observation does not authorize a write.',
            });
        }
        if (shopifyVariant.inventoryQuantity !== ebayListing.availableQuantity) {
            addDiscrepancy(discrepancies, {
                code: 'inventory.observed-difference',
                severity: 'warning',
                responsibility: 'inventory',
                entityType: 'listing',
                entityKey: shopifyVariant.sku,
                owner: owner('inventory'),
                summary: 'Shopify and eBay snapshot quantities differ; observation does not authorize a write.',
            });
        }
    }
    for (const duplicate of duplicateValues(snapshot.ebay.orders.map((item) => item.ebayOrderId))) {
        addDiscrepancy(discrepancies, {
            code: 'order.duplicate-ebay-source-id',
            severity: 'critical',
            responsibility: 'orderImport',
            entityType: 'order',
            entityKey: duplicate,
            owner: owner('orderImport'),
            summary: 'eBay snapshot repeats an order identity.',
        });
    }
    for (const duplicate of duplicateValues(snapshot.productPipeline.orders.map((item) => item.ebayOrderId))) {
        addDiscrepancy(discrepancies, {
            code: 'order.duplicate-local-source-id',
            severity: 'critical',
            responsibility: 'orderImport',
            entityType: 'order',
            entityKey: duplicate,
            owner: owner('orderImport'),
            summary: 'ProductPipeline snapshot repeats an eBay order identity.',
        });
    }
    for (const duplicate of duplicateValues(snapshot.shopify.orders.map((item) => item.shopifyOrderGid))) {
        addDiscrepancy(discrepancies, {
            code: 'order.duplicate-shopify-order-id',
            severity: 'critical',
            responsibility: 'reconciliation',
            entityType: 'order',
            entityKey: duplicate,
            owner: owner('reconciliation'),
            summary: 'Shopify snapshot repeats a stable order identity.',
        });
    }
    const ebayOrderIds = new Set(snapshot.ebay.orders.map((item) => item.ebayOrderId));
    const shopifyOrdersByEbayId = new Map();
    for (const shopifyOrder of snapshot.shopify.orders) {
        if (shopifyOrder.ebayOrderId === null)
            continue;
        const existing = shopifyOrdersByEbayId.get(shopifyOrder.ebayOrderId) ?? [];
        existing.push(shopifyOrder);
        shopifyOrdersByEbayId.set(shopifyOrder.ebayOrderId, existing);
        if (!ebayOrderIds.has(shopifyOrder.ebayOrderId)) {
            addDiscrepancy(discrepancies, {
                code: 'order.shopify-source-not-in-ebay-snapshot',
                severity: 'warning',
                responsibility: 'reconciliation',
                entityType: 'order',
                entityKey: shopifyOrder.shopifyOrderGid,
                owner: owner('reconciliation'),
                summary: 'Shopify order references an eBay order absent from the supplied eBay snapshot.',
            });
        }
    }
    const localOrderByEbayId = new Map(snapshot.productPipeline.orders.map((item) => [item.ebayOrderId, item]));
    const shopifyOrdersByGid = new Map(snapshot.shopify.orders.map((item) => [item.shopifyOrderGid, item]));
    for (const localOrder of snapshot.productPipeline.orders) {
        if (!ebayOrderIds.has(localOrder.ebayOrderId)) {
            addDiscrepancy(discrepancies, {
                code: 'order.local-ebay-orphan',
                severity: 'warning',
                responsibility: 'reconciliation',
                entityType: 'order',
                entityKey: localOrder.ebayOrderId,
                owner: owner('reconciliation'),
                summary: 'Local order observation is absent from the supplied eBay snapshot.',
            });
        }
        if (localOrder.state === 'mapped' && localOrder.shopifyOrderGid === null) {
            addDiscrepancy(discrepancies, {
                code: 'order.local-mapped-without-shopify-id',
                severity: 'critical',
                responsibility: 'reconciliation',
                entityType: 'order',
                entityKey: localOrder.ebayOrderId,
                owner: owner('reconciliation'),
                summary: 'Local mapped state lacks a stable Shopify order GID.',
            });
        }
        if (localOrder.shopifyOrderGid !== null) {
            const shopifyOrder = shopifyOrdersByGid.get(localOrder.shopifyOrderGid);
            if (!shopifyOrder) {
                addDiscrepancy(discrepancies, {
                    code: 'order.local-shopify-orphan',
                    severity: 'critical',
                    responsibility: 'reconciliation',
                    entityType: 'order',
                    entityKey: localOrder.ebayOrderId,
                    owner: owner('reconciliation'),
                    summary: 'Local order mapping points to a Shopify order absent from the snapshot.',
                });
            }
            else if (shopifyOrder.ebayOrderId !== localOrder.ebayOrderId) {
                addDiscrepancy(discrepancies, {
                    code: 'order.local-shopify-link-mismatch',
                    severity: 'critical',
                    responsibility: 'reconciliation',
                    entityType: 'order',
                    entityKey: localOrder.ebayOrderId,
                    owner: owner('reconciliation'),
                    summary: 'Local and Shopify order-link identities do not agree.',
                });
            }
        }
    }
    for (const ebayOrder of snapshot.ebay.orders) {
        const shopifyMatches = shopifyOrdersByEbayId.get(ebayOrder.ebayOrderId) ?? [];
        if (shopifyMatches.length === 0) {
            addDiscrepancy(discrepancies, {
                code: 'order.no-shopify-link-observed',
                severity: 'warning',
                responsibility: 'orderImport',
                entityType: 'order',
                entityKey: ebayOrder.ebayOrderId,
                owner: owner('orderImport'),
                summary: 'No Shopify link is present; this is an incumbent-owned exception, never an import candidate.',
            });
        }
        if (shopifyMatches.length > 1) {
            addDiscrepancy(discrepancies, {
                code: 'order.duplicate-shopify-links',
                severity: 'critical',
                responsibility: 'orderImport',
                entityType: 'order',
                entityKey: ebayOrder.ebayOrderId,
                owner: owner('orderImport'),
                summary: 'More than one Shopify order references the same eBay order identity.',
            });
        }
        for (const match of shopifyMatches) {
            if (match.importOwner === 'product-pipeline') {
                addDiscrepancy(discrepancies, {
                    code: 'order.product-pipeline-import-observed',
                    severity: 'critical',
                    responsibility: 'orderImport',
                    entityType: 'order',
                    entityKey: ebayOrder.ebayOrderId,
                    owner: owner('orderImport'),
                    summary: 'Snapshot attributes an order import to ProductPipeline during writer quarantine.',
                });
            }
            else if (match.importOwner === 'unknown') {
                addDiscrepancy(discrepancies, {
                    code: 'order.import-owner-unverified',
                    severity: 'warning',
                    responsibility: 'orderImport',
                    entityType: 'order',
                    entityKey: ebayOrder.ebayOrderId,
                    owner: owner('orderImport'),
                    summary: 'Shopify order import ownership is not established by the snapshot.',
                });
            }
        }
        if (!localOrderByEbayId.has(ebayOrder.ebayOrderId)) {
            addDiscrepancy(discrepancies, {
                code: 'order.missing-local-observation',
                severity: 'info',
                responsibility: 'reconciliation',
                entityType: 'order',
                entityKey: ebayOrder.ebayOrderId,
                owner: owner('reconciliation'),
                summary: 'eBay order is not represented in the ProductPipeline observation snapshot.',
            });
        }
    }
    discrepancies.sort((left, right) => `${left.code}\u0000${left.entityKey}`.localeCompare(`${right.code}\u0000${right.entityKey}`));
    return {
        command: 'reconcile',
        status: discrepancies.length === 0 ? 'consistent-with-supplied-snapshots' : 'exceptions-found',
        evidenceScope: 'supplied-snapshots-only',
        guarantees: {
            liveProof: false,
            productionParity: false,
            externalNetworkAccess: false,
            externalWrites: 0,
            applicationDatabaseAccess: false,
            historicalBackfill: false,
            orderCreationEligible: false,
        },
        capturedAtUtc: snapshot.capturedAtUtc,
        snapshotAgeMs,
        declaredIdentity: snapshot.identities,
        ownership: config.ownership,
        counts: {
            productPipelineListings: snapshot.productPipeline.listings.length,
            productPipelineOrders: snapshot.productPipeline.orders.length,
            shopifyVariants: snapshot.shopify.variants.length,
            shopifyOrders: snapshot.shopify.orders.length,
            ebayListings: snapshot.ebay.listings.length,
            ebayOrders: snapshot.ebay.orders.length,
            discrepancies: discrepancies.length,
        },
        discrepancies,
    };
}
function auditChecks(snapshotDigest, resultDigest, hasExceptions) {
    return [
        { id: 'reconciliation.snapshot-valid', result: 'pass' },
        { id: 'reconciliation.identity-match', result: 'pass' },
        { id: 'safety.read-only', result: 'pass' },
        { id: 'safety.external-writes-zero', result: 'pass' },
        { id: 'safety.historical-backfill-disabled', result: 'pass' },
        { id: 'safety.order-creation-ineligible', result: 'pass' },
        { id: `reconciliation.snapshot-digest-${snapshotDigest.slice('sha256:'.length)}`, result: 'pass' },
        { id: `reconciliation.result-digest-${resultDigest.slice('sha256:'.length)}`, result: 'pass' },
        { id: 'reconciliation.exceptions-absent', result: hasExceptions ? 'block' : 'pass' },
    ];
}
async function appendDenial(repoRoot, config, checkId) {
    await appendAuditRecord(repoRoot, DEFAULT_AUDIT_LOG_PATH, {
        command: 'reconcile',
        lane: config?.lane ?? 'unavailable',
        mode: config?.mode ?? 'unavailable',
        outcome: 'denied',
        configDigest: config ? sha256Digest(config) : null,
        target: config?.identities ?? {
            shopifyStoreDomain: null,
            ebayEnvironment: null,
            ebaySellerAccount: null,
            marketplaceConnectAccount: null,
        },
        ownershipDigest: config ? sha256Digest(config.ownership) : null,
        checks: [{ id: checkId, result: 'deny' }],
    });
}
export async function runSnapshotReconciliation(options) {
    const repoRoot = await validateRepositoryRoot(options.repoRoot);
    let loadedConfig;
    try {
        loadedConfig = await loadOperatorConfig(repoRoot, options.configPath);
    }
    catch (error) {
        try {
            await appendDenial(repoRoot, null, 'config.schema-invalid');
        }
        catch (auditError) {
            const reason = error instanceof Error ? error.message : 'Operator config denied';
            const auditReason = auditError instanceof Error ? auditError.message : 'unknown audit failure';
            throw new Error(`${reason}; denial audit failed: ${auditReason}`);
        }
        throw error;
    }
    let loadedSnapshot;
    try {
        loadedSnapshot = await loadReconciliationSnapshot(repoRoot, options.snapshotPath);
    }
    catch (error) {
        try {
            await appendDenial(repoRoot, loadedConfig.config, 'reconciliation.snapshot-invalid');
        }
        catch (auditError) {
            const reason = error instanceof Error ? error.message : 'Snapshot denied';
            const auditReason = auditError instanceof Error ? auditError.message : 'unknown audit failure';
            throw new Error(`${reason}; denial audit failed: ${auditReason}`);
        }
        throw error;
    }
    if (canonicalJson(loadedSnapshot.snapshot.identities) !== canonicalJson(loadedConfig.config.identities)) {
        try {
            await appendDenial(repoRoot, loadedConfig.config, 'reconciliation.identity-mismatch');
        }
        catch (auditError) {
            const reason = auditError instanceof Error ? auditError.message : 'unknown audit failure';
            throw new Error(`Snapshot identity does not match operator config; denial audit failed: ${reason}`);
        }
        throw new ReconciliationSnapshotError(['snapshot identity does not match operator config']);
    }
    const core = compareSnapshots(loadedSnapshot.snapshot, loadedConfig.config, (options.now ?? (() => new Date()))());
    const snapshotPath = path.relative(repoRoot, loadedSnapshot.path);
    const resultDigest = sha256Digest({
        ...core,
        snapshot: { path: snapshotPath, digest: loadedSnapshot.digest },
    });
    const auditRecord = await appendAuditRecord(repoRoot, loadedConfig.config.audit.logPath, {
        command: 'reconcile',
        lane: loadedConfig.config.lane,
        mode: loadedConfig.config.mode,
        outcome: core.discrepancies.length === 0 ? 'passed' : 'blocked',
        configDigest: loadedConfig.digest,
        target: loadedConfig.config.identities,
        ownershipDigest: sha256Digest(loadedConfig.config.ownership),
        checks: auditChecks(loadedSnapshot.digest, resultDigest, core.discrepancies.length > 0),
    }, { now: options.now, createRunId: options.createRunId });
    return {
        ...core,
        snapshot: { path: snapshotPath, digest: loadedSnapshot.digest },
        resultDigest,
        audit: {
            path: loadedConfig.config.audit.logPath,
            sequence: auditRecord.sequence,
            recordHash: auditRecord.recordHash,
        },
    };
}
