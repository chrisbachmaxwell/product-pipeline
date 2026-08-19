/**
 * Contract tests for the Trading-model price/inventory alignment path.
 * Everything runs against a real on-disk migration-state store and the real
 * bounded ReviseInventoryStatus adapter; only the live workspace read and
 * the HTTP transport are faked. No network access of any kind occurs.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createMigrationStore,
  deriveScopeKey,
  openMigrationStoreReadOnly,
  type IntegrationScope,
} from '../../migration-store/index.js';
import { LISTING_DRAFT_SCOPE } from '../../listing-control-config.js';
import type { ListingWorkspaceDto } from '../../server/listing-workspace-reader.js';
import {
  buildReviseInventoryStatusXml,
  createTradingAlignDispatchAdapter,
  TradingAlignDispatchError,
} from '../trading-dispatch-adapter.js';
import {
  buildPriceInventoryAdminProgram,
  type PriceInventoryAdminIo,
} from '../program.js';
import type { PriceInventoryDispatchAdapter } from '../dispatch-adapter.js';

const MIGRATION_SCOPE: IntegrationScope = {
  shopifyStoreDomain: LISTING_DRAFT_SCOPE.shopifyStoreDomain,
  ebayEnvironment: LISTING_DRAFT_SCOPE.ebayEnvironment,
  ebaySellerId: LISTING_DRAFT_SCOPE.ebaySellerId,
  ebayMarketplaceId: LISTING_DRAFT_SCOPE.ebayMarketplaceId,
};
const CATALOG_ID = 'shopify-variant:gid://shopify/ProductVariant/55396000999999';
const VARIANT_GID = 'gid://shopify/ProductVariant/55396000999999';
const PRODUCT_GID = 'gid://shopify/Product/10310708111111';
const SKU = 'NIK5018-U204';
const LISTING_ID = '146052671394';
const EVIDENCE_A = `sha256:${'a'.repeat(64)}`;
const EVIDENCE_B = `sha256:${'b'.repeat(64)}`;
const NO_START_PRICE = /<\/?StartPrice\b/iu;
const NO_QUANTITY = /<\/?Quantity\b/iu;

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

/**
 * A live workspace read for one legacy Trading-managed listing (no
 * Inventory item, no Offer), with the Shopify available quantity and the
 * eBay observed available quantity independently settable so quantity drift
 * can exist, land, or be absent. Prices agree so the only drift is quantity.
 */
function tradingWorkspace(options: {
  shopifyAvailable?: number;
  ebayQuantity?: number;
} = {}): ListingWorkspaceDto {
  const shopifyAvailable = options.shopifyAvailable ?? 3;
  const ebayQuantity = options.ebayQuantity ?? 1;
  return {
    schemaVersion: 1,
    evidence: {
      catalogObservedAtUtc: '2026-08-19T15:59:00.000Z',
      detailObservedAtUtc: '2026-08-19T16:00:01.000Z',
      freshness: 'live', backgroundRefreshSeconds: 60,
      remoteReadPerformed: true, externalWritesPerformed: 0,
    },
    catalog: {
      id: CATALOG_ID,
      shopify: {
        productId: PRODUCT_GID, variantId: VARIANT_GID, sku: SKU, title: 'Shopify New',
        variantTitle: 'Default', productStatus: 'ACTIVE', primaryImageUrl: null,
        imageCount: 1, available: shopifyAvailable,
        price: { amount: '129.95', currency: 'USD' },
      },
      ebay: {
        sku: SKU, state: 'active', listingId: LISTING_ID, offerId: null,
        url: `https://www.ebay.com/itm/${LISTING_ID}`,
        activeMatchCount: 1, inventoryItemCount: 0,
        offerCount: 0, unpublishedArtifactCount: 0,
      },
      lifecycleStatus: 'active',
      lastVerifiedAtUtc: '2026-08-19T15:59:00.000Z',
      audit: { verified: true, evidenceState: 'live_verified', unresolvedCount: 0,
        attentionReasons: [], recoverySupported: false, currentRemoteStateVerified: true },
    },
    mapping: {
      state: 'mapped', joinKey: 'exact_raw_sku',
      shopifyProductId: PRODUCT_GID, shopifyVariantId: VARIANT_GID,
      inventorySku: SKU, offerId: null, listingId: LISTING_ID,
      managementModel: 'legacy_trading',
      ownership: { listing: 'unverified', mapping: 'unverified',
        price: 'marketplace_connect', inventory: 'marketplace_connect' },
      editMode: 'read_only',
    },
    ebayDetail: {
      schemaVersion: 1,
      evidence: { source: 'ebay-trading-get-item',
        observedAtUtc: '2026-08-19T16:00:01.000Z', complete: true,
        remoteReadPerformed: true, externalWritesPerformed: 0, requestCount: 2 },
      identity: { sellerId: 'usedcameragear', marketplaceId: 'EBAY_US', mappingState: 'mapped',
        shopifyProductId: PRODUCT_GID, shopifyVariantId: VARIANT_GID, sku: SKU,
        listingId: LISTING_ID,
        publicListingUrl: `https://www.ebay.com/itm/${LISTING_ID}`, offerId: null },
      actual: {
        lifecycle: { status: 'ACTIVE', active: true, format: 'FIXED_PRICE', duration: 'GTC',
          startAtUtc: null, endAtUtc: null },
        content: { title: 'eBay Trading Old',
          descriptionHtml: '<p>Legacy &amp; loved</p>',
          imageUrls: ['https://i.ebayimg.com/images/g/xyz/s-l1600.jpg'] },
        category: { primary: { id: '78997', name: 'Lenses' }, secondary: null, storeCategories: [] },
        condition: { id: '3000', name: 'Used', description: 'Excellent', descriptors: [] },
        aspects: { Mount: ['Nikon F'], Brand: ['Nikon'] },
        identifiers: { brand: 'Nikon', mpn: null, upc: [], ean: [], isbn: [], epid: null },
        commerce: { price: { value: '129.95', currency: 'USD' }, totalQuantity: ebayQuantity,
          soldQuantity: 0, availableQuantity: ebayQuantity,
          availableQuantityBasis: 'reported', bestOfferEnabled: false },
        policies: { fulfillmentPolicyId: '6055555000', paymentPolicyId: '6066666000',
          returnPolicyId: '6077777000', paymentMethods: [], shippingType: null,
          domesticServices: [], internationalServices: [], returnsAccepted: true,
          returnPeriod: null, returnShippingCostPayer: null },
        location: { publicLocation: 'Utah', countryCode: 'US' },
      },
      management: { model: 'legacy_trading', controlApi: 'trading', joinKey: 'exact_raw_sku',
        exactBindings: { seller: true, listing: true, sku: true, inventoryItem: false,
          offer: false, offerToListing: false }, lifecycleAligned: true,
        inventoryItem: null, offer: null },
    },
  };
}

type CapturedRequest = {
  url: string;
  headers: Record<string, string>;
  body: string;
};

type TradingWorld = {
  migrationDatabasePath: string;
  setWorkspace: (dto: ListingWorkspaceDto) => void;
  requests: CapturedRequest[];
  inventoryAdapterCalls: string[];
  setResponseAck: (ack: string) => void;
  setFlipOnSuccess: (flip: boolean) => void;
  stdout: string[];
  stderr: string[];
  exitCodes: number[];
  run: (argv: string[]) => Promise<void>;
};

function createTradingWorld(): TradingWorld {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trading-align-admin-'));
  fs.chmodSync(root, 0o700);
  roots.push(root);

  let current = tradingWorkspace();
  const migrationDatabasePath = path.join(root, 'migration-state.sqlite');
  createMigrationStore({
    databasePath: migrationDatabasePath,
    scope: MIGRATION_SCOPE,
    createdAtUtc: '2026-08-01T00:00:00.000Z',
  }).close();

  // The real bounded Trading adapter over a captured, network-free
  // transport. On Ack Success the observed eBay quantity flips to the
  // Shopify available quantity (unless propagation delay is simulated).
  const requests: CapturedRequest[] = [];
  let responseAck = 'Success';
  let flipOnSuccess = true;
  const fakeFetch: typeof fetch = async (input, init) => {
    requests.push({
      url: String(input),
      headers: { ...(init?.headers as Record<string, string> | undefined) },
      body: String(init?.body ?? ''),
    });
    if (responseAck === 'Success' && flipOnSuccess) {
      const available = (current.catalog.shopify as { available: number }).available;
      current = tradingWorkspace({ shopifyAvailable: available, ebayQuantity: available });
    }
    return new Response(
      '<?xml version="1.0" encoding="UTF-8"?>'
      + '<ReviseInventoryStatusResponse xmlns="urn:ebay:apis:eBLBaseComponents">'
      + `<Ack>${responseAck}</Ack>`
      + '</ReviseInventoryStatusResponse>',
      { status: 200, headers: { 'Content-Type': 'text/xml' } },
    );
  };
  const tradingAdapter = createTradingAlignDispatchAdapter({
    fetchImpl: fakeFetch,
    getAccessToken: async () => 'test-iaf-token',
  });

  // The Inventory-API adapter must never be touched by a Trading dispatch.
  const inventoryAdapterCalls: string[] = [];
  const unexpected = (name: string) => async (): Promise<never> => {
    inventoryAdapterCalls.push(name);
    throw new Error('inventory adapter must not be called for a trading target');
  };
  const inventoryAdapter: PriceInventoryDispatchAdapter = Object.freeze({
    updateOfferPrice: unexpected('updateOfferPrice'),
    updateOfferQuantity: unexpected('updateOfferQuantity'),
  });

  const stdout: string[] = [];
  const stderr: string[] = [];
  const exitCodes: number[] = [];
  const io: PriceInventoryAdminIo = {
    stdout: (message) => stdout.push(message),
    stderr: (message) => stderr.push(message),
    setExitCode: (code) => exitCodes.push(code),
  };
  const run = async (argv: string[]): Promise<void> => {
    await buildPriceInventoryAdminProgram({
      readWorkspace: async () => current,
      createAdapter: () => inventoryAdapter,
      createTradingAdapter: () => tradingAdapter,
      io,
    }).parseAsync(argv, { from: 'user' });
  };

  return {
    migrationDatabasePath,
    setWorkspace: (dto) => { current = dto; },
    requests,
    inventoryAdapterCalls,
    setResponseAck: (ack) => { responseAck = ack; },
    setFlipOnSuccess: (flip) => { flipOnSuccess = flip; },
    stdout,
    stderr,
    exitCodes,
    run,
  };
}

function targetArguments(field: string): string[] {
  return [
    '--catalog-id', CATALOG_ID,
    '--sku', SKU,
    '--listing-id', LISTING_ID,
    '--offer-id', 'none',
    '--field', field,
  ];
}

function establishArguments(responsibility: string, migrationStore: string): string[] {
  return ['establish-ownership',
    '--migration-store', migrationStore,
    '--confirm-scope', deriveScopeKey(MIGRATION_SCOPE),
    '--responsibility', responsibility,
    '--baseline-evidence', EVIDENCE_A,
    '--mc-disabled-evidence', EVIDENCE_B,
  ];
}

function lastJson(lines: string[]): Record<string, unknown> {
  expect(lines.length).toBeGreaterThan(0);
  return JSON.parse(lines[lines.length - 1]!) as Record<string, unknown>;
}

describe('trading-model price/inventory alignment dispatch', () => {
  it('dispatches one quantity alignment through one bounded ReviseInventoryStatus POST', async () => {
    const world = createTradingWorld();

    await world.run(establishArguments('inventory', world.migrationDatabasePath));
    expect(lastJson(world.stdout)).toMatchObject({
      status: 'established', responsibility: 'inventory', version: 3,
    });

    await world.run(['plan', ...targetArguments('quantity')]);
    const preview = lastJson(world.stdout);
    expect(preview).toMatchObject({
      command: 'plan',
      status: 'preview',
      field: 'quantity',
      responsibility: 'inventory',
      drift: { before: '1', after: '3' },
      externalWritesPerformed: 0,
    });
    expect(world.exitCodes.at(-1)).toBe(2);
    expect(world.requests).toHaveLength(0);
    const manifestDigest = preview.manifestDigest as string;

    await world.run(['dispatch', ...targetArguments('quantity'),
      '--manifest-digest', manifestDigest,
      '--migration-store', world.migrationDatabasePath,
    ]);
    const dispatched = lastJson(world.stdout);
    expect(dispatched).toMatchObject({
      command: 'dispatch',
      status: 'dispatched-and-reconciled',
      field: 'quantity',
      responsibility: 'inventory',
      effect: 'effect_observed',
      resolution: 'resolved_existing',
      providerDispatchReported: true,
      externalCommerceWritesAttempted: 1,
    });

    // Exactly one bounded Trading POST with the exact call headers; the XML
    // carries the ItemID plus Quantity and can never carry a price element.
    expect(world.inventoryAdapterCalls).toHaveLength(0);
    expect(world.requests).toHaveLength(1);
    const request = world.requests[0]!;
    expect(request.url).toBe('https://api.ebay.com/ws/api.dll');
    expect(request.headers['X-EBAY-API-CALL-NAME']).toBe('ReviseInventoryStatus');
    expect(request.headers['X-EBAY-API-COMPATIBILITY-LEVEL']).toBe('1349');
    expect(request.headers['X-EBAY-API-SITEID']).toBe('0');
    expect(request.headers['X-EBAY-API-IAF-TOKEN']).toBe('test-iaf-token');
    expect(request.body).toContain(
      `<InventoryStatus><ItemID>${LISTING_ID}</ItemID><Quantity>3</Quantity></InventoryStatus>`,
    );
    expect((request.body.match(/<InventoryStatus>/g) ?? []).length).toBe(1);
    expect(request.body).not.toMatch(NO_START_PRICE);

    const store = openMigrationStoreReadOnly({
      databasePath: world.migrationDatabasePath,
      expectedScope: MIGRATION_SCOPE,
    });
    expect(store.getJobStatus(dispatched.jobId as string)).toMatchObject({
      state: 'resolved_existing',
    });
    expect(store.getCounts()).toMatchObject({
      idempotency_intents: 1,
      execution_jobs: 1,
      intent_attempts: 1,
      attempt_resolutions: 1,
      target_effect_observations: 1,
      listing_revise_observations: 0,
    });
    expect(store.verifyAuditChain()).toMatchObject({ valid: true });
    store.close();

    // The alignment landed: no drift remains and no replay can plan.
    await world.run(['plan', ...targetArguments('quantity')]);
    expect(lastJson(world.stderr)).toMatchObject({ code: 'PLAN_NO_DRIFT' });
    expect(world.requests).toHaveLength(1);
  });

  it('holds an unobserved effect open and resolves it through reconcile', async () => {
    const world = createTradingWorld();
    await world.run(establishArguments('inventory', world.migrationDatabasePath));
    await world.run(['plan', ...targetArguments('quantity')]);
    const manifestDigest = lastJson(world.stdout).manifestDigest as string;

    // The provider accepts the write but the read projection has not caught
    // up yet: the job must stay open — propagation delay never fabricates a
    // terminal outcome.
    world.setFlipOnSuccess(false);
    await world.run(['dispatch', ...targetArguments('quantity'),
      '--manifest-digest', manifestDigest,
      '--migration-store', world.migrationDatabasePath,
    ]);
    const dispatched = lastJson(world.stdout);
    expect(dispatched).toMatchObject({
      command: 'dispatch',
      status: 'dispatched-unresolved',
      providerDispatchReported: true,
      effect: 'effect_absent',
      resolution: null,
    });
    expect(world.exitCodes.at(-1)).toBe(1);

    const openStore = openMigrationStoreReadOnly({
      databasePath: world.migrationDatabasePath,
      expectedScope: MIGRATION_SCOPE,
    });
    expect(openStore.getJobStatus(dispatched.jobId as string)).toMatchObject({
      state: 'reconciliation_required',
    });
    openStore.close();

    // The effect propagates; reconcile re-verifies against the exact
    // dispatched manifest (digest-bound before/after) and resolves.
    world.setWorkspace(tradingWorkspace({ shopifyAvailable: 3, ebayQuantity: 3 }));
    await world.run(['reconcile', ...targetArguments('quantity'),
      '--manifest-digest', manifestDigest,
      '--before', '1',
      '--after', '3',
      '--migration-store', world.migrationDatabasePath,
      '--job-id', dispatched.jobId as string,
      '--attempt-id', dispatched.attemptId as string,
    ]);
    expect(lastJson(world.stdout)).toMatchObject({
      command: 'reconcile',
      status: 'reconciled',
      effect: 'effect_observed',
      resolution: 'resolved_existing',
      externalWritesPerformed: 0,
    });

    const store = openMigrationStoreReadOnly({
      databasePath: world.migrationDatabasePath,
      expectedScope: MIGRATION_SCOPE,
    });
    expect(store.getJobStatus(dispatched.jobId as string)).toMatchObject({
      state: 'resolved_existing',
    });
    expect(store.verifyAuditChain()).toMatchObject({ valid: true });
    store.close();

    // A wrong before/after pair cannot bind to the dispatched manifest.
    await world.run(['reconcile', ...targetArguments('quantity'),
      '--manifest-digest', manifestDigest,
      '--before', '2',
      '--after', '3',
      '--migration-store', world.migrationDatabasePath,
      '--job-id', dispatched.jobId as string,
      '--attempt-id', dispatched.attemptId as string,
    ]);
    expect(lastJson(world.stderr)).toMatchObject({ code: 'REALIGN_MANIFEST_DIGEST_MISMATCH' });
  });

  it('records a provider-rejected trading dispatch as confirmed_missing', async () => {
    const world = createTradingWorld();
    await world.run(establishArguments('inventory', world.migrationDatabasePath));
    await world.run(['plan', ...targetArguments('quantity')]);
    const manifestDigest = lastJson(world.stdout).manifestDigest as string;

    world.setResponseAck('Failure');
    await world.run(['dispatch', ...targetArguments('quantity'),
      '--manifest-digest', manifestDigest,
      '--migration-store', world.migrationDatabasePath,
    ]);
    const dispatched = lastJson(world.stdout);
    expect(dispatched).toMatchObject({
      command: 'dispatch',
      status: 'dispatched-unresolved',
      providerDispatchReported: false,
      effect: 'effect_absent',
      resolution: 'confirmed_missing',
      externalCommerceWritesAttempted: 1,
    });
    expect(world.exitCodes.at(-1)).toBe(1);
    expect(world.requests).toHaveLength(1);

    const store = openMigrationStoreReadOnly({
      databasePath: world.migrationDatabasePath,
      expectedScope: MIGRATION_SCOPE,
    });
    expect(store.getJobStatus(dispatched.jobId as string)).toMatchObject({
      state: 'confirmed_missing',
    });
    expect(store.verifyAuditChain()).toMatchObject({ valid: true });
    store.close();

    // The drift is unchanged, so a replay reaches — and is denied by — the
    // durable intent-uniqueness layer before any provider call.
    await world.run(['dispatch', ...targetArguments('quantity'),
      '--manifest-digest', manifestDigest,
      '--migration-store', world.migrationDatabasePath,
    ]);
    expect(lastJson(world.stderr)).toMatchObject({ code: 'REALIGN_INTENT_ALREADY_RECORDED' });
    expect(world.requests).toHaveLength(1);
  });

  it('requires a numeric offer id for inventory targets and "none" for trading targets', async () => {
    const world = createTradingWorld();
    await world.run(['plan',
      '--catalog-id', CATALOG_ID,
      '--sku', SKU,
      '--listing-id', LISTING_ID,
      '--offer-id', '234942877011',
      '--field', 'quantity',
    ]);
    expect(lastJson(world.stderr)).toMatchObject({ code: 'REALIGN_EXACT_TARGET_MISMATCH' });
    expect(world.requests).toHaveLength(0);
  });

  it('serializes exactly one InventoryStatus and never cross-contaminates fields', () => {
    const priceXml = buildReviseInventoryStatusXml({
      listingId: LISTING_ID,
      field: 'price',
      price: { value: '129.95', currency: 'USD' },
    });
    expect(priceXml).toContain(
      `<InventoryStatus><ItemID>${LISTING_ID}</ItemID>`
      + '<StartPrice currencyID="USD">129.95</StartPrice></InventoryStatus>',
    );
    expect((priceXml.match(/<InventoryStatus>/g) ?? []).length).toBe(1);
    expect(priceXml).not.toMatch(NO_QUANTITY);

    const quantityXml = buildReviseInventoryStatusXml({
      listingId: LISTING_ID,
      field: 'quantity',
      quantity: 0,
    });
    expect(quantityXml).toContain('<Quantity>0</Quantity>');
    expect(quantityXml).not.toMatch(NO_START_PRICE);

    expect(() => buildReviseInventoryStatusXml({
      listingId: 'not-an-item-id', field: 'quantity', quantity: 1,
    })).toThrow(TradingAlignDispatchError);
    expect(() => buildReviseInventoryStatusXml({
      listingId: LISTING_ID, field: 'quantity', quantity: -1,
    })).toThrow(TradingAlignDispatchError);
    expect(() => buildReviseInventoryStatusXml({
      listingId: LISTING_ID, field: 'price', price: { value: '0', currency: 'USD' },
    })).toThrow(TradingAlignDispatchError);
    expect(() => buildReviseInventoryStatusXml({
      listingId: LISTING_ID, field: 'price', price: { value: '12.345', currency: 'USD' },
    })).toThrow(TradingAlignDispatchError);
    expect(() => buildReviseInventoryStatusXml({
      listingId: LISTING_ID, field: 'price', price: { value: '12.95', currency: 'usd' },
    })).toThrow(TradingAlignDispatchError);
  });
});
