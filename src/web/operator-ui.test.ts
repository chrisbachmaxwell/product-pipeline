import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { AuthoritativeListingItem } from './hooks/useAuthoritativeListings';
import {
  DEFAULT_LISTING_TAB,
  formatListingPrice,
  formatVerifiedAt,
  isHistoricalBackfillProtected,
  isMigrationPolicyAvailable,
  isVerifiedListingSnapshot,
  latestListingVerification,
  LISTING_TABS,
  listingCounts,
  listingStatusLabel,
  listingStatusTone,
  totalListingIssues,
  verifiedListingImageUrl,
} from './operator-ui';

const listing = (overrides: Partial<AuthoritativeListingItem> = {}): AuthoritativeListingItem => ({
  id: 'production:EBAY_US:CAN3570-U119',
  shopify: {
    productId: 'gid://shopify/Product/1',
    variantId: 'gid://shopify/ProductVariant/1',
    sku: 'CAN3570-U119',
    title: 'Canon 35-70mm',
    primaryImageUrl: 'https://cdn.shopify.com/example.jpg',
    imageCount: 6,
  },
  ebay: {
    listingId: '147502608418',
    offerId: '234942877011',
    url: 'https://www.ebay.com/itm/147502608418',
  },
  price: { amount: '39.95', currency: 'USD' },
  lifecycleStatus: 'active',
  lastVerifiedAtUtc: '2026-08-13T17:30:00.000Z',
  audit: {
    verified: true,
    evidenceState: 'verified',
    unresolvedCount: 0,
    recoverySupported: true,
    currentRemoteStateVerified: false,
  },
  ...overrides,
});

describe('minimal listing operator UI projection', () => {
  it('never carries a prior listing result into a different filter', () => {
    const hookSource = readFileSync(
      fileURLToPath(new URL('./hooks/useAuthoritativeListings.ts', import.meta.url)),
      'utf8',
    );
    expect(hookSource).not.toMatch(/keepPreviousData|placeholderData/);
  });

  it('keeps exactly four ordered listing tabs with Active selected by default', () => {
    expect(LISTING_TABS).toEqual([
      { id: 'attention', label: 'Needs attention' },
      { id: 'ready', label: 'Ready' },
      { id: 'active', label: 'Active' },
      { id: 'ended', label: 'Ended' },
    ]);
    expect(DEFAULT_LISTING_TAB).toBe(2);
  });

  it('labels historical ACTIVE evidence with its temporal limit', () => {
    expect(listingStatusLabel('active')).toBe('Active when checked');
    expect(listingStatusTone('active')).toBe('success');
    expect(formatVerifiedAt('not-a-date')).toBe('Not verified');
    expect(formatVerifiedAt('2026-08-13T17:30:00.000Z')).toMatch(/^Verified /);
  });

  it('formats audited price and derives compact counts without mutation behavior', () => {
    const rows = [
      listing(),
      listing({
        id: 'ready',
        lifecycleStatus: 'ready',
        audit: { ...listing().audit, unresolvedCount: 2 },
        lastVerifiedAtUtc: '2026-08-13T17:00:00.000Z',
      }),
    ];
    expect(formatListingPrice(rows[0]!.price)).toBe('$39.95');
    expect(formatListingPrice(null)).toBe('—');
    expect(listingCounts(rows)).toEqual({ attention: 0, ready: 1, active: 1, ended: 0 });
    expect(totalListingIssues(rows)).toBe(2);
    expect(latestListingVerification(rows)).toBe('2026-08-13T17:30:00.000Z');
  });

  it('renders only verified HTTPS image hosts', () => {
    expect(verifiedListingImageUrl('https://cdn.shopify.com/example.jpg')).toBe(
      'https://cdn.shopify.com/example.jpg',
    );
    expect(verifiedListingImageUrl('http://cdn.shopify.com/example.jpg')).toBeNull();
    expect(verifiedListingImageUrl('https://cdn.shopify.com.evil.test/example.jpg')).toBeNull();
    expect(verifiedListingImageUrl('data:image/png;base64,abc')).toBeNull();
    expect(verifiedListingImageUrl(null)).toBeNull();
  });

  it('shows verified settings state only for a nonempty matching snapshot contract', () => {
    const response = {
      schemaVersion: 1 as const,
      data: [listing()],
      total: 1,
      limit: 1,
      offset: 0,
      source: 'production-listing-audit-ledger' as const,
      evidenceKind: 'verified_snapshot' as const,
      authoritative: false as const,
      remoteReadPerformed: false as const,
      externalWritesPerformed: 0 as const,
    };

    expect(isVerifiedListingSnapshot(response)).toBe(true);
    expect(isVerifiedListingSnapshot({ ...response, data: [], total: 0 })).toBe(false);
    expect(
      isVerifiedListingSnapshot({
        ...response,
        data: [listing({ audit: { ...listing().audit, verified: false } })],
      }),
    ).toBe(false);
  });

  it('shows backfill protection only when the migration policy explicitly denies it', () => {
    expect(
      isMigrationPolicyAvailable({
        phase: 'marketplace-connect-incumbent',
        effectiveMode: 'shadow-read-only',
        historicalBackfillAllowed: false,
      }),
    ).toBe(true);
    expect(isMigrationPolicyAvailable({ historicalBackfillAllowed: false })).toBe(false);
    expect(isMigrationPolicyAvailable(undefined)).toBe(false);
    expect(isHistoricalBackfillProtected({ historicalBackfillAllowed: false })).toBe(true);
    expect(isHistoricalBackfillProtected({ historicalBackfillAllowed: true })).toBe(false);
    expect(isHistoricalBackfillProtected({})).toBe(false);
    expect(isHistoricalBackfillProtected(undefined)).toBe(false);
  });
});
