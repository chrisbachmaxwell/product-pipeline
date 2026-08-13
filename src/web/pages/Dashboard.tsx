import React from 'react';
import {
  Badge,
  BlockStack,
  Card,
  InlineGrid,
  InlineStack,
  Page,
  SkeletonBodyText,
  Text,
} from '@shopify/polaris';
import { Link } from 'react-router-dom';
import { useAuthoritativeListings } from '../hooks/useAuthoritativeListings';
import { useMigrationStatus } from '../hooks/useApi';
import { formatVerifiedAt, isLiveCatalogResponse } from '../operator-ui';

const CountCard: React.FC<{ label: string; value: number; tone?: 'critical' }> = ({
  label,
  value,
  tone,
}) => (
  <Card>
    <BlockStack gap="200">
      <Text as="p" tone="subdued">{label}</Text>
      <Text as="p" variant="heading2xl" tone={tone}>{value}</Text>
    </BlockStack>
  </Card>
);

const Dashboard: React.FC = () => {
  const listings = useAuthoritativeListings({ limit: 1, offset: 0 });
  const migration = useMigrationStatus();
  const valid = isLiveCatalogResponse(listings.data);
  const summary = valid ? listings.data?.summary : undefined;
  const unavailable = Boolean(listings.error || (listings.data && !valid));
  const connectionsUnavailable = unavailable || Boolean(migration.error);

  return (
    <Page title="Overview" fullWidth>
      <BlockStack gap="500">
        {listings.isLoading ? (
          <SkeletonBodyText lines={4} />
        ) : unavailable || !summary ? (
          <Card>
            <InlineStack align="space-between" blockAlign="center">
              <Text as="p">Listings unavailable</Text>
              <Badge tone="critical">Unavailable</Badge>
            </InlineStack>
          </Card>
        ) : (
          <BlockStack gap="200">
            <InlineStack align="end">
              <Text as="span" variant="bodySm" tone="subdued">
                {formatVerifiedAt(listings.data?.observedAtUtc)}
              </Text>
            </InlineStack>
            <InlineGrid columns={{ xs: 1, sm: 3 }} gap="300">
              <CountCard
                label="Needs attention"
                value={summary.attention}
                tone={summary.attention > 0 ? 'critical' : undefined}
              />
              <CountCard label="Not listed" value={summary.notListed} />
              <CountCard label="Active when checked" value={summary.active} />
            </InlineGrid>
          </BlockStack>
        )}

        {!unavailable && summary && (
          <InlineGrid columns={{ xs: 1, md: '2fr 1fr' }} gap="400">
            <Card>
              <BlockStack gap="300">
                <InlineStack align="space-between" blockAlign="center">
                  <Text as="h2" variant="headingMd">Issues</Text>
                  <Badge tone={summary.attention > 0 ? 'critical' : 'success'}>
                    {String(summary.attention)}
                  </Badge>
                </InlineStack>
                <Link to="/issues">View issues</Link>
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="300">
                <InlineStack align="space-between" blockAlign="center">
                  <Text as="h2" variant="headingMd">Connections</Text>
                  <Badge tone={connectionsUnavailable ? 'critical' : 'success'}>
                    {connectionsUnavailable ? 'Unavailable' : 'Checked'}
                  </Badge>
                </InlineStack>
                <Text as="p">Shopify + eBay</Text>
                <Link to="/settings">View settings</Link>
              </BlockStack>
            </Card>
          </InlineGrid>
        )}

        <Card>
          <InlineStack align="space-between" blockAlign="center" gap="300">
            <BlockStack gap="100">
              <Text as="h2" variant="headingMd">Ownership</Text>
              <Text as="p" tone="subdued">Orders, price, and inventory</Text>
            </BlockStack>
            <Badge tone="attention">Marketplace Connect</Badge>
          </InlineStack>
        </Card>
      </BlockStack>
    </Page>
  );
};

export default Dashboard;
