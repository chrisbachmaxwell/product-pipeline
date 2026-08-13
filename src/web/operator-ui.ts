import type {
  AuthoritativeListingItem,
  AuthoritativeListingStatus,
} from './hooks/useAuthoritativeListings';

export const LISTING_TABS: ReadonlyArray<{
  id: AuthoritativeListingStatus;
  label: string;
}> = [
  { id: 'attention', label: 'Needs attention' },
  { id: 'ready', label: 'Ready' },
  { id: 'active', label: 'Active' },
  { id: 'ended', label: 'Ended' },
];

export const DEFAULT_LISTING_TAB = LISTING_TABS.findIndex((tab) => tab.id === 'active');

export const listingStatusLabel = (status: AuthoritativeListingStatus): string =>
  status === 'active'
    ? 'Active when checked'
    : LISTING_TABS.find((tab) => tab.id === status)?.label ?? status;

export const listingStatusTone = (
  status: AuthoritativeListingStatus,
): 'critical' | 'info' | 'success' | 'attention' => {
  if (status === 'attention') return 'critical';
  if (status === 'ready') return 'info';
  if (status === 'active') return 'success';
  return 'attention';
};

export const formatListingPrice = (price: AuthoritativeListingItem['price']): string => {
  if (!price) return '—';
  const amount = Number(price.amount);
  if (!Number.isFinite(amount)) return '—';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: price.currency,
  }).format(amount);
};

export const formatVerifiedAt = (value: string | null | undefined): string => {
  if (!value) return 'Not verified';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Not verified';
  return `Verified ${new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(date)}`;
};

export const listingCounts = (
  listings: AuthoritativeListingItem[],
): Record<AuthoritativeListingStatus, number> => {
  const counts: Record<AuthoritativeListingStatus, number> = {
    attention: 0,
    ready: 0,
    active: 0,
    ended: 0,
  };
  for (const listing of listings) counts[listing.lifecycleStatus] += 1;
  return counts;
};

export const totalListingIssues = (listings: AuthoritativeListingItem[]): number =>
  listings.reduce((total, listing) => total + listing.audit.unresolvedCount, 0);

export const latestListingVerification = (
  listings: AuthoritativeListingItem[],
): string | null => {
  const values = listings
    .map((listing) => listing.lastVerifiedAtUtc)
    .filter((value) => !Number.isNaN(new Date(value).getTime()))
    .sort((left, right) => new Date(right).getTime() - new Date(left).getTime());
  return values[0] ?? null;
};

export const isVerifiedListingSnapshot = (
  response: unknown,
): boolean => {
  if (!response || typeof response !== 'object') return false;
  const snapshot = response as Record<string, unknown>;
  if (
    snapshot.schemaVersion !== 1 ||
    snapshot.source !== 'production-listing-audit-ledger' ||
    snapshot.evidenceKind !== 'verified_snapshot' ||
    snapshot.authoritative !== false ||
    snapshot.remoteReadPerformed !== false ||
    snapshot.externalWritesPerformed !== 0 ||
    !Array.isArray(snapshot.data) ||
    snapshot.data.length === 0
  ) {
    return false;
  }

  return snapshot.data.every((value) => {
    if (!value || typeof value !== 'object') return false;
    const listing = value as Record<string, unknown>;
    const audit = listing.audit;
    return (
      audit !== null &&
      typeof audit === 'object' &&
      (audit as Record<string, unknown>).verified === true &&
      (audit as Record<string, unknown>).evidenceState === 'verified' &&
      typeof listing.lastVerifiedAtUtc === 'string' &&
      !Number.isNaN(new Date(listing.lastVerifiedAtUtc).getTime())
    );
  });
};

export const isMigrationPolicyAvailable = (
  migration: {
    phase?: string;
    effectiveMode?: string;
    historicalBackfillAllowed?: boolean;
  } | undefined,
): boolean =>
  typeof migration?.phase === 'string' &&
  typeof migration.effectiveMode === 'string' &&
  typeof migration.historicalBackfillAllowed === 'boolean';

export const isHistoricalBackfillProtected = (
  migration: { historicalBackfillAllowed?: boolean } | undefined,
): boolean => migration?.historicalBackfillAllowed === false;

const VERIFIED_IMAGE_HOSTS = new Set([
  'cdn.shopify.com',
  'usedcameragear.com',
  'www.usedcameragear.com',
]);

export const verifiedListingImageUrl = (value: string | null): string | null => {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && VERIFIED_IMAGE_HOSTS.has(url.hostname.toLowerCase())
      ? url.toString()
      : null;
  } catch {
    return null;
  }
};
