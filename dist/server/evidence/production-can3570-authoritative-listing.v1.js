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
    schemaVersion: 1,
    kind: 'product-pipeline-authoritative-listing-verified-snapshot',
    evidenceKind: 'verified_snapshot',
    source: Object.freeze({
        kind: 'production-listing-audit-ledger',
        strictVerifier: 'production-listing-store-v1',
        environment: 'production',
        sourceFileDigest: 'sha256:b3433394dfdadd254067297cc81fc32ebdb3fd13f105726e9da1a890ef64e7ce',
        sourceAuditRecordCount: 16,
        sourceAuditHead: 'sha256:d595f96cf098055041ebcc163713966e44c28fc0fef520ae435e48aa73ad68db',
        schemaCatalogDigest: 'sha256:e2351a8f40668012b342f5c63867b0c13cf7a9062fdca51e9956c06280d1e6e5',
        manifestDigest: 'sha256:91b491b3361cb63a753e25659a7329d85fdf6d66d666455a859a3b6aa002fcb2',
        approvedPayloadDigest: 'sha256:9a5e230f5537a145e816b9754da19b37c2fe8af64eb588ab7d180549c02d844c',
        effectGraphDigest: 'sha256:585e62e24b12cb9aa6f1a0c7c8fe82ef6d802a52698f8c53bec515b40cc457ca',
        publishedEffectProofDigest: 'sha256:2a8ce25791ef9229b0749909f56b0ecf0fff5819b2cafba3abfd9f5c587e8777',
        redactedSuccessEvidenceDigest: 'sha256:d0d3809fbc138f76945464af6add76b3d5578bef333bbc60a7179aa5e63ae750',
        verifiedAtUtc: '2026-08-13T16:43:19.281Z',
        remoteReadPerformedAtRequestTime: false,
    }),
    listing: Object.freeze({
        id: 'production:EBAY_US:CAN3570-U119',
        lifecycleStatus: 'active',
        shopify: Object.freeze({
            productId: 'gid://shopify/Product/10310708035875',
            variantId: 'gid://shopify/ProductVariant/55396000563491',
            sku: 'CAN3570-U119',
            title: 'Canon 35-70mm f/3.5-4.5 (#119) *USED*',
            imageUrls: Object.freeze([
                'https://cdn.shopify.com/s/files/1/0862/5451/8563/files/canon35-70-002Front-JPEG-1.jpg',
                'https://cdn.shopify.com/s/files/1/0862/5451/8563/files/canon35-70-003Leftside-JPEG-1.jpg',
                'https://cdn.shopify.com/s/files/1/0862/5451/8563/files/canon35-70-004Back-JPEG-1.jpg',
                'https://cdn.shopify.com/s/files/1/0862/5451/8563/files/canon35-70-005Rightside-JPEG-1.jpg',
                'https://cdn.shopify.com/s/files/1/0862/5451/8563/files/canon35-70-006Top-JPEG-1.jpg',
                'https://cdn.shopify.com/s/files/1/0862/5451/8563/files/canon35-70-006Top-JPEG-2.jpg',
            ]),
        }),
        ebay: Object.freeze({
            marketplaceId: 'EBAY_US',
            offerId: '234942877011',
            listingId: '147502608418',
            url: 'https://www.ebay.com/itm/147502608418',
        }),
        price: Object.freeze({ amount: '39.95', currency: 'USD' }),
        audit: Object.freeze({
            verified: true,
            evidenceState: 'verified',
            unresolvedCount: 0,
            recoverySupported: true,
            currentRemoteStateVerified: false,
            retryPerformed: false,
            rollbackDispatched: false,
            oneAction: true,
        }),
    }),
    redaction: Object.freeze({
        credentialMaterialPresent: false,
        sellerIdentifiersPresent: false,
        productDescriptionPresent: false,
        customerDataPresent: false,
    }),
});
/** Digest of the canonical JSON body above; verified before any API projection. */
export const PRODUCTION_CAN3570_LISTING_EVIDENCE_EXPECTED_DIGEST = 'sha256:f2361fa813c3f68866c8e1aa7686ccba0d19b57b8f5b5babece5097451e1383f';
export const PRODUCTION_CAN3570_LISTING_EVIDENCE = Object.freeze({
    ...PRODUCTION_CAN3570_LISTING_EVIDENCE_BODY,
    digest: PRODUCTION_CAN3570_LISTING_EVIDENCE_EXPECTED_DIGEST,
});
