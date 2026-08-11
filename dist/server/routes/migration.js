import { Router } from 'express';
import { getMigrationPolicyStatus } from '../../safety/writer-quarantine.js';
import { readConfiguredMigrationState, } from '../migration-state-reader.js';
import { openShadowDatabase } from '../shadow-db.js';
const router = Router();
const PROTECTED_SETTING_EXPECTATIONS = {
    auto_sync_enabled: 'false',
    sync_price: 'false',
    sync_inventory: 'false',
    listing_management_enabled: 'false',
    auto_list: 'false',
    ebay_order_import_cutoff: '',
};
const MARKETPLACE_CONNECT_BASELINE_DATE = '2026-08-11';
function buildEvidenceProjection(local) {
    const localCounts = local
        ? {
            listingMappings: local.listingMappings,
            orderMappings: local.orderMappings,
            historicalEbayOrders: local.historicalEbayOrders,
        }
        : {};
    return {
        sources: [
            {
                sourceId: 'product-pipeline-local-ledger',
                system: 'product-pipeline',
                evidenceClass: 'local-ledger-observation',
                acquisition: 'application-runtime-counts',
                status: local ? 'partial' : 'unavailable',
                capturedAtUtc: null,
                completeness: 'partial',
                freshness: 'unknown',
                counts: localCounts,
                normalizedPayloadDigest: null,
                limitations: [
                    'Runtime counts have no source-capture timestamp, pagination proof, or signed digest.',
                    'The ProductPipeline ledger is not authoritative Shopify or eBay state.',
                ],
            },
            {
                sourceId: 'shopify-authoritative-read',
                system: 'shopify',
                evidenceClass: 'unavailable',
                acquisition: 'none',
                status: 'unavailable',
                capturedAtUtc: null,
                completeness: 'unavailable',
                freshness: 'unknown',
                normalizedPayloadDigest: null,
                limitations: ['No bounded, redacted, provenance-bearing Shopify snapshot is available.'],
            },
            {
                sourceId: 'ebay-authoritative-read',
                system: 'ebay',
                evidenceClass: 'unavailable',
                acquisition: 'none',
                status: 'unavailable',
                capturedAtUtc: null,
                completeness: 'unavailable',
                freshness: 'unknown',
                normalizedPayloadDigest: null,
                limitations: ['No bounded, redacted, no-refresh eBay snapshot is available.'],
            },
            {
                sourceId: 'marketplace-connect-browser-baseline',
                system: 'marketplace-connect',
                evidenceClass: 'operator-attested-browser-observation',
                acquisition: 'signed-in-read-only-browser-walkthrough',
                status: 'partial',
                capturedAtUtc: null,
                baselineDate: MARKETPLACE_CONNECT_BASELINE_DATE,
                completeness: 'partial',
                freshness: 'unknown',
                coverage: { complete: false, records: 3, pages: 1 },
                normalizedPayloadDigest: null,
                limitations: [
                    'The walkthrough observed order import, price sync, and inventory sync enabled.',
                    'It does not prove per-item coverage, current configuration, fulfillment, feedback, or parity.',
                ],
            },
        ],
    };
}
function buildResponsibilityEvidence() {
    return [
        ...['orderImport', 'price', 'inventory'].map((responsibility) => ({
            responsibility,
            acceptedOwner: 'marketplace-connect',
            observedOwner: 'marketplace-connect',
            evidenceStatus: 'historical-baseline-only',
            capturedAtUtc: null,
            baselineDate: MARKETPLACE_CONNECT_BASELINE_DATE,
            canaryReady: false,
            summary: 'Marketplace Connect was observed as the incumbent on 2026-08-11; current authoritative cross-platform parity is unavailable.',
        })),
        ...[
            'listingCreate',
            'listingRevise',
            'listingEndRelist',
            'mapping',
            'fulfillment',
            'feedback',
            'reconciliation',
        ].map((responsibility) => ({
            responsibility,
            acceptedOwner: 'unverified',
            observedOwner: null,
            evidenceStatus: 'unverified',
            capturedAtUtc: null,
            canaryReady: false,
            summary: 'Production ownership and authoritative parity evidence remain unverified.',
        })),
    ];
}
export function buildMigrationStatus(local, servedAt = new Date().toISOString(), migrationState) {
    const configurationExceptions = Object.entries(PROTECTED_SETTING_EXPECTATIONS)
        .filter(([key, expected]) => (local.settings[key] ?? '') !== expected)
        .map(([key]) => ({
        code: 'STALE_LEGACY_SETTING',
        setting: key,
        detail: 'Stored legacy setting differs from the enforced shadow policy.',
        matchesExpected: false,
        effectiveBehavior: 'quarantined',
    }));
    return {
        ...getMigrationPolicyStatus(servedAt),
        sourceOfTruth: {
            acceptedProductionWriterBaseline: 'shopify-marketplace-connect',
            baselineEvidence: 'operator-attested-browser-observation',
            baselineDate: MARKETPLACE_CONNECT_BASELINE_DATE,
            productPipelineScope: 'local-observation-only',
        },
        migrationState,
        evidence: buildEvidenceProjection(local),
        responsibilityEvidence: buildResponsibilityEvidence(),
        reconciliation: {
            scope: 'local-ledger',
            generatedAt: servedAt,
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
export async function migrationStatusHandler(_req, res) {
    const servedAt = new Date().toISOString();
    const migrationState = await readConfiguredMigrationState();
    try {
        const db = openShadowDatabase();
        try {
            const count = (table) => db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()?.count ?? 0;
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
            }, servedAt, migrationState));
        }
        finally {
            db.close();
        }
    }
    catch {
        // Effective policy remains authoritative even if the legacy local ledger is unavailable.
        res.json({
            ...getMigrationPolicyStatus(servedAt),
            sourceOfTruth: {
                acceptedProductionWriterBaseline: 'shopify-marketplace-connect',
                baselineEvidence: 'operator-attested-browser-observation',
                baselineDate: MARKETPLACE_CONNECT_BASELINE_DATE,
                productPipelineScope: 'local-observation-only',
            },
            migrationState,
            evidence: buildEvidenceProjection(null),
            responsibilityEvidence: buildResponsibilityEvidence(),
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
}
router.get('/api/migration/status', migrationStatusHandler);
export default router;
