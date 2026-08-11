import { describe, expect, it } from 'vitest';
import {
  evaluateCanaryReadiness,
  type CanaryReadinessInput,
} from '../canary-readiness.js';

const digest = (character: string) => `sha256:${character.repeat(64)}`;

function validListingInput(): CanaryReadinessInput {
  return {
    targets: [{
      kind: 'listing', targetKey: 'listing-canary-1',
      shopifyStoreDomain: 'usedcameragear.myshopify.com',
      ebayEnvironment: 'production', ebaySellerAccount: 'usedcam-0', marketplaceId: 'EBAY_US',
      shopifyVariantGid: 'gid://shopify/ProductVariant/101', sku: 'TEST-SKU-1', ebayListingId: 'EBAY-LISTING-1',
    }],
    responsibilities: ['price'],
    evidence: {
      accepted: true, responsibility: 'price', targetKey: 'listing-canary-1',
      evidenceDigest: digest('a'), ownershipVersion: digest('f'),
      observationWindow: { startUtc: '2026-08-11T15:45:00.000Z', endUtc: '2026-08-11T15:59:00.000Z' },
      expectedBeforeDigest: digest('4'), expectedAfterDigest: digest('5'),
      acceptedAtUtc: '2026-08-11T16:00:00.000Z',
    },
    singleWriter: { incumbent: 'marketplace-connect', incumbentVerified: true, responsibility: 'price', targetKey: 'listing-canary-1', ownershipVersion: digest('f'), incumbentDisabledOrTransferredForScope: true, productPipelineSoleWriterForScope: true, proofDigest: digest('b') },
    approval: { approved: true, approvalId: 'approval-1', responsibility: 'price', targetKey: 'listing-canary-1', action: 'update-price', evidenceDigest: digest('a'), ownershipVersion: digest('f'), approvedAtUtc: '2026-08-11T16:01:00.000Z', expiresAtUtc: '2026-08-11T17:00:00.000Z', usedAtUtc: null },
    idempotency: { responsibility: 'price', targetKey: 'listing-canary-1', ownershipVersion: digest('f'), key: 'listing-price:EBAY-LISTING-1:12500', persisted: true, uniqueConstraintVerified: true, priorResult: 'absent' },
    audit: { targetKey: 'listing-canary-1', responsibility: 'price', ownershipVersion: digest('f'), auditDestination: 'local-append-only-canary-audit-v1', appendOnly: true, preflightRecorded: true, evidenceDigest: digest('c') },
    reconciliation: { targetKey: 'listing-canary-1', responsibility: 'price', ownershipVersion: digest('f'), preActionClean: true, postActionRequired: true, evidenceDigest: digest('d') },
    rollback: { targetKey: 'listing-canary-1', responsibility: 'price', ownershipVersion: digest('f'), documented: true, rehearsed: true, immediateDisableVerified: true, evidenceDigest: digest('e') },
    orderSafety: { applicable: false, ebayEnvironment: null, ebaySellerAccount: null, shopifyStoreDomain: null, ownershipVersion: null, persisted: false, immutable: false, evidenceDigest: null, cutoverWatermarkUtc: null, eventTimeField: null, sourceOrderCreatedAtUtc: null, historicalBackfill: false },
    nowUtc: '2026-08-11T16:05:00.000Z',
  };
}

function validOrderInput(): CanaryReadinessInput {
  const input = validListingInput();
  input.targets = [{
    kind: 'order', targetKey: 'order-canary-1', ebayOrderId: 'EBAY-ORDER-NEW',
    shopifyStoreDomain: 'usedcameragear.myshopify.com', ebayEnvironment: 'production',
    ebaySellerAccount: 'usedcam-0', marketplaceId: 'EBAY_US',
  }];
  input.responsibilities = ['orderImport'];
  input.evidence.responsibility = 'orderImport'; input.evidence.targetKey = 'order-canary-1';
  input.singleWriter.responsibility = 'orderImport'; input.singleWriter.targetKey = 'order-canary-1';
  input.approval.responsibility = 'orderImport'; input.approval.targetKey = 'order-canary-1'; input.approval.action = 'import-order';
  input.idempotency = { responsibility: 'orderImport', targetKey: 'order-canary-1', ownershipVersion: digest('f'), key: 'ebay-order:production:usedcam-0:EBAY-ORDER-NEW:usedcameragear.myshopify.com', persisted: true, uniqueConstraintVerified: true, priorResult: 'absent' };
  input.audit.targetKey = 'order-canary-1'; input.audit.responsibility = 'orderImport';
  input.reconciliation.targetKey = 'order-canary-1'; input.reconciliation.responsibility = 'orderImport';
  input.rollback.targetKey = 'order-canary-1'; input.rollback.responsibility = 'orderImport';
  input.orderSafety = { applicable: true, ebayEnvironment: 'production', ebaySellerAccount: 'usedcam-0', shopifyStoreDomain: 'usedcameragear.myshopify.com', ownershipVersion: digest('f'), persisted: true, immutable: true, evidenceDigest: digest('a'), cutoverWatermarkUtc: '2026-08-11T15:00:00.000Z', eventTimeField: 'creationDate', sourceOrderCreatedAtUtc: '2026-08-11T15:01:00.000Z', historicalBackfill: false };
  return input;
}

describe('future canary readiness evaluator', () => {
  it('can find a complete listing readiness packet while remaining unwired and unauthorized', () => {
    expect(evaluateCanaryReadiness(validListingInput())).toEqual({
      readyForSeparateAuthorization: true,
      externalWritesAllowed: false,
      canaryAuthorized: false,
      liveProof: false,
      productionParity: false,
      blockers: [],
    });
  });

  it('always denies the current null-watermark order canary', () => {
    const input = validOrderInput();
    input.orderSafety.cutoverWatermarkUtc = null;
    const result = evaluateCanaryReadiness(input);
    expect(result.readyForSeparateAuthorization).toBe(false);
    expect(result.blockers).toContain('orders.cutover-watermark-missing');
    expect(result.externalWritesAllowed).toBe(false);
    expect(result.canaryAuthorized).toBe(false);
  });

  it('requires exact one-target and one-responsibility scope', () => {
    const input = validListingInput();
    input.targets.push({ ...input.targets[0], targetKey: 'listing-canary-2' });
    input.responsibilities.push('inventory');
    expect(evaluateCanaryReadiness(input).blockers).toEqual(expect.arrayContaining([
      'scope.exactly-one-target-required', 'scope.exactly-one-responsibility-required',
    ]));
  });

  it('requires an exact listing store, environment, seller, and marketplace scope', () => {
    const input = validListingInput();
    const target = input.targets[0];
    if (target.kind !== 'listing') throw new Error('listing fixture expected');
    target.shopifyStoreDomain = 'not-a-shopify-store.example.com';
    target.ebayEnvironment = 'staging' as 'production';
    target.ebaySellerAccount = 'x';
    target.marketplaceId = 'EBAY_GB' as 'EBAY_US';
    expect(evaluateCanaryReadiness(input).blockers).toEqual(expect.arrayContaining([
      'target.shopify-store-invalid', 'target.ebay-environment-invalid',
      'target.ebay-seller-invalid', 'target.marketplace-invalid',
    ]));
  });

  it('requires accepted matching evidence and an unused, unexpired one-action approval', () => {
    const input = validListingInput();
    input.evidence.accepted = false;
    input.approval.evidenceDigest = digest('f');
    input.approval.usedAtUtc = '2026-08-11T16:04:00.000Z';
    input.approval.expiresAtUtc = '2026-08-11T16:04:00.000Z';
    expect(evaluateCanaryReadiness(input).blockers).toEqual(expect.arrayContaining([
      'evidence.not-accepted', 'approval.evidence-mismatch', 'approval.already-used', 'approval.expired',
    ]));
  });

  it('requires proof that Marketplace Connect is disabled only for the canary scope and ProductPipeline is sole writer', () => {
    const input = validListingInput();
    input.singleWriter.incumbentDisabledOrTransferredForScope = false;
    input.singleWriter.productPipelineSoleWriterForScope = false;
    expect(evaluateCanaryReadiness(input).blockers).toEqual(expect.arrayContaining([
      'single-writer.scoped-disable-or-transfer-proof-missing',
      'single-writer.product-pipeline-sole-writer-proof-missing',
    ]));
  });

  it('blocks an unverified incumbent even when scoped transfer flags are asserted', () => {
    const input = validListingInput();
    input.singleWriter.incumbent = 'unverified';
    input.singleWriter.incumbentVerified = false;
    expect(evaluateCanaryReadiness(input).blockers).toEqual(expect.arrayContaining([
      'single-writer.incumbent-unverified', 'single-writer.incumbent-verification-missing',
    ]));
  });

  it('binds accepted evidence, single-writer proof, approval, and idempotency to one ownership version', () => {
    const input = validListingInput();
    input.singleWriter.ownershipVersion = digest('1');
    input.approval.ownershipVersion = digest('2');
    input.idempotency.ownershipVersion = digest('3');
    expect(evaluateCanaryReadiness(input).blockers).toEqual(expect.arrayContaining([
      'single-writer.ownership-version-mismatch',
      'approval.ownership-version-mismatch',
      'idempotency.ownership-version-mismatch',
    ]));
  });

  it('requires a valid ordered observation window and distinct expected state digests', () => {
    const input = validListingInput();
    input.evidence.observationWindow.startUtc = '2026-08-11T16:02:00.000Z';
    input.evidence.observationWindow.endUtc = '2026-08-11T16:01:00.000Z';
    input.evidence.expectedAfterDigest = input.evidence.expectedBeforeDigest;
    expect(evaluateCanaryReadiness(input).blockers).toEqual(expect.arrayContaining([
      'evidence.observation-window-reversed',
      'evidence.observation-after-acceptance',
      'evidence.expected-state-not-distinct',
    ]));
  });

  it('enforces acceptedAt <= approvedAt <= now < expires', () => {
    const acceptedAfterApproval = validListingInput();
    acceptedAfterApproval.evidence.acceptedAtUtc = '2026-08-11T16:02:00.000Z';
    expect(evaluateCanaryReadiness(acceptedAfterApproval).blockers).toContain('approval.precedes-evidence-acceptance');

    const approvalAfterNow = validListingInput();
    approvalAfterNow.approval.approvedAtUtc = '2026-08-11T16:06:00.000Z';
    expect(evaluateCanaryReadiness(approvalAfterNow).blockers).toContain('approval.in-future');

    const nowAtExpiry = validListingInput();
    nowAtExpiry.nowUtc = nowAtExpiry.approval.expiresAtUtc;
    expect(evaluateCanaryReadiness(nowAtExpiry).blockers).toContain('approval.expired');
  });

  it('requires persistent unique idempotency plus audit, reconciliation, and rollback gates', () => {
    const input = validListingInput();
    input.idempotency.persisted = false;
    input.idempotency.uniqueConstraintVerified = false;
    input.audit.appendOnly = false;
    input.reconciliation.postActionRequired = false;
    input.rollback.rehearsed = false;
    expect(evaluateCanaryReadiness(input).blockers).toEqual(expect.arrayContaining([
      'idempotency.not-persisted', 'idempotency.unique-constraint-unverified',
      'audit.append-only-unverified', 'reconciliation.post-action-not-required', 'rollback.not-rehearsed',
    ]));
  });

  it('binds audit, reconciliation, and rollback evidence to the exact target, responsibility, and ownership version', () => {
    const input = validListingInput();
    input.audit.targetKey = 'different-target';
    input.audit.auditDestination = 'unsafe-destination' as 'local-append-only-canary-audit-v1';
    input.reconciliation.responsibility = 'inventory';
    input.rollback.ownershipVersion = digest('1');
    expect(evaluateCanaryReadiness(input).blockers).toEqual(expect.arrayContaining([
      'audit.target-mismatch', 'audit.destination-invalid',
      'reconciliation.responsibility-mismatch', 'rollback.ownership-version-mismatch',
    ]));
  });

  it('requires the approval action to match the selected responsibility and target kind', () => {
    const input = validListingInput();
    input.approval.action = 'update-inventory';
    expect(evaluateCanaryReadiness(input).blockers).toContain('approval.action-responsibility-mismatch');
  });

  it('permits a null eBay listing ID only for listingCreate', () => {
    const create = validListingInput();
    const createTarget = create.targets[0];
    if (createTarget.kind !== 'listing') throw new Error('listing fixture expected');
    createTarget.ebayListingId = null;
    create.responsibilities = ['listingCreate'];
    create.evidence.responsibility = 'listingCreate';
    create.singleWriter.responsibility = 'listingCreate';
    create.approval.responsibility = 'listingCreate'; create.approval.action = 'create-listing';
    create.idempotency.responsibility = 'listingCreate';
    create.audit.responsibility = 'listingCreate';
    create.reconciliation.responsibility = 'listingCreate';
    create.rollback.responsibility = 'listingCreate';
    expect(evaluateCanaryReadiness(create).readyForSeparateAuthorization).toBe(true);

    const revise = validListingInput();
    const reviseTarget = revise.targets[0];
    if (reviseTarget.kind !== 'listing') throw new Error('listing fixture expected');
    reviseTarget.ebayListingId = null;
    expect(evaluateCanaryReadiness(revise).blockers).toContain('target.ebay-listing-required');
  });

  it('rejects orders at/before the watermark or with a non-external-id idempotency key', () => {
    const input = validOrderInput();
    input.orderSafety.sourceOrderCreatedAtUtc = input.orderSafety.cutoverWatermarkUtc;
    input.idempotency.key = 'generic-operation-1';
    expect(evaluateCanaryReadiness(input).blockers).toEqual(expect.arrayContaining([
      'orders.source-not-after-cutover-watermark', 'orders.account-scoped-idempotency-key-mismatch',
    ]));
  });

  it('rejects replaying an order idempotency key into another seller account', () => {
    const input = validOrderInput();
    const target = input.targets[0];
    if (target.kind !== 'order') throw new Error('order fixture expected');
    target.ebaySellerAccount = 'other-seller';
    expect(evaluateCanaryReadiness(input).blockers).toContain('orders.account-scoped-idempotency-key-mismatch');
  });

  it('requires immutable persisted watermark evidence bound to the exact account and ownership version', () => {
    const input = validOrderInput();
    input.orderSafety.persisted = false;
    input.orderSafety.immutable = false;
    input.orderSafety.ebayEnvironment = 'sandbox';
    input.orderSafety.ebaySellerAccount = 'other-seller';
    input.orderSafety.shopifyStoreDomain = 'other-store.myshopify.com';
    input.orderSafety.ownershipVersion = digest('1');
    input.orderSafety.evidenceDigest = digest('2');
    expect(evaluateCanaryReadiness(input).blockers).toEqual(expect.arrayContaining([
      'orders.watermark-not-persisted', 'orders.watermark-not-immutable',
      'orders.watermark-environment-mismatch', 'orders.watermark-seller-mismatch',
      'orders.watermark-store-mismatch', 'orders.watermark-ownership-version-mismatch',
      'orders.watermark-evidence-mismatch',
    ]));
  });

  it('blocks a future cutover watermark or future source-order creation time', () => {
    const input = validOrderInput();
    input.orderSafety.cutoverWatermarkUtc = '2026-08-11T16:06:00.000Z';
    input.orderSafety.sourceOrderCreatedAtUtc = '2026-08-11T16:07:00.000Z';
    expect(evaluateCanaryReadiness(input).blockers).toEqual(expect.arrayContaining([
      'orders.cutover-watermark-in-future', 'orders.source-created-time-in-future',
    ]));
  });

  it('can find a post-watermark order packet ready for separate authorization but never authorize it', () => {
    const result = evaluateCanaryReadiness(validOrderInput());
    expect(result.readyForSeparateAuthorization).toBe(true);
    expect(result.externalWritesAllowed).toBe(false);
    expect(result.canaryAuthorized).toBe(false);
  });
});
