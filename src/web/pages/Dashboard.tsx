import React from 'react';
import {
  Badge,
  Banner,
  BlockStack,
  Button,
  Card,
  InlineGrid,
  InlineStack,
  Page,
  SkeletonBodyText,
  Text,
} from '@shopify/polaris';
import { useNavigate } from 'react-router-dom';
import { useAuthoritativeListings } from '../hooks/useAuthoritativeListings';
import { useActivity, useEbayQuota, useOperationalMonitoring } from '../hooks/useApi';
import { formatVerifiedAt, isLiveCatalogResponse } from '../operator-ui';

const EVENT_EMOJI: Record<string, string> = {
  order_imported: '🛒',
  listing_ended: '🔚',
  listing_relisted: '🔁',
  quantity_updated: '📦',
  price_updated: '💲',
  tracking_sent: '🚚',
  listing_created: '✨',
};

const timeOfDay = (iso: string): string => {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? ''
    : date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
};

const CountCard: React.FC<{
  label: string;
  value: number | null;
  tone?: 'critical' | 'success';
  onClick?: () => void;
}> = ({ label, value, tone, onClick }) => (
  <Card>
    <BlockStack gap="200">
      <Text as="p" tone="subdued">{label}</Text>
      <InlineStack align="space-between" blockAlign="center">
        <Text as="p" variant="heading2xl" tone={tone}>{value ?? '—'}</Text>
        {onClick && value !== null && value > 0 && (
          <Button variant="plain" onClick={onClick}>View</Button>
        )}
      </InlineStack>
    </BlockStack>
  </Card>
);

/**
 * Home answers three questions in one glance, in plain words:
 * is everything synced, what sold, and what needs me?
 */
const Dashboard: React.FC = () => {
  const navigate = useNavigate();
  const listings = useAuthoritativeListings({ limit: 1, offset: 0 });
  const monitoring = useOperationalMonitoring();
  const activity = useActivity();
  const quota = useEbayQuota();
  const valid = isLiveCatalogResponse(listings.data);
  const summary = valid ? listings.data?.summary : undefined;
  const loading = listings.isLoading;
  const unavailable = Boolean(listings.error || (listings.data && !valid));
  const shadow = monitoring.data?.dailyDigest?.shadow;

  const attention = summary?.attention ?? null;
  const unknown = summary?.unknown ?? null;

  // A served snapshot can be an honest-but-old fallback (restart during a
  // provider outage): label its age instead of pretending it is current.
  const observedAgeMs = valid && listings.data
    ? Date.now() - new Date(listings.data.observedAtUtc).getTime()
    : null;
  const stale = observedAgeMs !== null && observedAgeMs > 20 * 60_000;
  const staleLabel = observedAgeMs !== null
    ? new Date(Date.now() - observedAgeMs).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : null;

  let heroTone: 'success' | 'warning' | 'critical' = 'success';
  let heroHeading = 'Everything is synced';
  let heroBody = 'Your eBay listings match Shopify.';
  if (stale) {
    heroTone = 'warning';
    heroHeading = 'Showing last known eBay state';
    heroBody = `Live checks are paused — this is what eBay looked like at ${staleLabel}. Refreshing resumes automatically.`;
  } else if (unavailable) {
    heroTone = 'warning';
    heroHeading = 'Checking eBay…';
    heroBody = 'Live status is temporarily unavailable. Syncing continues in the background.';
  } else if ((attention ?? 0) > 0) {
    heroTone = 'critical';
    heroHeading = attention === 1 ? '1 listing needs your review' : `${attention} listings need your review`;
    heroBody = 'Everything else is synced.';
  } else if ((unknown ?? 0) > 0) {
    heroTone = 'warning';
    heroHeading = 'Refreshing eBay status…';
    heroBody = 'The latest check has not finished. Syncing continues in the background.';
  }

  const quotaData = quota.data;
  const quotaPercent = quotaData?.usedFraction != null
    ? Math.round(quotaData.usedFraction * 100)
    : null;
  const quotaResetLabel = quotaData?.resetAtUtc
    ? new Date(quotaData.resetAtUtc).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : null;

  return (
    <Page title="Home" fullWidth>
      <BlockStack gap="400">
        {quotaData?.warning && quotaPercent !== null && (
          <Banner
            tone={quotaData.usedFraction != null && quotaData.usedFraction >= 0.85
              ? 'critical'
              : 'warning'}
            title={`eBay API usage is at ${quotaPercent}% of the daily limit`}
          >
            <Text as="p">
              If it reaches 100%, the listing screens pause until the daily
              reset{quotaResetLabel ? ` at ${quotaResetLabel}` : ''} — orders,
              inventory, and tracking are unaffected.
            </Text>
          </Banner>
        )}
        <Card>
          {loading ? (
            <SkeletonBodyText lines={2} />
          ) : (
            <InlineStack align="space-between" blockAlign="center">
              <BlockStack gap="100">
                <InlineStack gap="200" blockAlign="center">
                  <Badge
                    tone={heroTone === 'success' ? 'success' : heroTone === 'warning' ? 'attention' : 'critical'}
                  >
                    {heroTone === 'success' ? 'Synced' : heroTone === 'warning' ? 'Checking' : 'Review'}
                  </Badge>
                  <Text as="h2" variant="headingLg">{heroHeading}</Text>
                </InlineStack>
                <Text as="p" tone="subdued">{heroBody}</Text>
              </BlockStack>
              {(attention ?? 0) > 0 && (
                <Button variant="primary" onClick={() => navigate('/issues')}>
                  Review now
                </Button>
              )}
            </InlineStack>
          )}
        </Card>

        <InlineGrid columns={{ xs: 1, sm: 2, md: 4 }} gap="400">
          <CountCard label="Live on eBay" value={summary?.active ?? null} />
          <CountCard
            label="Ready to list"
            value={summary?.readyToList ?? null}
            tone={(summary?.readyToList ?? 0) > 0 ? 'success' : undefined}
            onClick={() => navigate('/listings?filter=ready')}
          />
          <CountCard
            label="Not on eBay"
            value={summary?.notListed ?? null}
            onClick={() => navigate('/listings')}
          />
          <CountCard
            label="Needs review"
            value={attention}
            tone={(attention ?? 0) > 0 ? 'critical' : undefined}
            onClick={() => navigate('/issues')}
          />
        </InlineGrid>

        {(activity.data?.events?.length ?? 0) > 0 && (
          <Card>
            <BlockStack gap="300">
              <Text as="h3" variant="headingMd">Today</Text>
              <BlockStack gap="200">
                {activity.data!.events.slice(0, 8).map((event, index) => (
                  <InlineStack key={`${event.atUtc}-${index}`} align="space-between" blockAlign="center">
                    <Text as="span">
                      {(EVENT_EMOJI[event.kind] ?? '•') + ' ' + event.label}
                      {event.sku ? ` — ${event.sku}` : ''}
                    </Text>
                    <Text as="span" variant="bodySm" tone="subdued">{timeOfDay(event.atUtc)}</Text>
                  </InlineStack>
                ))}
              </BlockStack>
            </BlockStack>
          </Card>
        )}

        <Card>
          <BlockStack gap="200">
            <InlineStack align="space-between" blockAlign="center">
              <Text as="h3" variant="headingMd">eBay orders</Text>
              <Badge tone="success">Automatic</Badge>
            </InlineStack>
            <Text as="p" tone="subdued">
              New eBay sales become Shopify orders within a few minutes, stock counts
              update everywhere, and tracking is sent back to eBay when you ship.
            </Text>
            {shadow && shadow.observedCount > 0 && (
              <Text as="p">
                Last checked window: {shadow.matchedCount} of {shadow.observedCount} eBay
                orders confirmed in Shopify.
              </Text>
            )}
          </BlockStack>
        </Card>

        <InlineStack align="space-between" blockAlign="center">
          <Text as="span" variant="bodySm" tone="subdued">
            {valid ? formatVerifiedAt(listings.data?.observedAtUtc) : 'Waiting for the next check…'}
          </Text>
          <Text as="span" variant="bodySm" tone="subdued">
            Shopify + eBay
          </Text>
        </InlineStack>
      </BlockStack>
    </Page>
  );
};

export default Dashboard;
