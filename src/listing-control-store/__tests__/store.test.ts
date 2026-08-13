import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import {
  LISTING_CONTROL_STORE_CAPABILITIES,
  ListingControlStoreError,
  deriveListingBaseDigests,
  initializeListingControlStore,
  openListingControlStore,
  openListingControlStoreReadOnly,
  sha256Digest,
} from '../store.js';
import { LISTING_FIELD_NAMES, type ListingControlScope, type ListingFieldInput, type ListingRevisionInput } from '../types.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const scope: ListingControlScope = {
  shopifyStoreDomain: 'usedcameragear.myshopify.com',
  ebayEnvironment: 'production',
  ebaySellerId: 'usedcameragear',
  ebayMarketplaceId: 'EBAY_US',
};

function temporaryPath(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'listing-control-store-'));
  fs.chmodSync(root, 0o700);
  roots.push(root);
  return path.join(root, 'listing-control.sqlite');
}

function fields(overrides: Partial<Record<string, Partial<ListingFieldInput>>> = {}): ListingFieldInput[] {
  return LISTING_FIELD_NAMES.map((field) => {
    const sourceValue = field === 'title' ? 'Canon 35-70mm Lens' : null;
    const proposedValue = sourceValue;
    const observedValue = field === 'title' ? 'Canon 35-70mm Lens' : null;
    const base: ListingFieldInput = {
      field,
      sourceValue,
      sourceDigest: sha256Digest({ state: sourceValue === null ? 'missing' : 'value', value: sourceValue }),
      defaultValue: null,
      defaultDigest: sha256Digest({ state: 'not_set', value: null }),
      overrideValue: null,
      overrideDigest: sha256Digest({ state: 'not_set', value: null }),
      proposedValue,
      proposedDigest: sha256Digest({ state: proposedValue === null ? 'omitted' : 'value', value: proposedValue }),
      proposedSource: proposedValue === null ? 'omit' : 'source',
      observedValue,
      observedDigest: sha256Digest({ state: observedValue === null ? 'unavailable' : 'value', value: observedValue }),
    };
    return { ...base, ...(overrides[field] ?? {}) };
  });
}

function revision(overrides: Partial<ListingRevisionInput> = {}): ListingRevisionInput {
  const base = {
    revisionId: 'revision-1',
    identity: {
      shopifyProductGid: 'gid://shopify/Product/1001',
      shopifyVariantGid: 'gid://shopify/ProductVariant/2001',
      rawSku: 'CAN3570-U119',
      ebaySellerId: 'usedcameragear',
      ebayMarketplaceId: 'EBAY_US',
      managementModel: 'inventory_api',
      ebayInventorySku: 'CAN3570-U119',
      ebayOfferId: '234942877011',
      ebayListingId: '147502608418',
    },
    baseSourceDigest: sha256Digest('placeholder-source-observation'),
    baseSourceObservedAtUtc: '2026-08-13T20:00:00.000Z',
    baseEbayObservationDigest: sha256Digest('placeholder-ebay-observation'),
    baseEbayObservedAtUtc: '2026-08-13T20:00:01.000Z',
    fields: fields(),
    actor: 'operator-chris',
    state: 'draft',
    createdAtUtc: '2026-08-13T20:00:02.000Z',
    expectedPreviousRevisionDigest: null,
    expectedLatestBaseSourceDigest: null,
    expectedLatestBaseEbayObservationDigest: null,
    auditEventId: 'revision-created-1',
  };
  const merged = { ...base, ...overrides } as ListingRevisionInput;
  const derived = deriveListingBaseDigests({
    scope,
    identity: merged.identity,
    baseSourceObservedAtUtc: merged.baseSourceObservedAtUtc,
    baseEbayObservedAtUtc: merged.baseEbayObservedAtUtc,
    fields: merged.fields,
  });
  return {
    ...merged,
    baseSourceDigest: overrides.baseSourceDigest ?? derived.source,
    baseEbayObservationDigest: overrides.baseEbayObservationDigest ?? derived.ebay,
  };
}

function initialized() {
  const databasePath = temporaryPath();
  const store = initializeListingControlStore({
    databasePath,
    scope,
    createdAtUtc: '2026-08-13T19:59:59.000Z',
  });
  return { databasePath, store };
}

function expectCode(operation: () => unknown, code: ListingControlStoreError['code']): void {
  try {
    operation();
    throw new Error(`Expected ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(ListingControlStoreError);
    expect((error as ListingControlStoreError).code).toBe(code);
  }
}

describe('listing control store', () => {
  it('initializes explicitly as one 0600 content-review-only file and operational open never creates', () => {
    const databasePath = temporaryPath();
    expectCode(
      () => openListingControlStore({ databasePath, expectedScope: scope }),
      'PATH_REJECTED',
    );
    expect(fs.existsSync(databasePath)).toBe(false);

    const store = initializeListingControlStore({
      databasePath,
      scope,
      createdAtUtc: '2026-08-13T19:59:59.000Z',
    });
    expect(fs.statSync(databasePath).mode & 0o777).toBe(0o600);
    expect(store.capabilities).toEqual({
      ...LISTING_CONTROL_STORE_CAPABILITIES,
      runtimeWired: false,
      providerReadSupported: false,
      providerWriteSupported: false,
      externalWritesSupported: false,
      publishAuthorizationSupported: false,
      contentReviewOnly: true,
    });
    expect(store.verifyAudit()).toMatchObject({ valid: true, recordCount: 1 });
    store.close();

    const readOnly = openListingControlStoreReadOnly({ databasePath, expectedScope: scope });
    expect(readOnly.writable).toBe(false);
    expectCode(() => readOnly.createRevision(revision()), 'READ_ONLY');
    readOnly.close();
  });

  it('stores a complete immutable revision with exact identities, lane digests, and audit binding', () => {
    const { store } = initialized();
    const created = store.createRevision(revision());
    expect(created.revisionNumber).toBe(1);
    expect(created.identity.rawSku).toBe('CAN3570-U119');
    expect(created.identity.shopifyVariantGid).toBe('gid://shopify/ProductVariant/2001');
    expect(created.fields).toHaveLength(LISTING_FIELD_NAMES.length);
    expect(created.fields.find((field) => field.field === 'quantity')).toMatchObject({
      sourceValue: null,
      defaultValue: null,
      overrideValue: null,
      proposedValue: null,
      observedValue: null,
    });
    expect(store.getRevision('revision-1')).toEqual(created);
    expect(store.getLatestRevision('gid://shopify/ProductVariant/2001')).toEqual(created);
    expect(store.verifyAudit()).toMatchObject({ valid: true, recordCount: 2 });
    expect(() => store.verifyIntegrity()).not.toThrow();
    store.close();
  });

  it('rejects replay and stale-base appends without adding a revision or audit event', () => {
    const { store } = initialized();
    const first = store.createRevision(revision());
    expectCode(() => store.createRevision(revision()), 'CONFLICT');
    expectCode(() => store.createRevision(revision({
      revisionId: 'revision-2',
      auditEventId: 'revision-created-2',
      createdAtUtc: '2026-08-13T20:00:03.000Z',
    })), 'STALE_BASE');
    expect(store.getLatestRevision(first.identity.shopifyVariantGid)?.revisionDigest)
      .toBe(first.revisionDigest);
    expect(store.verifyAudit()).toMatchObject({ valid: true, recordCount: 2 });
    store.close();
  });

  it('serializes two independent writers so only one revision can consume a base', () => {
    const { databasePath, store: firstWriter } = initialized();
    const secondWriter = openListingControlStore({ databasePath, expectedScope: scope });
    const first = firstWriter.createRevision(revision());
    expect(first.revisionNumber).toBe(1);
    expectCode(() => secondWriter.createRevision(revision({
      revisionId: 'revision-racing',
      auditEventId: 'revision-racing-event',
    })), 'STALE_BASE');
    expect(secondWriter.getLatestRevision(first.identity.shopifyVariantGid)?.revisionDigest)
      .toBe(first.revisionDigest);
    expect(secondWriter.verifyAudit()).toMatchObject({ valid: true, recordCount: 2 });
    secondWriter.close();
    firstWriter.close();
  });

  it('serializes simultaneous processes so exactly one consumes the same base', async () => {
    const { databasePath, store } = initialized();
    store.close();
    const runner = fileURLToPath(new URL('./concurrent-writer.ts', import.meta.url));
    const inputs = [
      revision({ revisionId: 'process-a', auditEventId: 'process-a-event' }),
      revision({ revisionId: 'process-b', auditEventId: 'process-b-event' }),
    ];
    const children = inputs.map((input) => spawn(
      process.execPath,
      ['--import', 'tsx', runner, databasePath, JSON.stringify(scope), JSON.stringify(input)],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    ));
    const outputs = children.map((child) => new Promise<string>((resolve, reject) => {
      let output = '';
      let errors = '';
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => { output += chunk; });
      child.stderr.on('data', (chunk: string) => { errors += chunk; });
      child.once('error', reject);
      child.once('close', (code) => {
        if (code === 0) resolve(output);
        else reject(new Error(`Concurrent writer exited ${code}: ${errors}`));
      });
    }));
    await Promise.all(children.map((child) => new Promise<void>((resolve, reject) => {
      const ready = (chunk: Buffer | string) => {
        if (String(chunk).includes('READY')) {
          child.stdout.off('data', ready);
          resolve();
        }
      };
      child.stdout.on('data', ready);
      child.once('error', reject);
    })));
    for (const child of children) child.stdin.end('\n');
    const results = (await Promise.all(outputs)).map((output) => {
      const line = output.split('\n').find((entry) => entry.startsWith('RESULT:'));
      if (!line) throw new Error(`Missing writer result: ${output}`);
      return JSON.parse(line.slice('RESULT:'.length)) as { ok: boolean; code?: string };
    });
    expect(results.filter(({ ok }) => ok)).toHaveLength(1);
    expect(results.filter(({ ok }) => !ok)).toEqual([{ ok: false, code: 'STALE_BASE' }]);

    const reopened = openListingControlStoreReadOnly({ databasePath, expectedScope: scope });
    expect(reopened.verifyAudit()).toMatchObject({ valid: true, recordCount: 2 });
    reopened.close();
  });

  it('fails closed on cross-account scope, subject identity, and remote-ID reuse', () => {
    const { databasePath, store } = initialized();
    expectCode(() => openListingControlStore({
      databasePath,
      expectedScope: { ...scope, ebaySellerId: 'another-seller' },
    }), 'ACCOUNT_DRIFT');
    expectCode(() => store.createRevision(revision({
      identity: { ...revision().identity, ebaySellerId: 'another-seller' },
    })), 'ACCOUNT_DRIFT');
    store.createRevision(revision());
    expectCode(() => store.createRevision(revision({
      revisionId: 'revision-other-subject',
      identity: {
        ...revision().identity,
        shopifyProductGid: 'gid://shopify/Product/1002',
        shopifyVariantGid: 'gid://shopify/ProductVariant/2002',
        rawSku: 'OTHER-U001',
        ebayInventorySku: 'OTHER-U001',
      },
      auditEventId: 'revision-other-subject-event',
      createdAtUtc: '2026-08-13T20:00:03.000Z',
    })), 'CONFLICT');
    expectCode(() => store.createRevision(revision({
      revisionId: 'revision-duplicate-sku',
      identity: {
        ...revision().identity,
        shopifyProductGid: 'gid://shopify/Product/1003',
        shopifyVariantGid: 'gid://shopify/ProductVariant/2003',
        ebayOfferId: null,
        ebayListingId: null,
      },
      auditEventId: 'revision-duplicate-sku-event',
      createdAtUtc: '2026-08-13T20:00:04.000Z',
    })), 'CONFLICT');
    expect(store.verifyAudit()).toMatchObject({ valid: true, recordCount: 2 });
    store.close();
  });

  it('blocks direct mutation and detects content tampering even after the trigger is restored', () => {
    const { databasePath, store } = initialized();
    store.createRevision(revision());
    store.close();

    const raw = new Database(databasePath);
    expect(() => raw.prepare(
      "UPDATE listing_revision_fields SET proposed_value = 'tampered' WHERE revision_id = 'revision-1' AND field_name = 'title'",
    ).run()).toThrow(/append-only/);
    expect(() => raw.prepare(
      `INSERT OR REPLACE INTO listing_revision_fields
       SELECT * FROM listing_revision_fields WHERE revision_id = 'revision-1' AND field_name = 'title'`,
    ).run()).toThrow(/replay or replacement/);
    const trigger = raw.prepare(
      "SELECT sql FROM sqlite_schema WHERE type = 'trigger' AND name = 'listing_revision_fields_deny_update'",
    ).get() as { sql: string };
    raw.exec('DROP TRIGGER listing_revision_fields_deny_update');
    raw.prepare(
      `UPDATE listing_revision_fields
       SET source_value = 'tampered', proposed_value = 'tampered'
       WHERE revision_id = 'revision-1' AND field_name = 'title'`,
    ).run();
    raw.exec(trigger.sql);
    raw.close();

    expectCode(() => openListingControlStore({ databasePath, expectedScope: scope }), 'SCHEMA_MISMATCH');
  });

  it('rejects credential-shaped values before persistence', () => {
    const { databasePath, store } = initialized();
    const sentinel = 'access_token=sk-live-THIS-MUST-NEVER-BE-STORED';
    const unsafeFields = fields({
      description: {
        sourceValue: sentinel,
        sourceDigest: sha256Digest({ state: 'value', value: sentinel }),
        proposedValue: sentinel,
        proposedDigest: sha256Digest({ state: 'value', value: sentinel }),
      },
    });
    expectCode(() => store.createRevision(revision({ fields: unsafeFields })), 'INVALID_INPUT');
    expect(store.verifyAudit()).toMatchObject({ valid: true, recordCount: 1 });
    store.close();
    expect(fs.readFileSync(databasePath).includes(Buffer.from(sentinel, 'utf8'))).toBe(false);
  });

  it('rejects unknown keys that could smuggle provider bodies', () => {
    const { store } = initialized();
    const smuggled = {
      ...revision(),
      providerResponseBody: 'not persisted',
    } as ListingRevisionInput;
    expectCode(() => store.createRevision(smuggled), 'INVALID_INPUT');
    expect(store.verifyAudit()).toMatchObject({ valid: true, recordCount: 1 });
    store.close();
  });

  it('never fabricates defaults and rejects the legacy quantity-one fallback', () => {
    const { store } = initialized();
    const quantityDefault = '1';
    const guessed = fields({
      quantity: {
        defaultValue: quantityDefault,
        defaultDigest: sha256Digest({ state: 'value', value: quantityDefault }),
      },
    });
    expectCode(() => store.createRevision(revision({ fields: guessed })), 'INVALID_INPUT');
    expect(store.verifyAudit()).toMatchObject({ valid: true, recordCount: 1 });
    store.close();
  });

  it('requires every proposed value to be an exact sourced or overridden value', () => {
    const { store } = initialized();
    const fabricated = 'Invented listing title';
    const unsafe = fields({
      title: {
        proposedValue: fabricated,
        proposedDigest: sha256Digest({ state: 'value', value: fabricated }),
      },
    });
    expectCode(() => store.createRevision(revision({ fields: unsafe })), 'INVALID_INPUT');
    expect(store.verifyAudit()).toMatchObject({ valid: true, recordCount: 1 });
    store.close();
  });

  it('does not allow createRevision to assert review or stale truth', () => {
    const { store } = initialized();
    expectCode(() => store.createRevision(revision({ state: 'reviewed' })), 'INVALID_INPUT');
    expectCode(() => store.createRevision(revision({ state: 'stale' })), 'INVALID_INPUT');
    expect(store.verifyAudit()).toMatchObject({ valid: true, recordCount: 1 });
    store.close();
  });

  it('derives observation digests and allows append-only identity evolution for one variant', () => {
    const { store } = initialized();
    const first = store.createRevision(revision({
      identity: {
        ...revision().identity,
        managementModel: 'unknown',
        ebayInventorySku: null,
        ebayOfferId: null,
        ebayListingId: null,
      },
    }));
    const next = revision({
      revisionId: 'revision-2',
      auditEventId: 'revision-created-2',
      createdAtUtc: '2026-08-13T20:00:03.000Z',
      expectedPreviousRevisionDigest: first.revisionDigest,
      expectedLatestBaseSourceDigest: first.baseSourceDigest,
      expectedLatestBaseEbayObservationDigest: first.baseEbayObservationDigest,
    });
    const second = store.createRevision(next);
    expect(second.subjectKey).toBe(first.subjectKey);
    expect(second.identity.managementModel).toBe('inventory_api');
    expect(second.identity.ebayListingId).toBe('147502608418');
    expect(second.revisionNumber).toBe(2);

    expectCode(() => store.createRevision(revision({
      revisionId: 'bad-base',
      auditEventId: 'bad-base-event',
      baseSourceDigest: sha256Digest('caller-selected'),
    })), 'INVALID_INPUT');
    store.close();
  });

  it('rejects credential material anywhere in identity or actor input', () => {
    const { databasePath, store } = initialized();
    const sentinels = [
      'authorization=Bearer abcdefghijklmnopqrstuvwxyz',
      'shpat_1234567890abcdefghijklmnopqrstuvwxyz',
      'v^1.1#i^1#f^0#I^3#r^1#p^3#t^Ul41XzI6TOKEN',
      'v%5E1.1%23i%5E1%23f%5E0%23I%5E3%23t%5ETOKEN',
    ];
    for (const [index, sentinel] of sentinels.entries()) {
      expectCode(() => store.createRevision(revision({
        revisionId: `credential-${index}`,
        auditEventId: `credential-event-${index}`,
        actor: index === 0 ? sentinel : revision().actor,
        identity: index === 0
          ? revision().identity
          : { ...revision().identity, rawSku: `SKU-${sentinel}` },
      })), 'INVALID_INPUT');
    }
    store.close();
    const bytes = fs.readFileSync(databasePath);
    for (const sentinel of sentinels) {
      expect(bytes.includes(Buffer.from(sentinel, 'utf8'))).toBe(false);
    }
  });

  it('rejects catalog or trigger drift on reopen', () => {
    const { databasePath, store } = initialized();
    store.close();
    const raw = new Database(databasePath);
    raw.exec('DROP TRIGGER listing_revisions_deny_delete');
    raw.close();
    expectCode(() => openListingControlStore({ databasePath, expectedScope: scope }), 'SCHEMA_MISMATCH');
  });

  it('detects orphan subjects and timestamp-pair tampering', () => {
    const { databasePath, store } = initialized();
    store.createRevision(revision());
    store.close();

    const raw = new Database(databasePath);
    const orphanKey = sha256Digest('orphan-subject');
    expect(() => raw.prepare(
      `INSERT INTO listing_subjects (
         subject_key, scope_key, shopify_product_gid, shopify_variant_gid,
         created_at_utc, created_epoch_ms
       ) SELECT ?, scope_key, ?, ?, created_at_utc, created_epoch_ms FROM control_scope`,
    ).run(
      orphanKey,
      'gid://shopify/Product/9998',
      'gid://shopify/ProductVariant/9999',
    )).not.toThrow();
    raw.close();
    expectCode(() => openListingControlStore({ databasePath, expectedScope: scope }), 'SCHEMA_MISMATCH');
  });

  it('detects timestamp epoch tampering even with the canonical trigger restored', () => {
    const { databasePath, store } = initialized();
    store.createRevision(revision());
    store.close();

    const raw = new Database(databasePath);
    const trigger = raw.prepare(
      "SELECT sql FROM sqlite_schema WHERE type = 'trigger' AND name = 'listing_revisions_deny_update'",
    ).get() as { sql: string };
    raw.exec('DROP TRIGGER listing_revisions_deny_update');
    raw.pragma('ignore_check_constraints = ON');
    raw.prepare(
      "UPDATE listing_revisions SET created_epoch_ms = created_epoch_ms + 1 WHERE revision_id = 'revision-1'",
    ).run();
    raw.pragma('ignore_check_constraints = OFF');
    raw.exec(trigger.sql);
    raw.close();

    expectCode(() => openListingControlStore({ databasePath, expectedScope: scope }), 'SCHEMA_MISMATCH');
  });
});
