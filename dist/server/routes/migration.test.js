import { describe, expect, it } from 'vitest';
import { buildMigrationStatus } from './migration.js';
describe('migration status projection', () => {
    it('keeps Marketplace Connect ownership authoritative despite stale legacy settings', () => {
        const result = buildMigrationStatus({
            listingMappings: 12,
            orderMappings: 8,
            historicalEbayOrders: 244,
            settings: {
                auto_sync_enabled: 'true',
                sync_price: 'true',
                sync_inventory: 'true',
                listing_management_enabled: 'true',
                auto_list: 'true',
                ebay_order_import_cutoff: '2026-02-11T00:00:00.000Z',
            },
        }, '2026-08-11T18:00:00.000Z');
        expect(result.effectiveMode).toBe('shadow-read-only');
        expect(result.externalWritesAllowed).toBe(false);
        expect(result.historicalBackfillAllowed).toBe(false);
        expect(result.cutoverWatermarkUtc).toBeNull();
        expect(result.sourceOfTruth.productionWriter).toBe('shopify-marketplace-connect');
        expect(result.reconciliation.orderCreationEligible).toBe(false);
        expect(result.reconciliation.counts.historicalOrdersIneligible).toBe(244);
        expect(result.reconciliation.exceptions).toHaveLength(6);
        expect(result.responsibilities.find((entry) => entry.responsibility === 'orderImport')).toEqual(expect.objectContaining({ owner: 'marketplace-connect', productPipelineAccess: 'disabled' }));
    });
    it('does not expose credentials or customer records', () => {
        const serialized = JSON.stringify(buildMigrationStatus({
            listingMappings: 0,
            orderMappings: 0,
            historicalEbayOrders: 0,
            settings: {
                auto_sync_enabled: 'false',
                sync_price: 'false',
                sync_inventory: 'false',
                listing_management_enabled: 'false',
                auto_list: 'false',
                ebay_order_import_cutoff: '',
            },
        }));
        expect(serialized).not.toMatch(/access[_-]?token|refresh[_-]?token|password|buyer|email|address/i);
    });
});
