import { describe, expect, it } from 'vitest';
import { buildMigrationStatus } from './migration.js';

describe('migration status projection', () => {
  it('keeps Marketplace Connect ownership authoritative despite stale legacy settings', () => {
    const result = buildMigrationStatus(
      {
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
      },
      '2026-08-11T18:00:00.000Z',
    );

    expect(result.effectiveMode).toBe('shadow-read-only');
    expect(result.externalWritesAllowed).toBe(false);
    expect(result.historicalBackfillAllowed).toBe(false);
    expect(result.cutoverWatermarkUtc).toBeNull();
    expect(result.servedAt).toBe('2026-08-11T18:00:00.000Z');
    expect(result).not.toHaveProperty('observedAt');
    expect(result.sourceOfTruth.acceptedProductionWriterBaseline).toBe(
      'shopify-marketplace-connect',
    );
    expect(result.sourceOfTruth.baselineEvidence).toBe(
      'operator-attested-browser-observation',
    );
    expect(result.sourceOfTruth.productPipelineScope).toBe(
      'provider-read-only-local-draft',
    );
    expect(result.reconciliation.orderCreationEligible).toBe(false);
    expect(result.reconciliation.counts.historicalOrdersIneligible).toBe(244);
    expect(result.reconciliation.exceptions).toHaveLength(6);
    expect(result.reconciliation.exceptions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'STALE_LEGACY_SETTING',
          setting: 'auto_sync_enabled',
          matchesExpected: false,
          effectiveBehavior: 'quarantined',
        }),
      ]),
    );
    expect(result.evidence.sources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          system: 'shopify',
          evidenceClass: 'unavailable',
          capturedAtUtc: null,
        }),
        expect.objectContaining({
          system: 'marketplace-connect',
          status: 'partial',
          baselineDate: '2026-08-11',
        }),
      ]),
    );
    expect(
      result.responsibilityEvidence.find((entry) => entry.responsibility === 'listingCreate'),
    ).toEqual(expect.objectContaining({ acceptedOwner: 'unverified', canaryReady: false }));
    expect(result.responsibilities.map((entry) => entry.responsibility)).toEqual([
      'orderImport',
      'price',
      'inventory',
      'listingCreate',
      'listingRevise',
      'listingEndRelist',
      'mapping',
      'fulfillment',
      'feedback',
      'reconciliation',
    ]);
    expect(
      result.responsibilities.find((entry) => entry.responsibility === 'orderImport'),
    ).toEqual(
      expect.objectContaining({ owner: 'marketplace-connect', productPipelineAccess: 'disabled' }),
    );
  });

  it('does not expose credentials or customer records', () => {
    const serialized = JSON.stringify(
      buildMigrationStatus({
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
      }),
    );

    expect(serialized).not.toMatch(/access[_-]?token|refresh[_-]?token|password|buyer|email|address/i);
  });

  it('adds local durable state without weakening authoritative top-level quarantine fields', () => {
    const result = buildMigrationStatus(
      {
        listingMappings: 0,
        orderMappings: 0,
        historicalEbayOrders: 0,
        settings: {},
      },
      '2026-08-11T18:00:00.000Z',
      {
        status: 'not-configured',
        schemaVersion: null,
        scope: null,
        access: {
          writable: false,
          readOnly: true,
          externallyWired: false,
          externalWritesSupported: false,
          historicalBackfillAllowed: false,
        },
        counts: null,
        ownership: [],
        orders: {
          watermarkUtc: null,
          watermarkEstablished: false,
          eligibleForCreation: 0,
          historicalBackfillAllowed: false,
        },
        audit: { valid: false, recordCount: 0, headHash: null },
        readiness: {
          canaryReady: false,
          cutoverReady: false,
          blockers: ['migration-state-not-configured'],
        },
        errorCode: 'MIGRATION_STATE_NOT_CONFIGURED',
      },
    );

    expect(result.externalWritesAllowed).toBe(false);
    expect(result.historicalBackfillAllowed).toBe(false);
    expect(result.cutoverWatermarkUtc).toBeNull();
    expect(result.reconciliation.orderCreationEligible).toBe(false);
    expect(result.migrationState).toMatchObject({
      status: 'not-configured',
      access: { writable: false, externalWritesSupported: false },
      orders: { eligibleForCreation: 0, watermarkUtc: null },
      readiness: { canaryReady: false, cutoverReady: false },
    });
  });

  it('never returns a raw protected-setting value in status exceptions', () => {
    const result = buildMigrationStatus(
      {
        listingMappings: 0,
        orderMappings: 0,
        historicalEbayOrders: 0,
        settings: {
          auto_sync_enabled: 'Bearer must-not-escape',
          sync_price: 'operator@example.com',
        },
      },
      '2026-08-11T18:00:00.000Z',
    );
    const serialized = JSON.stringify(result);

    expect(serialized).not.toContain('must-not-escape');
    expect(serialized).not.toContain('operator@example.com');
    expect(result.reconciliation.exceptions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'STALE_LEGACY_SETTING',
          matchesExpected: false,
          effectiveBehavior: 'quarantined',
        }),
      ]),
    );
  });
});
