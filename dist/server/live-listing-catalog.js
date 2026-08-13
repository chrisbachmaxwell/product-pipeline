export class LiveListingCatalogError extends Error {
    constructor() {
        super('Live listing catalog is unavailable');
        this.name = 'LiveListingCatalogError';
    }
}
function normalizedSku(value) {
    return value.trim().toLocaleLowerCase('en-US');
}
function groupBy(values, key) {
    const groups = new Map();
    for (const value of values) {
        const groupKey = key(value);
        const group = groups.get(groupKey) ?? [];
        group.push(value);
        groups.set(groupKey, group);
    }
    return groups;
}
function duplicateExactSkus(values) {
    const groups = groupBy(values.filter((value) => value.sku !== ''), (value) => value.sku);
    return new Set([...groups].filter(([, group]) => group.length > 1).map(([sku]) => sku));
}
function nearCollisionSkus(values) {
    const groups = groupBy(values.filter((value) => value.sku !== ''), (value) => normalizedSku(value.sku));
    const collisions = new Set();
    for (const group of groups.values()) {
        if (new Set(group.map((value) => value.sku)).size > 1) {
            for (const value of group)
                collisions.add(value.sku);
        }
    }
    return collisions;
}
function crossSourceNearCollisionShopifySkus(shopifyValues, ebayValues) {
    const ebayRawByNormalized = new Map();
    for (const value of ebayValues) {
        if (value.sku === '')
            continue;
        const key = normalizedSku(value.sku);
        const rawValues = ebayRawByNormalized.get(key) ?? new Set();
        rawValues.add(value.sku);
        ebayRawByNormalized.set(key, rawValues);
    }
    const affectedShopifySkus = new Set();
    for (const value of shopifyValues) {
        if (value.sku === '')
            continue;
        const ebayRawValues = ebayRawByNormalized.get(normalizedSku(value.sku));
        if (ebayRawValues && [...ebayRawValues].some((rawSku) => rawSku !== value.sku)) {
            affectedShopifySkus.add(value.sku);
        }
    }
    return affectedShopifySkus;
}
function requireUnique(values, key) {
    const seen = new Set();
    for (const value of values) {
        const identity = key(value);
        if (seen.has(identity))
            throw new LiveListingCatalogError();
        seen.add(identity);
    }
}
export function buildLiveListingCatalogSnapshot(input) {
    if (Number.isNaN(new Date(input.observedAtUtc).getTime()))
        throw new LiveListingCatalogError();
    if (input.coverage.shopify.positiveStockVariants !== input.shopifyVariants.length
        || input.coverage.shopify.totalVariantsCaptured
            !== input.coverage.shopify.positiveStockVariants
                + input.coverage.shopify.excludedZeroInventory
                + input.coverage.shopify.excludedUnknownInventory
        || input.coverage.ebay.trading.activeListingCount
            !== new Set(input.ebayActiveListings.map((value) => value.listingId)).size
        || input.coverage.ebay.inventory.inventoryItemCount !== input.ebayInventoryItems.length
        || input.coverage.ebay.inventory.offerCount !== input.ebayOffers.length
        || input.shopifyVariants.some((variant) => !Number.isInteger(variant.available)
            || variant.available <= 0))
        throw new LiveListingCatalogError();
    requireUnique(input.shopifyVariants, (value) => value.variantId);
    requireUnique(input.ebayActiveListings, (value) => `${value.listingId}\u0000${value.sku}`);
    requireUnique(input.ebayInventoryItems, (value) => value.sku);
    requireUnique(input.ebayOffers, (value) => value.offerId);
    const duplicateShopify = duplicateExactSkus(input.shopifyVariants);
    const nearShopify = nearCollisionSkus(input.shopifyVariants);
    const ebaySkuValues = [
        ...input.ebayActiveListings,
        ...input.ebayInventoryItems,
        ...input.ebayOffers,
    ];
    const nearEbay = nearCollisionSkus(ebaySkuValues);
    const crossSourceNear = crossSourceNearCollisionShopifySkus(input.shopifyVariants, ebaySkuValues);
    const activeBySku = groupBy(input.ebayActiveListings, (value) => value.sku);
    const inventoryBySku = groupBy(input.ebayInventoryItems, (value) => value.sku);
    const offersBySku = groupBy(input.ebayOffers, (value) => value.sku);
    let missingShopifySkuCount = 0;
    let ambiguousActiveMatchCount = 0;
    let unpublishedArtifactSkuCount = 0;
    const rows = input.shopifyVariants.map((variant) => {
        const reasons = new Set();
        if (variant.productStatus.toUpperCase() !== 'ACTIVE')
            reasons.add('shopify_product_not_active');
        if (variant.sku.trim() === '') {
            reasons.add('shopify_sku_missing');
            missingShopifySkuCount += 1;
        }
        if (duplicateShopify.has(variant.sku))
            reasons.add('shopify_sku_duplicate');
        if (nearShopify.has(variant.sku))
            reasons.add('shopify_sku_near_collision');
        if (nearEbay.has(variant.sku) || crossSourceNear.has(variant.sku)) {
            reasons.add('ebay_sku_near_collision');
        }
        const activeMatches = activeBySku.get(variant.sku) ?? [];
        const inventoryItems = inventoryBySku.get(variant.sku) ?? [];
        const offers = offersBySku.get(variant.sku) ?? [];
        if (activeMatches.length > 1) {
            reasons.add('ebay_multiple_active_matches');
            ambiguousActiveMatchCount += 1;
        }
        const activeListing = activeMatches.length === 1 ? activeMatches[0] : null;
        const compatiblePublishedOffer = activeListing !== null
            && inventoryItems.length === 1
            && offers.length === 1
            && offers[0].status === 'PUBLISHED'
            && offers[0].listingId === activeListing.listingId
            && offers[0].listingStatus === 'ACTIVE';
        const artifactsAreExpected = activeMatches.length === 1
            && ((inventoryItems.length === 0 && offers.length === 0) || compatiblePublishedOffer);
        const unpublishedArtifactCount = artifactsAreExpected
            ? 0
            : inventoryItems.length + offers.length;
        if ((inventoryItems.length > 0 || offers.length > 0) && !artifactsAreExpected) {
            reasons.add('ebay_unpublished_artifact');
            unpublishedArtifactSkuCount += 1;
        }
        const lifecycleStatus = reasons.size > 0
            ? 'attention'
            : activeMatches.length === 1
                ? 'active'
                : 'not_listed';
        const matchingOffer = activeListing
            ? offers.find((offer) => offer.listingId === activeListing.listingId) ?? null
            : null;
        return Object.freeze({
            id: `shopify-variant:${variant.variantId}`,
            shopify: Object.freeze({ ...variant, price: Object.freeze({ ...variant.price }) }),
            ebay: Object.freeze({
                state: lifecycleStatus,
                listingId: activeListing?.listingId ?? null,
                offerId: matchingOffer?.offerId ?? null,
                url: activeListing ? `https://www.ebay.com/itm/${activeListing.listingId}` : null,
                activeMatchCount: activeMatches.length,
                inventoryItemCount: inventoryItems.length,
                offerCount: offers.length,
                unpublishedArtifactCount,
            }),
            lifecycleStatus,
            lastVerifiedAtUtc: input.observedAtUtc,
            audit: Object.freeze({
                verified: true,
                evidenceState: 'live_verified',
                unresolvedCount: reasons.size,
                attentionReasons: Object.freeze([...reasons].sort()),
                recoverySupported: false,
                currentRemoteStateVerified: true,
            }),
        });
    }).sort((left, right) => left.shopify.title.localeCompare(right.shopify.title)
        || left.shopify.sku.localeCompare(right.shopify.sku)
        || left.shopify.variantId.localeCompare(right.shopify.variantId));
    const summary = Object.freeze({
        active: rows.filter((row) => row.lifecycleStatus === 'active').length,
        notListed: rows.filter((row) => row.lifecycleStatus === 'not_listed').length,
        attention: rows.filter((row) => row.lifecycleStatus === 'attention').length,
        totalInStock: rows.length,
    });
    const coverage = Object.freeze({
        ...input.coverage,
        join: Object.freeze({
            key: 'exact_raw_sku',
            missingShopifySkuCount,
            duplicateShopifySkuCount: duplicateShopify.size,
            shopifyNearCollisionCount: nearShopify.size,
            ebayNearCollisionCount: new Set(input.shopifyVariants
                .filter((variant) => nearEbay.has(variant.sku) || crossSourceNear.has(variant.sku))
                .map((variant) => variant.sku)).size,
            ambiguousActiveMatchCount,
            unpublishedArtifactSkuCount,
        }),
    });
    return Object.freeze({
        observedAtUtc: input.observedAtUtc,
        rows: Object.freeze(rows),
        summary,
        coverage,
    });
}
export function projectLiveListingCatalogPage(snapshot, input) {
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100
        || !Number.isInteger(input.offset) || input.offset < 0)
        throw new LiveListingCatalogError();
    const search = input.search?.trim().toLocaleLowerCase('en-US') ?? '';
    const exactId = input.id?.trim() ?? '';
    const filtered = snapshot.rows.filter((row) => {
        if (exactId && row.id !== exactId)
            return false;
        if (input.status && row.lifecycleStatus !== input.status)
            return false;
        if (!search)
            return true;
        return [row.id, row.shopify.productId, row.shopify.variantId, row.shopify.sku,
            row.shopify.title, row.shopify.variantTitle, row.ebay.listingId, row.ebay.offerId]
            .filter((value) => typeof value === 'string')
            .some((value) => value.toLocaleLowerCase('en-US').includes(search));
    });
    return Object.freeze({
        schemaVersion: 2,
        data: Object.freeze(filtered.slice(input.offset, input.offset + input.limit)),
        total: filtered.length,
        limit: input.limit,
        offset: input.offset,
        summary: snapshot.summary,
        source: 'shopify-admin-graphql+ebay-active-listings',
        evidenceKind: 'live_read',
        authoritative: true,
        remoteReadPerformed: true,
        externalWritesPerformed: 0,
        observedAtUtc: snapshot.observedAtUtc,
        coverage: snapshot.coverage,
    });
}
