/**
 * Credential-free, deployable projection of the strictly verified first
 * Production listing canary. This is a versioned evidence snapshot, not a
 * platform reader and not a mutation authority.
 *
 * The values were extracted from the canonical store only after
 * `verifyProductionListingStoreDatabaseForRecovery` accepted its schema,
 * operational graph, and hash-chained audit. Public product/listing IDs and
 * Shopify CDN image URLs are intentionally retained; seller identity, OAuth,
 * descriptions, policy/location IDs, and request/response bodies are absent.
 */

export const PRODUCTION_CAN3570_LISTING_EVIDENCE_BODY = Object.freeze({
  schemaVersion: 1 as const,
  kind: 'product-pipeline-authoritative-listing-verified-snapshot' as const,
  evidenceKind: 'verified_snapshot' as const,
  source: Object.freeze({
    kind: 'production-listing-audit-ledger' as const,
    strictVerifier: 'production-listing-store-v1' as const,
    environment: 'production' as const,
    sourceFileDigest:
      'sha256:b3433394dfdadd254067297cc81fc32ebdb3fd13f105726e9da1a890ef64e7ce' as const,
    sourceAuditRecordCount: 16 as const,
    sourceAuditHead:
      'sha256:d595f96cf098055041ebcc163713966e44c28fc0fef520ae435e48aa73ad68db' as const,
    schemaCatalogDigest:
      'sha256:e2351a8f40668012b342f5c63867b0c13cf7a9062fdca51e9956c06280d1e6e5' as const,
    manifestDigest:
      'sha256:91b491b3361cb63a753e25659a7329d85fdf6d66d666455a859a3b6aa002fcb2' as const,
    approvedPayloadDigest:
      'sha256:9a5e230f5537a145e816b9754da19b37c2fe8af64eb588ab7d180549c02d844c' as const,
    effectGraphDigest:
      'sha256:585e62e24b12cb9aa6f1a0c7c8fe82ef6d802a52698f8c53bec515b40cc457ca' as const,
    publishedEffectProofDigest:
      'sha256:2a8ce25791ef9229b0749909f56b0ecf0fff5819b2cafba3abfd9f5c587e8777' as const,
    redactedSuccessEvidenceDigest:
      'sha256:d0d3809fbc138f76945464af6add76b3d5578bef333bbc60a7179aa5e63ae750' as const,
    verifiedAtUtc: '2026-08-13T16:43:19.281Z' as const,
    remoteReadPerformedAtRequestTime: false as const,
  }),
  listing: Object.freeze({
    id: 'production:EBAY_US:CAN3570-U119' as const,
    lifecycleStatus: 'active' as const,
    shopify: Object.freeze({
      productId: 'gid://shopify/Product/10310708035875' as const,
      variantId: 'gid://shopify/ProductVariant/55396000563491' as const,
      sku: 'CAN3570-U119' as const,
      title: 'Canon 35-70mm f/3.5-4.5 (#119) *USED*' as const,
      imageUrls: Object.freeze([
        'https://cdn.shopify.com/s/files/1/0862/5451/8563/files/canon35-70-002Front-JPEG-1.jpg',
        'https://cdn.shopify.com/s/files/1/0862/5451/8563/files/canon35-70-003Leftside-JPEG-1.jpg',
        'https://cdn.shopify.com/s/files/1/0862/5451/8563/files/canon35-70-004Back-JPEG-1.jpg',
        'https://cdn.shopify.com/s/files/1/0862/5451/8563/files/canon35-70-005Rightside-JPEG-1.jpg',
        'https://cdn.shopify.com/s/files/1/0862/5451/8563/files/canon35-70-006Top-JPEG-1.jpg',
        'https://cdn.shopify.com/s/files/1/0862/5451/8563/files/canon35-70-006Top-JPEG-2.jpg',
      ] as const),
    }),
    ebay: Object.freeze({
      marketplaceId: 'EBAY_US' as const,
      offerId: '234942877011' as const,
      listingId: '147502608418' as const,
      url: 'https://www.ebay.com/itm/147502608418' as const,
    }),
    price: Object.freeze({ amount: '39.95' as const, currency: 'USD' as const }),
    audit: Object.freeze({
      verified: true as const,
      evidenceState: 'verified' as const,
      unresolvedCount: 0 as const,
      recoverySupported: true as const,
      currentRemoteStateVerified: false as const,
      retryPerformed: false as const,
      rollbackDispatched: false as const,
      oneAction: true as const,
    }),
  }),
  redaction: Object.freeze({
    credentialMaterialPresent: false as const,
    sellerIdentifiersPresent: false as const,
    productDescriptionPresent: false as const,
    customerDataPresent: false as const,
  }),
});

/** Digest of the canonical JSON body above; verified before any API projection. */
export const PRODUCTION_CAN3570_LISTING_EVIDENCE_EXPECTED_DIGEST =
  'sha256:f2361fa813c3f68866c8e1aa7686ccba0d19b57b8f5b5babece5097451e1383f' as const;

export const PRODUCTION_CAN3570_LISTING_EVIDENCE = Object.freeze({
  ...PRODUCTION_CAN3570_LISTING_EVIDENCE_BODY,
  digest: PRODUCTION_CAN3570_LISTING_EVIDENCE_EXPECTED_DIGEST,
});

export type ProductionCan3570ListingEvidence =
  typeof PRODUCTION_CAN3570_LISTING_EVIDENCE;
