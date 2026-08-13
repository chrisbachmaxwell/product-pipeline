import { describe, expect, it } from 'vitest';
import {
  PRODUCTION_CAN3570_LISTING_EVIDENCE,
  PRODUCTION_CAN3570_LISTING_EVIDENCE_BODY,
  PRODUCTION_CAN3570_LISTING_EVIDENCE_EXPECTED_DIGEST,
} from './evidence/production-can3570-authoritative-listing.v1.js';
import {
  digestAuthoritativeListingEvidence,
  readAuthoritativeListingsPage,
  verifyAuthoritativeListingEvidence,
} from './authoritative-listings-reader.js';

function cloneEvidence(): Record<string, any> {
  return JSON.parse(JSON.stringify(PRODUCTION_CAN3570_LISTING_EVIDENCE));
}

describe('authoritative listing evidence projection', () => {
  it('projects the exact verified Canon public listing without a request-time remote read', () => {
    const result = readAuthoritativeListingsPage({ limit: 50, offset: 0 });
    expect(result).toEqual({
      schemaVersion: 1,
      data: [{
        id: 'production:EBAY_US:CAN3570-U119',
        shopify: {
          productId: 'gid://shopify/Product/10310708035875',
          variantId: 'gid://shopify/ProductVariant/55396000563491',
          sku: 'CAN3570-U119',
          title: 'Canon 35-70mm f/3.5-4.5 (#119) *USED*',
          primaryImageUrl: 'https://cdn.shopify.com/s/files/1/0862/5451/8563/files/canon35-70-002Front-JPEG-1.jpg',
          imageCount: 6,
        },
        ebay: {
          listingId: '147502608418',
          offerId: '234942877011',
          url: 'https://www.ebay.com/itm/147502608418',
        },
        price: { amount: '39.95', currency: 'USD' },
        lifecycleStatus: 'active',
        lastVerifiedAtUtc: '2026-08-13T16:43:19.281Z',
        audit: {
          verified: true,
          evidenceState: 'verified',
          unresolvedCount: 0,
          recoverySupported: true,
          currentRemoteStateVerified: false,
        },
      }],
      total: 1,
      limit: 50,
      offset: 0,
      source: 'production-listing-audit-ledger',
      evidenceKind: 'verified_snapshot',
      authoritative: false,
      remoteReadPerformed: false,
      externalWritesPerformed: 0,
    });
  });

  it('searches stable row ID, SKU, title, offer ID, and listing ID', () => {
    for (const search of [
      'production:EBAY_US:CAN3570-U119',
      'can3570-u119',
      'Canon 35-70mm',
      '234942877011',
      '147502608418',
    ]) {
      expect(readAuthoritativeListingsPage({ limit: 1, offset: 0, search }).total).toBe(1);
    }
    expect(readAuthoritativeListingsPage({ limit: 1, offset: 0, search: 'different' }).total).toBe(0);
  });

  it('supports all four lifecycle filters without inventing rows', () => {
    expect(readAuthoritativeListingsPage({ limit: 10, offset: 0, status: 'active' }).total).toBe(1);
    for (const status of ['attention', 'ready', 'ended'] as const) {
      expect(readAuthoritativeListingsPage({ limit: 10, offset: 0, status }).total).toBe(0);
    }
  });

  it('pins the asset digest and fails closed on every material tamper', () => {
    expect(digestAuthoritativeListingEvidence(PRODUCTION_CAN3570_LISTING_EVIDENCE_BODY))
      .toBe(PRODUCTION_CAN3570_LISTING_EVIDENCE_EXPECTED_DIGEST);
    expect(() => verifyAuthoritativeListingEvidence(PRODUCTION_CAN3570_LISTING_EVIDENCE))
      .not.toThrow();

    for (const mutate of [
      (value: Record<string, any>) => { value.listing.ebay.listingId = 'different'; },
      (value: Record<string, any>) => { value.listing.ebay.offerId = 'different'; },
      (value: Record<string, any>) => { value.source.sourceAuditHead = `sha256:${'0'.repeat(64)}`; },
      (value: Record<string, any>) => { value.source.publishedEffectProofDigest = `sha256:${'0'.repeat(64)}`; },
      (value: Record<string, any>) => { value.listing.audit.unresolvedCount = 1; },
      (value: Record<string, any>) => { value.accessToken = 'Bearer must-not-escape'; },
    ]) {
      const changed = cloneEvidence();
      mutate(changed);
      expect(() => readAuthoritativeListingsPage({
        limit: 10,
        offset: 0,
        evidence: changed,
      })).toThrow('Verified listing evidence is unavailable');
    }
  });

  it('contains no credential, seller, customer, description, or policy material', () => {
    const { redaction, ...projectedEvidence } = PRODUCTION_CAN3570_LISTING_EVIDENCE;
    expect(JSON.stringify(projectedEvidence)).not.toMatch(
      /access.?token|refresh.?token|authorization|sellerUser|buyerUsername|customerEmail|shipping.?address|listingDescription|policyId|merchantLocation|password|cookie|credential/i,
    );
    expect(redaction).toEqual({
      credentialMaterialPresent: false,
      sellerIdentifiersPresent: false,
      productDescriptionPresent: false,
      customerDataPresent: false,
    });
  });

});
