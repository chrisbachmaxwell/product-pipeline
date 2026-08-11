import { canonicalJson, sha256Digest } from './config.js';
export const RECONCILIATION_SOURCES = [
    'productPipeline',
    'shopify',
    'ebay',
    'marketplaceConnect',
];
export class ReconciliationSnapshotError extends Error {
    issues;
    constructor(issues) {
        super(`Reconciliation snapshot denied: ${issues.join('; ')}`);
        this.name = 'ReconciliationSnapshotError';
        this.issues = issues;
    }
}
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
const VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const BUILD_COMMIT_PATTERN = /^[a-f0-9]{7,64}$/;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
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
function requireBoundedArray(value, fieldPath, issues, limit) {
    if (!Array.isArray(value)) {
        issues.push(`${fieldPath} must be an array`);
        return undefined;
    }
    if (value.length > limit) {
        issues.push(`${fieldPath} exceeds the ${limit} record limit`);
        return undefined;
    }
    return value;
}
function parseCollection(value, fieldPath, issues, limit, parseItem) {
    const items = requireBoundedArray(value, fieldPath, issues, limit);
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
        marketplaceConnectAccount === undefined)
        return undefined;
    return { shopifyStoreDomain, ebayEnvironment, ebaySellerAccount, marketplaceConnectAccount };
}
function parseProductPipelineData(value, issues, recordLimit) {
    const record = requireRecord(value, 'snapshot.sources.productPipeline.data', issues);
    if (!record)
        return undefined;
    requireExactKeys(record, ['listings', 'orders'], 'snapshot.sources.productPipeline.data', issues);
    const listings = parseCollection(record.listings, 'snapshot.sources.productPipeline.data.listings', issues, recordLimit, (item, itemPath, itemIssues) => {
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
    const orders = parseCollection(record.orders, 'snapshot.sources.productPipeline.data.orders', issues, recordLimit, (item, itemPath, itemIssues) => {
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
function parseShopifyData(value, issues, recordLimit) {
    const record = requireRecord(value, 'snapshot.sources.shopify.data', issues);
    if (!record)
        return undefined;
    requireExactKeys(record, ['variants', 'orders'], 'snapshot.sources.shopify.data', issues);
    const variants = parseCollection(record.variants, 'snapshot.sources.shopify.data.variants', issues, recordLimit, (item, itemPath, itemIssues) => {
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
    const orders = parseCollection(record.orders, 'snapshot.sources.shopify.data.orders', issues, recordLimit, (item, itemPath, itemIssues) => {
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
function parseEbayData(value, issues, recordLimit) {
    const record = requireRecord(value, 'snapshot.sources.ebay.data', issues);
    if (!record)
        return undefined;
    requireExactKeys(record, ['listings', 'orders'], 'snapshot.sources.ebay.data', issues);
    const listings = parseCollection(record.listings, 'snapshot.sources.ebay.data.listings', issues, recordLimit, (item, itemPath, itemIssues) => {
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
    const orders = parseCollection(record.orders, 'snapshot.sources.ebay.data.orders', issues, recordLimit, (item, itemPath, itemIssues) => {
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
function parseMarketplaceConnectData(value, issues, recordLimit) {
    const record = requireRecord(value, 'snapshot.sources.marketplaceConnect.data', issues);
    if (!record)
        return undefined;
    requireExactKeys(record, ['settings'], 'snapshot.sources.marketplaceConnect.data', issues);
    const settings = parseCollection(record.settings, 'snapshot.sources.marketplaceConnect.data.settings', issues, recordLimit, (item, itemPath, itemIssues) => {
        requireExactKeys(item, ['responsibility', 'enabled'], itemPath, itemIssues);
        const responsibility = requireEnum(item.responsibility, ['orderImport', 'price', 'inventory'], `${itemPath}.responsibility`, itemIssues);
        const enabled = requireBoolean(item.enabled, `${itemPath}.enabled`, itemIssues);
        if (!responsibility || enabled === undefined)
            return undefined;
        return { responsibility, enabled };
    });
    if (!settings)
        return undefined;
    return { settings };
}
function dataRecordCount(source, data) {
    switch (source) {
        case 'productPipeline': {
            const value = data;
            return value.listings.length + value.orders.length;
        }
        case 'shopify': {
            const value = data;
            return value.variants.length + value.orders.length;
        }
        case 'ebay': {
            const value = data;
            return value.listings.length + value.orders.length;
        }
        case 'marketplaceConnect':
            return data.settings.length;
    }
}
export function computeReconciliationDatasetDigest(value) {
    return sha256Digest(value);
}
function expectedSubject(source, identities) {
    switch (source) {
        case 'productPipeline':
            return {
                project: 'product-pipeline',
                shopifyStoreDomain: identities.shopifyStoreDomain,
                ebayEnvironment: identities.ebayEnvironment,
                ebaySellerAccount: identities.ebaySellerAccount,
            };
        case 'shopify':
            return { shopifyStoreDomain: identities.shopifyStoreDomain };
        case 'ebay':
            return {
                ebayEnvironment: identities.ebayEnvironment,
                ebaySellerAccount: identities.ebaySellerAccount,
                marketplaceId: 'EBAY_US',
            };
        case 'marketplaceConnect':
            return {
                shopifyStoreDomain: identities.shopifyStoreDomain,
                marketplaceConnectAccount: identities.marketplaceConnectAccount,
            };
    }
}
function parseSubject(source, value, identities, issues) {
    const fieldPath = `snapshot.sources.${source}.provenance.subject`;
    const record = requireRecord(value, fieldPath, issues);
    if (!record)
        return undefined;
    const expected = expectedSubject(source, identities);
    requireExactKeys(record, Object.keys(expected), fieldPath, issues);
    if (canonicalJson(record) !== canonicalJson(expected)) {
        issues.push(`${fieldPath} must exactly match the snapshot identities`);
        return undefined;
    }
    return expected;
}
const METHOD_BY_SOURCE = {
    productPipeline: 'application-ledger-read',
    shopify: 'direct-api-read',
    ebay: 'direct-api-read',
    marketplaceConnect: 'operator-attested-admin-view',
};
const ATTESTATION_BY_SOURCE = {
    productPipeline: 'runtime-observed',
    shopify: 'runtime-observed',
    ebay: 'runtime-observed',
    marketplaceConnect: 'operator-attested',
};
function parseProvenance(source, value, identities, data, issues) {
    const fieldPath = `snapshot.sources.${source}.provenance`;
    const record = requireRecord(value, fieldPath, issues);
    if (!record)
        return undefined;
    requireExactKeys(record, [
        'source',
        'availability',
        'unavailableReason',
        'method',
        'attestation',
        'subject',
        'collector',
        'apiVersion',
        'capturedAtUtc',
        'asOfStartUtc',
        'asOfEndUtc',
        'queryScope',
        'paginationComplete',
        'pageCount',
        'recordCount',
        'reportedTotal',
        'terminalCursorDigest',
        'normalizationVersion',
        'redactionVersion',
        'datasetDigest',
    ], fieldPath, issues);
    const sourceValue = requireLiteral(record.source, source, `${fieldPath}.source`, issues);
    const availability = requireEnum(record.availability, ['complete', 'partial', 'unavailable'], `${fieldPath}.availability`, issues);
    const unavailableReason = record.unavailableReason === null
        ? null
        : requireEnum(record.unavailableReason, [
            'authority-absent',
            'credentials-unavailable',
            'collector-unavailable',
            'source-unreachable',
            'not-collected',
        ], `${fieldPath}.unavailableReason`, issues);
    const method = requireLiteral(record.method, METHOD_BY_SOURCE[source], `${fieldPath}.method`, issues);
    const attestation = requireLiteral(record.attestation, ATTESTATION_BY_SOURCE[source], `${fieldPath}.attestation`, issues);
    const subject = parseSubject(source, record.subject, identities, issues);
    const collectorValue = requireRecord(record.collector, `${fieldPath}.collector`, issues);
    let collector;
    if (collectorValue) {
        requireExactKeys(collectorValue, ['name', 'version', 'buildCommit'], `${fieldPath}.collector`, issues);
        const name = requireString(collectorValue.name, VERSION_PATTERN, `${fieldPath}.collector.name`, issues);
        const version = requireString(collectorValue.version, VERSION_PATTERN, `${fieldPath}.collector.version`, issues);
        const buildCommit = requireString(collectorValue.buildCommit, BUILD_COMMIT_PATTERN, `${fieldPath}.collector.buildCommit`, issues);
        if (name && version && buildCommit)
            collector = { name, version, buildCommit };
    }
    const apiVersion = record.apiVersion === null
        ? null
        : requireString(record.apiVersion, VERSION_PATTERN, `${fieldPath}.apiVersion`, issues);
    const capturedAtUtc = requireCanonicalTimestamp(record.capturedAtUtc, `${fieldPath}.capturedAtUtc`, issues);
    const asOfStartUtc = requireCanonicalTimestamp(record.asOfStartUtc, `${fieldPath}.asOfStartUtc`, issues);
    const asOfEndUtc = requireCanonicalTimestamp(record.asOfEndUtc, `${fieldPath}.asOfEndUtc`, issues);
    const queryValue = requireRecord(record.queryScope, `${fieldPath}.queryScope`, issues);
    let queryScope;
    if (queryValue) {
        requireExactKeys(queryValue, ['kind', 'lowerBoundUtc', 'upperBoundUtc'], `${fieldPath}.queryScope`, issues);
        const kind = requireLiteral(queryValue.kind, 'bounded', `${fieldPath}.queryScope.kind`, issues);
        const lowerBoundUtc = requireCanonicalTimestamp(queryValue.lowerBoundUtc, `${fieldPath}.queryScope.lowerBoundUtc`, issues);
        const upperBoundUtc = requireCanonicalTimestamp(queryValue.upperBoundUtc, `${fieldPath}.queryScope.upperBoundUtc`, issues);
        if (kind && lowerBoundUtc && upperBoundUtc)
            queryScope = { kind, lowerBoundUtc, upperBoundUtc };
    }
    const paginationComplete = requireBoolean(record.paginationComplete, `${fieldPath}.paginationComplete`, issues);
    const pageCount = requireInteger(record.pageCount, `${fieldPath}.pageCount`, issues);
    const recordCount = record.recordCount === null
        ? null
        : requireInteger(record.recordCount, `${fieldPath}.recordCount`, issues);
    const reportedTotal = record.reportedTotal === null
        ? null
        : requireInteger(record.reportedTotal, `${fieldPath}.reportedTotal`, issues);
    const terminalCursorDigest = record.terminalCursorDigest === null
        ? null
        : requireString(record.terminalCursorDigest, DIGEST_PATTERN, `${fieldPath}.terminalCursorDigest`, issues);
    const normalizationVersion = requireString(record.normalizationVersion, VERSION_PATTERN, `${fieldPath}.normalizationVersion`, issues);
    const redactionVersion = requireString(record.redactionVersion, VERSION_PATTERN, `${fieldPath}.redactionVersion`, issues);
    const datasetDigest = record.datasetDigest === null
        ? null
        : requireString(record.datasetDigest, DIGEST_PATTERN, `${fieldPath}.datasetDigest`, issues);
    if (capturedAtUtc && asOfStartUtc && asOfEndUtc) {
        if (Date.parse(asOfStartUtc) > Date.parse(asOfEndUtc)) {
            issues.push(`${fieldPath}.asOfStartUtc must not be after asOfEndUtc`);
        }
        if (Date.parse(asOfEndUtc) > Date.parse(capturedAtUtc)) {
            issues.push(`${fieldPath}.asOfEndUtc must not be after capturedAtUtc`);
        }
    }
    if (queryScope) {
        if (Date.parse(queryScope.lowerBoundUtc) > Date.parse(queryScope.upperBoundUtc)) {
            issues.push(`${fieldPath}.queryScope lower bound must not be after upper bound`);
        }
        if (asOfStartUtc &&
            asOfEndUtc &&
            (Date.parse(asOfStartUtc) < Date.parse(queryScope.lowerBoundUtc) ||
                Date.parse(asOfEndUtc) > Date.parse(queryScope.upperBoundUtc))) {
            issues.push(`${fieldPath} as-of window must be contained by the bounded query scope`);
        }
    }
    const actualRecordCount = dataRecordCount(source, data);
    if (recordCount !== undefined && recordCount !== null && recordCount !== actualRecordCount) {
        issues.push(`${fieldPath}.recordCount must match the normalized dataset`);
    }
    if (pageCount !== undefined && actualRecordCount > 0 && pageCount === 0) {
        issues.push(`${fieldPath}.pageCount must be positive when records are present`);
    }
    if (datasetDigest && datasetDigest !== computeReconciliationDatasetDigest(data)) {
        issues.push(`${fieldPath}.datasetDigest does not match the normalized dataset`);
    }
    if (availability === 'unavailable') {
        if (unavailableReason === null || unavailableReason === undefined) {
            issues.push(`${fieldPath}.unavailableReason is required when unavailable`);
        }
        if (actualRecordCount !== 0 ||
            paginationComplete !== false ||
            pageCount !== 0 ||
            recordCount !== null ||
            reportedTotal !== null ||
            terminalCursorDigest !== null ||
            apiVersion !== null ||
            datasetDigest !== null) {
            issues.push(`${fieldPath} unavailable evidence requires empty data, incomplete pagination, zero pages, and null API/count/total/terminal/dataset evidence`);
        }
    }
    else if (availability) {
        if (unavailableReason !== null) {
            issues.push(`${fieldPath}.unavailableReason must be null when evidence is available`);
        }
        if (recordCount === null || datasetDigest === null) {
            issues.push(`${fieldPath} available evidence requires recordCount and datasetDigest`);
        }
        if (source === 'shopify' || source === 'ebay') {
            if (apiVersion === null) {
                issues.push(`${fieldPath}.apiVersion is required for an available direct API read`);
            }
        }
        else if (apiVersion !== null) {
            issues.push(`${fieldPath}.apiVersion must be null for a non-API source`);
        }
        if (availability === 'complete') {
            if (paginationComplete !== true) {
                issues.push(`${fieldPath}.paginationComplete must be true when availability is complete`);
            }
            if (pageCount !== undefined && pageCount < 1) {
                issues.push(`${fieldPath}.pageCount must include terminal-page evidence when availability is complete`);
            }
            if (reportedTotal === null) {
                issues.push(`${fieldPath}.reportedTotal is required when availability is complete`);
            }
            if (reportedTotal !== undefined &&
                reportedTotal !== null &&
                recordCount !== undefined &&
                recordCount !== null &&
                reportedTotal !== recordCount) {
                issues.push(`${fieldPath}.reportedTotal must equal recordCount when availability is complete`);
            }
            if (terminalCursorDigest === null) {
                issues.push(`${fieldPath}.terminalCursorDigest is required when availability is complete`);
            }
        }
        if (availability === 'partial') {
            if (paginationComplete !== false) {
                issues.push(`${fieldPath}.paginationComplete must be false when availability is partial`);
            }
            if (terminalCursorDigest !== null) {
                issues.push(`${fieldPath}.terminalCursorDigest must be null when availability is partial`);
            }
        }
    }
    if (!sourceValue ||
        !availability ||
        unavailableReason === undefined ||
        !method ||
        !attestation ||
        !subject ||
        !collector ||
        apiVersion === undefined ||
        !capturedAtUtc ||
        !asOfStartUtc ||
        !asOfEndUtc ||
        !queryScope ||
        paginationComplete === undefined ||
        pageCount === undefined ||
        recordCount === undefined ||
        reportedTotal === undefined ||
        terminalCursorDigest === undefined ||
        !normalizationVersion ||
        !redactionVersion ||
        datasetDigest === undefined)
        return undefined;
    return {
        source: sourceValue,
        availability,
        unavailableReason,
        method,
        attestation,
        subject,
        collector,
        apiVersion,
        capturedAtUtc,
        asOfStartUtc,
        asOfEndUtc,
        queryScope,
        paginationComplete,
        pageCount,
        recordCount,
        reportedTotal,
        terminalCursorDigest,
        normalizationVersion,
        redactionVersion,
        datasetDigest,
    };
}
function parseSourceBundle(source, value, identities, issues, recordLimit) {
    const fieldPath = `snapshot.sources.${source}`;
    const record = requireRecord(value, fieldPath, issues);
    if (!record)
        return undefined;
    requireExactKeys(record, ['provenance', 'data'], fieldPath, issues);
    let data;
    switch (source) {
        case 'productPipeline':
            data = parseProductPipelineData(record.data, issues, recordLimit);
            break;
        case 'shopify':
            data = parseShopifyData(record.data, issues, recordLimit);
            break;
        case 'ebay':
            data = parseEbayData(record.data, issues, recordLimit);
            break;
        case 'marketplaceConnect':
            data = parseMarketplaceConnectData(record.data, issues, recordLimit);
            break;
    }
    if (!data)
        return undefined;
    const provenance = parseProvenance(source, record.provenance, identities, data, issues);
    if (!provenance)
        return undefined;
    return { provenance, data };
}
export function parseReconciliationSnapshot(value, recordLimit = 5_000) {
    const issues = [];
    inspectForbiddenMaterial(value, 'snapshot', issues);
    const root = requireRecord(value, 'snapshot', issues);
    if (!root)
        throw new ReconciliationSnapshotError(issues);
    requireExactKeys(root, ['schemaVersion', 'kind', 'generatedAtUtc', 'identities', 'sources'], 'snapshot', issues);
    const schemaVersion = requireLiteral(root.schemaVersion, 2, 'snapshot.schemaVersion', issues);
    const kind = requireLiteral(root.kind, 'product-pipeline-shadow-reconciliation', 'snapshot.kind', issues);
    const generatedAtUtc = requireCanonicalTimestamp(root.generatedAtUtc, 'snapshot.generatedAtUtc', issues);
    const identities = parseIdentities(root.identities, issues);
    const sourcesValue = requireRecord(root.sources, 'snapshot.sources', issues);
    let sources;
    if (sourcesValue && identities) {
        requireExactKeys(sourcesValue, RECONCILIATION_SOURCES, 'snapshot.sources', issues);
        const productPipeline = parseSourceBundle('productPipeline', sourcesValue.productPipeline, identities, issues, recordLimit);
        const shopify = parseSourceBundle('shopify', sourcesValue.shopify, identities, issues, recordLimit);
        const ebay = parseSourceBundle('ebay', sourcesValue.ebay, identities, issues, recordLimit);
        const marketplaceConnect = parseSourceBundle('marketplaceConnect', sourcesValue.marketplaceConnect, identities, issues, recordLimit);
        if (productPipeline && shopify && ebay && marketplaceConnect) {
            sources = { productPipeline, shopify, ebay, marketplaceConnect };
        }
    }
    if (issues.length > 0)
        throw new ReconciliationSnapshotError(issues);
    return {
        schemaVersion: schemaVersion,
        kind: kind,
        generatedAtUtc: generatedAtUtc,
        identities: identities,
        sources: sources,
    };
}
