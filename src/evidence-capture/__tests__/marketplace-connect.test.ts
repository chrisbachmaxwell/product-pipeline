import {
  createHash,
  createPrivateKey,
  sign,
} from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  canonicalizeMarketplaceConnectPayload,
  verifyMarketplaceConnectAttestation,
  type Digest,
  type MarketplaceConnectAttestationPacket,
  type MarketplaceConnectAttestationPayload,
  type MarketplaceConnectDetachedSignature,
  type MarketplaceConnectTrust,
} from '../marketplace-connect.js';

const COLLECTOR_PRIVATE_KEY =
  'MC4CAQAwBQYDK2VwBCIEIFy4K6lyZUn/2ZssokmVXIHjSrdFXTxf/p6XYw0lwkx7';
const COLLECTOR_PUBLIC_KEY =
  'MCowBQYDK2VwAyEA9k/VdDM+2mAbEygTPW4qowe4sWmnv9Gjpum2WDBzeM0=';
const REVIEWER_PRIVATE_KEY =
  'MC4CAQAwBQYDK2VwBCIEIDhgpoURdovJUUGNKSR5KBI7w/9YUakFTmmbwLV1FwOQ';
const REVIEWER_PUBLIC_KEY =
  'MCowBQYDK2VwAyEAEk09B9GehQK+ADnr+p5NRT44EipesOKmg6mj3aOR2fc=';

const digest = (value: string | Buffer): Digest =>
  `sha256:${createHash('sha256').update(value).digest('hex')}`;
const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value === 'boolean' || typeof value === 'string' || typeof value === 'number') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
};
const evidenceId = (value: string): string => `evidence:${digest(value)}`;
const unknownId = (value: string): string => `unknown:${digest(value)}`;

const ACCOUNT_EVIDENCE_ID = evidenceId('account-settings');
const ORDER_EVIDENCE_ID = evidenceId('order-import-settings');
const LISTING_EVIDENCE_ID = evidenceId('listing-grid');
const ORDER_ATTRIBUTION_EVIDENCE_ID = evidenceId('shopify-order-attribution');

const collectorSignerId = digest('operator:collector:opaque-id');
const reviewerSignerId = digest('operator:reviewer:opaque-id');
const collectorKeyId = digest(Buffer.from(COLLECTOR_PUBLIC_KEY, 'base64'));
const reviewerKeyId = digest(Buffer.from(REVIEWER_PUBLIC_KEY, 'base64'));

const trust: MarketplaceConnectTrust = {
  collector: {
    signerId: collectorSignerId,
    keyId: collectorKeyId,
    publicKeySpkiBase64: COLLECTOR_PUBLIC_KEY,
  },
  reviewer: {
    signerId: reviewerSignerId,
    keyId: reviewerKeyId,
    publicKeySpkiBase64: REVIEWER_PUBLIC_KEY,
  },
  expectedSubject: {
    shopifyStoreDomainDigest: digest('usedcameragear.myshopify.com'),
    ebayEnvironment: 'production',
    ebaySellerAccountDigest: digest('usedcam-0'),
    ebayMarketplaceId: 'EBAY_US',
  },
  verifiedAtUtc: '2026-08-11T20:05:00.000Z',
};

function validPayload(): MarketplaceConnectAttestationPayload {
  const listingRecords: MarketplaceConnectAttestationPayload['listingCoverage']['records'] = [
    {
      recordKey: digest('listing-record-1'),
      shopifyProductDigest: digest('shopify-product-1'),
      ebayListingDigest: digest('ebay-listing-1'),
      skuDigest: digest('sku-1'),
      linkStatus: 'linked',
      fieldOwners: {
        shipping: 'ebay',
        returns: 'ebay',
        title: 'marketplace-connect',
        description: 'marketplace-connect',
        priceTaxes: 'marketplace-connect',
      },
      evidenceIds: [LISTING_EVIDENCE_ID],
    },
  ];
  return {
    subject: {
      shopifyStoreDomainDigest: digest('usedcameragear.myshopify.com'),
      ebayEnvironment: 'production',
      ebaySellerAccountDigest: digest('usedcam-0'),
      ebayMarketplaceId: 'EBAY_US',
    },
    capture: {
      capturedAtUtc: '2026-08-11T20:00:00.000Z',
      method: 'operator-ui',
      completeness: 'partial',
    },
    settings: {
      connection: 'connected',
      orderImport: {
        productScope: 'all-orders',
        fulfillmentScope: 'all-orders',
        importWhen: 'complete',
      },
      priceSync: 'enabled',
      inventorySync: 'enabled',
      autoListProducts: 'disabled',
      autoCategorization: 'enabled',
      inventoryLocation: {
        mode: 'all-locations',
        locationSetDigest: null,
      },
    },
    listingCoverage: {
      status: 'partial',
      normalizedRecordCount: 1,
      terminalPageObserved: false,
      terminalPageDigest: null,
      datasetDigest: digest(canonicalJson(listingRecords)),
      records: listingRecords,
    },
    evidenceAttachments: [
      {
        evidenceId: ACCOUNT_EVIDENCE_ID,
        surface: 'account-settings',
        capturedAtUtc: '2026-08-11T19:58:00.000Z',
        contentDigest: digest('redacted-account-settings-image'),
        redacted: true,
      },
      {
        evidenceId: ORDER_EVIDENCE_ID,
        surface: 'order-import-settings',
        capturedAtUtc: '2026-08-11T19:59:00.000Z',
        contentDigest: digest('redacted-order-settings-image'),
        redacted: true,
      },
      {
        evidenceId: LISTING_EVIDENCE_ID,
        surface: 'listing-grid',
        capturedAtUtc: '2026-08-11T20:00:00.000Z',
        contentDigest: digest('redacted-listing-grid-image'),
        redacted: true,
      },
      {
        evidenceId: ORDER_ATTRIBUTION_EVIDENCE_ID,
        surface: 'shopify-order-attribution',
        capturedAtUtc: '2026-08-11T20:00:00.000Z',
        contentDigest: digest('redacted-order-attribution'),
        redacted: true,
      },
    ],
    claims: [
      {
        responsibility: 'orderImport',
        assertedOwner: 'marketplace_connect',
        evidenceClass: 'operator-attested-ui',
        evidenceIds: [ORDER_EVIDENCE_ID, ORDER_ATTRIBUTION_EVIDENCE_ID],
      },
      {
        responsibility: 'price',
        assertedOwner: 'unverified',
        evidenceClass: 'operator-attested-ui',
        evidenceIds: [ACCOUNT_EVIDENCE_ID],
      },
      {
        responsibility: 'inventory',
        assertedOwner: 'unverified',
        evidenceClass: 'operator-attested-ui',
        evidenceIds: [ACCOUNT_EVIDENCE_ID],
      },
    ],
    unknowns: [
      {
        unknownId: unknownId('listing-writer-coverage'),
        responsibility: 'listingRevise',
        detailsDigest: digest('recent listing writer coverage remains unknown'),
        evidenceIds: [LISTING_EVIDENCE_ID],
      },
    ],
    limitations: {
      evidenceOnly: true,
      ownershipTransferAuthorized: false,
      liveParityProven: false,
      externalWritesObserved: 0,
      historicalBackfill: false,
    },
  };
}

function detachedSignature(
  role: 'collector' | 'reviewer',
  payload: MarketplaceConnectAttestationPayload,
): MarketplaceConnectDetachedSignature {
  const collector = role === 'collector';
  const privateKey = createPrivateKey({
    key: Buffer.from(collector ? COLLECTOR_PRIVATE_KEY : REVIEWER_PRIVATE_KEY, 'base64'),
    format: 'der',
    type: 'pkcs8',
  });
  const canonicalPayload = canonicalizeMarketplaceConnectPayload(payload);
  return {
    role,
    signerId: collector ? collectorSignerId : reviewerSignerId,
    keyId: collector ? collectorKeyId : reviewerKeyId,
    algorithm: 'Ed25519',
    signatureBase64: sign(null, Buffer.from(canonicalPayload, 'utf8'), privateKey).toString('base64'),
  };
}

function signedPacket(
  payload: MarketplaceConnectAttestationPayload = validPayload(),
): MarketplaceConnectAttestationPacket {
  return {
    schemaVersion: 1,
    kind: 'marketplace-connect-readonly-attestation',
    payload,
    signatures: [
      detachedSignature('collector', payload),
      detachedSignature('reviewer', payload),
    ],
  };
}

describe('Marketplace Connect signed read-only evidence', () => {
  it('verifies two deterministic detached signatures but remains non-authorizing', () => {
    const payload = validPayload();
    const first = signedPacket(payload);
    const second = signedPacket(payload);
    expect(first.signatures).toEqual(second.signatures);

    const result = verifyMarketplaceConnectAttestation(first, trust);
    expect(result.verification).toEqual({
      collectorSignatureVerified: true,
      reviewerSignatureVerified: true,
    });
    expect(result.classification).toEqual({
      evidenceOnly: true,
      ownershipTransferAuthorized: false,
      liveParityProven: false,
      externalWritesAllowed: false,
      historicalBackfillAllowed: false,
    });
    expect(result.payloadDigest).toBe(digest(canonicalizeMarketplaceConnectPayload(payload)));
  });

  it('rejects a payload changed after signing', () => {
    const packet = signedPacket();
    packet.payload.settings.autoCategorization = 'disabled';
    expect(() => verifyMarketplaceConnectAttestation(packet, trust)).toThrow(
      /collector detached signature verification failed/,
    );
  });

  it('rejects unknown keys and customer, raw-order, secret, or URL-shaped material', () => {
    const unknownKey = structuredClone(validPayload()) as MarketplaceConnectAttestationPayload & {
      extra?: boolean;
    };
    unknownKey.extra = true;
    expect(() => canonicalizeMarketplaceConnectPayload(unknownKey)).toThrow(/extra is not supported/);

    const customerField = structuredClone(validPayload()) as unknown as Record<string, unknown>;
    (customerField.listingCoverage as Record<string, unknown>).customerEmail = 'redacted';
    expect(() => canonicalizeMarketplaceConnectPayload(customerField)).toThrow(/forbidden secret, PII/);

    const rawOrder = structuredClone(validPayload()) as unknown as Record<string, unknown>;
    (rawOrder.settings as Record<string, unknown>).rawOrder = { id: 'opaque' };
    expect(() => canonicalizeMarketplaceConnectPayload(rawOrder)).toThrow(/forbidden secret, PII/);

    const urlValue = structuredClone(validPayload());
    urlValue.unknowns[0].detailsDigest = 'https://admin.shopify.com/private' as Digest;
    expect(() => canonicalizeMarketplaceConnectPayload(urlValue)).toThrow(/forbidden URL or URI/);
  });

  it('requires canonical UTC and a four-hour bounded capture session', () => {
    const noncanonical = validPayload();
    noncanonical.capture.capturedAtUtc = '2026-08-11T20:00:00Z';
    expect(() => canonicalizeMarketplaceConnectPayload(noncanonical)).toThrow(/canonical UTC/);

    const oldAttachment = validPayload();
    oldAttachment.evidenceAttachments[0].capturedAtUtc = '2026-08-11T15:59:59.999Z';
    expect(() => canonicalizeMarketplaceConnectPayload(oldAttachment)).toThrow(
      /outside the bounded capture session/,
    );
  });

  it('requires terminal and dataset proof for complete listing coverage', () => {
    const payload = validPayload();
    payload.capture.completeness = 'complete';
    payload.listingCoverage.status = 'complete';
    expect(() => canonicalizeMarketplaceConnectPayload(payload)).toThrow(
      /complete listing coverage requires terminal and dataset digests/,
    );

    payload.listingCoverage.terminalPageObserved = true;
    payload.listingCoverage.terminalPageDigest = digest('redacted-listing-grid-image');
    expect(() => canonicalizeMarketplaceConnectPayload(payload)).not.toThrow();
  });

  it('recomputes listing datasets and binds terminal proof to retained evidence', () => {
    const mismatchedDataset = validPayload();
    mismatchedDataset.listingCoverage.datasetDigest = digest('arbitrary-dataset');
    expect(() => canonicalizeMarketplaceConnectPayload(mismatchedDataset)).toThrow(
      /dataset digest does not match/,
    );

    const unboundTerminal = validPayload();
    unboundTerminal.capture.completeness = 'complete';
    unboundTerminal.listingCoverage.status = 'complete';
    unboundTerminal.listingCoverage.terminalPageObserved = true;
    unboundTerminal.listingCoverage.terminalPageDigest = digest('unbound-terminal');
    expect(() => canonicalizeMarketplaceConnectPayload(unboundTerminal)).toThrow(
      /terminal digest is not bound/,
    );
  });

  it('rejects mismatched counts, duplicate records, and unavailable observations', () => {
    const countMismatch = validPayload();
    countMismatch.listingCoverage.normalizedRecordCount = 0;
    expect(() => canonicalizeMarketplaceConnectPayload(countMismatch)).toThrow(/record count/);

    const duplicate = validPayload();
    duplicate.listingCoverage.records.push(structuredClone(duplicate.listingCoverage.records[0]));
    duplicate.listingCoverage.normalizedRecordCount = 2;
    expect(() => canonicalizeMarketplaceConnectPayload(duplicate)).toThrow(/duplicate record keys/);

    const unavailable = validPayload();
    unavailable.listingCoverage.status = 'unavailable';
    expect(() => canonicalizeMarketplaceConnectPayload(unavailable)).toThrow(
      /unavailable listing coverage cannot contain observations/,
    );
  });

  it('binds every listing, claim, unknown, and attachment to known evidence IDs', () => {
    const missing = validPayload();
    missing.claims[0].evidenceIds = [evidenceId('missing')];
    expect(() => canonicalizeMarketplaceConnectPayload(missing)).toThrow(/references missing evidence/);

    const orphan = validPayload();
    orphan.evidenceAttachments.push({
      evidenceId: evidenceId('orphan'),
      surface: 'mapping',
      capturedAtUtc: orphan.capture.capturedAtUtc,
      contentDigest: digest('orphan'),
      redacted: true,
    });
    expect(() => canonicalizeMarketplaceConnectPayload(orphan)).toThrow(/unbound evidence/);
  });

  it('allows incumbent claims only for evidenced order, price, and inventory settings', () => {
    const listingOwner = validPayload();
    listingOwner.claims.push({
      responsibility: 'listingRevise',
      assertedOwner: 'marketplace_connect',
      evidenceClass: 'operator-attested-ui',
      evidenceIds: [LISTING_EVIDENCE_ID],
    });
    expect(() => canonicalizeMarketplaceConnectPayload(listingOwner)).toThrow(
      /cannot infer listing or operational ownership/,
    );

    const uiPriceOwner = validPayload();
    uiPriceOwner.claims[1].assertedOwner = 'marketplace_connect';
    expect(() => canonicalizeMarketplaceConnectPayload(uiPriceOwner)).toThrow(
      /cannot infer price ownership from UI settings alone/,
    );

    const missingAttribution = validPayload();
    missingAttribution.claims[0].evidenceIds = [ORDER_EVIDENCE_ID];
    missingAttribution.evidenceAttachments = missingAttribution.evidenceAttachments.filter(
      (entry) => entry.evidenceId !== ORDER_ATTRIBUTION_EVIDENCE_ID,
    );
    expect(() => canonicalizeMarketplaceConnectPayload(missingAttribution)).toThrow(
      /lacks enabled settings and order-attribution evidence/,
    );
  });

  it('requires explicit limitations and at least one retained unknown', () => {
    const noUnknowns = validPayload();
    noUnknowns.unknowns = [];
    expect(() => canonicalizeMarketplaceConnectPayload(noUnknowns)).toThrow(
      /explicitly retain at least one evidence limitation/,
    );

    const authorizing = validPayload() as unknown as Record<string, unknown>;
    (authorizing.limitations as Record<string, unknown>).ownershipTransferAuthorized = true;
    expect(() => canonicalizeMarketplaceConnectPayload(authorizing)).toThrow(/fail-closed literal/);
  });

  it('requires independent trusted collector and reviewer keys', () => {
    const sameTrust: MarketplaceConnectTrust = {
      ...trust,
      collector: trust.collector,
      reviewer: trust.collector,
    };
    expect(() => verifyMarketplaceConnectAttestation(signedPacket(), sameTrust)).toThrow(
      /trusted collector and reviewer must be independent/,
    );

    const wrongReviewerTrust: MarketplaceConnectTrust = {
      ...trust,
      collector: trust.collector,
      reviewer: { ...trust.reviewer, signerId: digest('wrong-reviewer') },
    };
    expect(() => verifyMarketplaceConnectAttestation(signedPacket(), wrongReviewerTrust)).toThrow(
      /reviewer signature does not match the trusted signer/,
    );
  });

  it('binds verification to the exact trusted subject and a fresh capture', () => {
    expect(() => verifyMarketplaceConnectAttestation(signedPacket(), {
      ...trust,
      expectedSubject: { ...trust.expectedSubject, ebayEnvironment: 'sandbox' },
    })).toThrow(/subject or freshness/);
    expect(() => verifyMarketplaceConnectAttestation(signedPacket(), {
      ...trust,
      verifiedAtUtc: '2026-08-12T00:00:00.001Z',
    })).toThrow(/subject or freshness/);
    expect(() => verifyMarketplaceConnectAttestation(signedPacket(), {
      ...trust,
      verifiedAtUtc: '2026-08-11T19:59:59.999Z',
    })).toThrow(/subject or freshness/);
  });

  it('rejects noncanonical, truncated, or self-declared signatures', () => {
    const truncated = signedPacket();
    truncated.signatures[0].signatureBase64 = Buffer.alloc(32).toString('base64');
    expect(() => verifyMarketplaceConnectAttestation(truncated, trust)).toThrow(
      /expected byte length/,
    );

    const selfDeclared = signedPacket();
    selfDeclared.signatures[0].keyId = digest('untrusted-key');
    expect(() => verifyMarketplaceConnectAttestation(selfDeclared, trust)).toThrow(
      /does not match the trusted signer/,
    );
  });
});
