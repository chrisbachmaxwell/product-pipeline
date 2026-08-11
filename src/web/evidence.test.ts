import { describe, expect, it } from 'vitest';
import {
  booleanPolicyState,
  normalizeEvidenceSources,
  normalizeResponsibilityEvidence,
  RESPONSIBILITY_KEYS,
} from './evidence';
import type { MigrationStatusResponse } from './hooks/useApi';

describe('read-only evidence projection', () => {
  it('fails closed for missing sources and never substitutes response times for capture time', () => {
    const status: MigrationStatusResponse = {
      servedAt: '2026-08-11T20:00:00.000Z',
      observedAt: '2026-08-11T19:59:59.000Z',
      reconciliation: {
        generatedAt: '2026-08-11T19:59:58.000Z',
        counts: { listingMappings: 12 },
      },
    };

    const sources = normalizeEvidenceSources(status);
    const local = sources.find((source) => source.key === 'productPipeline');
    const shopify = sources.find((source) => source.key === 'shopify');
    const ebay = sources.find((source) => source.key === 'ebay');
    const marketplaceConnect = sources.find((source) => source.key === 'marketplaceConnect');

    expect(sources).toHaveLength(4);
    expect(local).toMatchObject({
      evidenceClass: 'local-ledger-observation',
      status: 'partial',
      capturedAt: null,
      critical: true,
      counts: { listingMappings: 12 },
    });
    expect(shopify).toMatchObject({ status: 'unavailable', capturedAt: null, critical: true });
    expect(ebay).toMatchObject({ status: 'unavailable', capturedAt: null, critical: true });
    expect(marketplaceConnect).toMatchObject({
      evidenceClass: 'operator-attested-browser-observation',
      status: 'partial',
      freshness: 'stale',
      capturedAt: '2026-08-11',
      critical: true,
    });
    expect(sources.map((source) => source.capturedAt)).not.toContain(status.servedAt);
    expect(sources.map((source) => source.capturedAt)).not.toContain(status.observedAt);
    expect(sources.map((source) => source.capturedAt)).not.toContain(status.reconciliation?.generatedAt);
  });

  it('accepts additive, redacted source evidence while filtering unsafe fields', () => {
    const digest = `sha256:${'a'.repeat(64)}`;
    const [shopify] = normalizeEvidenceSources({
      evidence: [
        {
          source: 'shopify',
          evidenceClass: 'authoritative-direct-read',
          status: 'complete',
          completeness: { status: 'complete' },
          freshness: 'fresh',
          capturedAtUtc: '2026-08-11T18:00:00.000Z',
          recordCount: 20,
          counts: {
            products: 20,
            customerEmails: 10,
            credentialCount: 2,
          },
          normalizedPayloadDigest: digest,
          limitations: [
            'Current catalog window only.',
            'customer email secret must never render',
            'jane@example.com',
            'Evidence note Bearer abcdefghijklmnopqrstuvwxyz',
          ],
        },
      ],
    }).filter((source) => source.key === 'shopify');

    expect(shopify).toMatchObject({
      status: 'complete',
      completeness: 'complete',
      freshness: 'fresh',
      capturedAt: '2026-08-11T18:00:00.000Z',
      recordCount: 20,
      digest,
      critical: false,
      counts: { products: 20 },
      limitations: ['Current catalog window only.'],
    });
  });

  it('treats partial or stale supplied evidence as critical', () => {
    const ebay = normalizeEvidenceSources({
      evidence: {
        sources: {
          ebay: {
            status: 'complete',
            completeness: 'partial',
            freshness: 'fresh',
            digest: 'not-a-valid-digest',
          },
        },
      },
    }).find((source) => source.key === 'ebay');

    expect(ebay).toMatchObject({ critical: true, digest: null, completeness: 'partial' });
  });

  it('projects only allowlisted provenance metadata from a strict snapshot bundle', () => {
    const digest = `sha256:${'b'.repeat(64)}`;
    const ebay = normalizeEvidenceSources({
      evidence: {
        sources: {
          ebay: {
            provenance: {
              availability: 'complete',
              method: 'direct-api-read',
              attestation: 'runtime-observed',
              capturedAtUtc: '2026-08-11T18:05:00.000Z',
              asOfStartUtc: '2026-08-11T17:00:00.000Z',
              asOfEndUtc: '2026-08-11T18:00:00.000Z',
              paginationComplete: true,
              recordCount: 8,
              datasetDigest: digest,
              subject: { ebaySellerAccount: 'must-not-render' },
            },
            data: { orders: [{ ebayOrderId: 'must-not-render' }] },
          },
        },
      },
    }).find((source) => source.key === 'ebay');

    expect(ebay).toMatchObject({
      evidenceClass: 'direct-api-read',
      status: 'complete',
      completeness: 'complete',
      freshness: 'unavailable',
      capturedAt: '2026-08-11T18:05:00.000Z',
      asOfStart: '2026-08-11T17:00:00.000Z',
      asOfEnd: '2026-08-11T18:00:00.000Z',
      recordCount: 8,
      digest,
      critical: true,
    });
    expect(JSON.stringify(ebay)).not.toContain('must-not-render');
  });

  it('preserves the date-only Marketplace Connect baseline from the status projection', () => {
    const marketplaceConnect = normalizeEvidenceSources({
      evidence: {
        sources: [
          {
            system: 'marketplace-connect',
            evidenceClass: 'operator-attested-browser-observation',
            status: 'partial',
            completeness: 'partial',
            freshness: 'unknown',
            capturedAtUtc: null,
            baselineDate: '2026-08-11',
            coverage: { complete: false, records: 3, pages: 1 },
          },
        ],
      },
    }).find((source) => source.key === 'marketplaceConnect');

    expect(marketplaceConnect).toMatchObject({
      capturedAt: '2026-08-11',
      recordCount: 3,
      status: 'partial',
      critical: true,
    });
  });

  it('keeps accepted policy separate from current responsibility evidence', () => {
    const responsibilities = normalizeResponsibilityEvidence({
      responsibilities: [
        {
          responsibility: 'orderImport',
          owner: 'marketplace-connect',
          productPipelineAccess: 'disabled',
          writesAllowed: false,
        },
      ],
      responsibilityEvidence: {
        listingRevise: {
          evidenceStatus: 'verified',
          observedOwner: 'marketplace-connect',
          capturedAtUtc: '2026-08-11T18:30:00.000Z',
          summary: 'Current redacted listing snapshot.',
        },
      },
    });

    expect(responsibilities.map((item) => item.responsibility)).toEqual([...RESPONSIBILITY_KEYS]);
    expect(responsibilities.find((item) => item.responsibility === 'orderImport')).toMatchObject({
      acceptedOwner: 'marketplace-connect',
      evidenceStatus: 'historical-baseline-only',
      capturedAt: '2026-08-11',
      critical: true,
    });
    expect(responsibilities.find((item) => item.responsibility === 'listingRevise')).toMatchObject({
      acceptedOwner: 'unverified',
      observedOwner: 'marketplace-connect',
      evidenceStatus: 'verified',
      critical: false,
    });
    for (const key of [
      'listingCreate',
      'listingEndRelist',
      'mapping',
      'fulfillment',
      'feedback',
      'reconciliation',
    ] as const) {
      expect(responsibilities.find((item) => item.responsibility === key)).toMatchObject({
        acceptedOwner: 'unverified',
        evidenceStatus: 'unverified',
        observedOwner: null,
        capturedAt: null,
        critical: true,
      });
    }
  });

  it('marks missing booleans unavailable and critical', () => {
    expect(booleanPolicyState(undefined, { safe: 'Blocked', unsafe: 'Allowed' })).toEqual({
      label: 'Unavailable',
      tone: 'critical',
    });
    expect(booleanPolicyState(false, { safe: 'Blocked', unsafe: 'Allowed' })).toEqual({
      label: 'Blocked',
      tone: 'success',
    });
    expect(booleanPolicyState(true, { safe: 'Blocked', unsafe: 'Allowed' })).toEqual({
      label: 'Allowed',
      tone: 'critical',
    });
  });
});
