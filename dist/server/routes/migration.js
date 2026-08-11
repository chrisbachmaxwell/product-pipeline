import { Router } from 'express';
import { getRawDb } from '../../db/client.js';
import { getMigrationPolicyStatus } from '../../safety/writer-quarantine.js';
const router = Router();
const PROTECTED_SETTING_EXPECTATIONS = {
    auto_sync_enabled: 'false',
    sync_price: 'false',
    sync_inventory: 'false',
    listing_management_enabled: 'false',
    auto_list: 'false',
    ebay_order_import_cutoff: '',
};
export function buildMigrationStatus(local, observedAt = new Date().toISOString()) {
    const configurationExceptions = Object.entries(PROTECTED_SETTING_EXPECTATIONS)
        .filter(([key, expected]) => (local.settings[key] ?? '') !== expected)
        .map(([key, expected]) => ({
        code: 'STALE_LEGACY_SETTING',
        setting: key,
        observed: local.settings[key] ?? null,
        expected,
        effectiveBehavior: 'quarantined',
    }));
    return {
        ...getMigrationPolicyStatus(observedAt),
        sourceOfTruth: {
            productionWriter: 'shopify-marketplace-connect',
            productPipelineScope: 'local-observation-only',
        },
        reconciliation: {
            scope: 'local-ledger',
            generatedAt: observedAt,
            liveProof: false,
            productionParity: false,
            externalWrites: 0,
            historicalBackfillPerformed: false,
            orderCreationEligible: false,
            counts: {
                listingMappings: local.listingMappings,
                orderMappings: local.orderMappings,
                historicalEbayOrders: local.historicalEbayOrders,
                historicalOrdersIneligible: local.historicalEbayOrders,
            },
            exceptions: configurationExceptions,
            audit: {
                availableInWebRuntime: false,
                note: 'Use the local operator CLI to create and verify hash-chained snapshot evidence.',
            },
        },
    };
}
router.get('/api/migration/status', async (_req, res) => {
    try {
        const db = await getRawDb();
        const count = (table) => db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()
            ?.count ?? 0;
        const settingRows = db
            .prepare(`SELECT key, value FROM settings WHERE key IN (${Object.keys(PROTECTED_SETTING_EXPECTATIONS)
            .map(() => '?')
            .join(', ')})`)
            .all(...Object.keys(PROTECTED_SETTING_EXPECTATIONS));
        res.json(buildMigrationStatus({
            listingMappings: count('product_mappings'),
            orderMappings: count('order_mappings'),
            historicalEbayOrders: count('ebay_orders'),
            settings: Object.fromEntries(settingRows.map((row) => [row.key, row.value])),
        }));
    }
    catch {
        // Effective policy remains authoritative even if the legacy local ledger is unavailable.
        res.json({
            ...getMigrationPolicyStatus(),
            sourceOfTruth: {
                productionWriter: 'shopify-marketplace-connect',
                productPipelineScope: 'local-observation-only',
            },
            reconciliation: {
                scope: 'local-ledger',
                liveProof: false,
                productionParity: false,
                externalWrites: 0,
                historicalBackfillPerformed: false,
                orderCreationEligible: false,
                unavailable: true,
                exceptions: [{ code: 'LOCAL_LEDGER_UNAVAILABLE', effectiveBehavior: 'quarantined' }],
            },
        });
    }
});
export default router;
