import { RESPONSIBILITIES } from '../config.js';
export function validConfig(overrides = {}) {
    const ownership = Object.fromEntries(RESPONSIBILITIES.map((responsibility) => [
        responsibility,
        {
            currentOwner: responsibility === 'reconciliation' ? 'product-pipeline' : 'marketplace-connect',
            productPipelineAccess: 'read-only',
        },
    ]));
    return {
        schemaVersion: 1,
        project: 'product-pipeline',
        lane: 'production-shadow',
        mode: 'read-only',
        dryRun: true,
        writesEnabled: false,
        identities: {
            shopifyStoreDomain: 'usedcameragear.myshopify.com',
            ebayEnvironment: 'production',
            ebaySellerAccount: 'usedcam-0',
            marketplaceConnectAccount: 'usedcam-0',
        },
        ownership,
        orders: {
            importEnabled: false,
            historicalBackfill: false,
            cutoverWatermarkUtc: null,
        },
        testLane: {
            shopifyVariantGids: [],
            skus: [],
            ebayListingIds: [],
            responsibilities: [],
        },
        audit: {
            logPath: '.local/operator-audit/operator-cli.jsonl',
        },
        ...overrides,
    };
}
export function validReconciliationSnapshot(overrides = {}) {
    return {
        schemaVersion: 1,
        kind: 'product-pipeline-shadow-reconciliation',
        capturedAtUtc: '2026-08-11T16:00:00.000Z',
        identities: {
            shopifyStoreDomain: 'usedcameragear.myshopify.com',
            ebayEnvironment: 'production',
            ebaySellerAccount: 'usedcam-0',
            marketplaceConnectAccount: 'usedcam-0',
        },
        productPipeline: {
            listings: [
                {
                    shopifyProductId: '100',
                    shopifyVariantGid: 'gid://shopify/ProductVariant/101',
                    sku: 'SAFE-SKU-001',
                    ebayInventoryItemSku: 'SAFE-SKU-001',
                    ebayOfferId: 'OFFER-001',
                    ebayListingId: 'LISTING-001',
                    status: 'active',
                },
            ],
            orders: [
                {
                    ebayOrderId: 'EBAY-ORDER-001',
                    shopifyOrderGid: 'gid://shopify/Order/301',
                    state: 'mapped',
                },
            ],
        },
        shopify: {
            variants: [
                {
                    shopifyProductGid: 'gid://shopify/Product/100',
                    shopifyVariantGid: 'gid://shopify/ProductVariant/101',
                    sku: 'SAFE-SKU-001',
                    priceMinor: 12500,
                    currency: 'USD',
                    inventoryQuantity: 1,
                },
            ],
            orders: [
                {
                    shopifyOrderGid: 'gid://shopify/Order/301',
                    ebayOrderId: 'EBAY-ORDER-001',
                    importOwner: 'marketplace-connect',
                    createdAtUtc: '2026-08-11T15:00:00.000Z',
                    status: 'open',
                },
            ],
        },
        ebay: {
            listings: [
                {
                    inventoryItemSku: 'SAFE-SKU-001',
                    offerId: 'OFFER-001',
                    listingId: 'LISTING-001',
                    status: 'published',
                    priceMinor: 12500,
                    currency: 'USD',
                    availableQuantity: 1,
                },
            ],
            orders: [
                {
                    ebayOrderId: 'EBAY-ORDER-001',
                    createdAtUtc: '2026-08-11T14:59:00.000Z',
                    status: 'completed',
                },
            ],
        },
        marketplaceConnect: {
            orderImportEnabled: true,
            priceSyncEnabled: true,
            inventorySyncEnabled: true,
        },
        ...overrides,
    };
}
