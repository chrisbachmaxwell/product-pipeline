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
import {
  formatVerifiedAt,
  latestListingVerification,
  listingCounts,
  totalListingIssues,
} from '../operator-ui';

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
  const listings = useAuthoritativeListings({ limit: 100, offset: 0 });
  const migration = useMigrationStatus();
  const rows = listings.data?.data ?? [];
  const counts = listingCounts(rows);
  const issues = totalListingIssues(rows);
  const verifiedAt = latestListingVerification(rows);
  const statusUnavailable = Boolean(listings.error || migration.error);

  return (
    <Page title="Overview" fullWidth>
      <BlockStack gap="500">
        {listings.isLoading ? (
          <SkeletonBodyText lines={4} />
        ) : listings.error ? (
          <Card>
            <InlineStack align="space-between" blockAlign="center">
              <Text as="p">Listing snapshot unavailable</Text>
              <Badge tone="critical">Unavailable</Badge>
            </InlineStack>
          </Card>
        ) : (
          <BlockStack gap="200">
            <InlineStack align="end"><Badge tone="info">Verified snapshot</Badge></InlineStack>
            <InlineGrid columns={{ xs: 2, md: 4 }} gap="300">
              <CountCard label="Needs attention" value={counts.attention} tone={counts.attention > 0 ? 'critical' : undefined} />
              <CountCard label="Ready" value={counts.ready} />
              <CountCard label="Active when checked" value={counts.active} />
              <CountCard label="Ended" value={counts.ended} />
            </InlineGrid>
          </BlockStack>
        )}

        {!listings.error && <InlineGrid columns={{ xs: 1, md: '2fr 1fr' }} gap="400">
          <Card>
            <BlockStack gap="300">
              <InlineStack align="space-between" blockAlign="center">
                <Text as="h2" variant="headingMd">Issues</Text>
                <Badge tone={issues > 0 ? 'critical' : 'success'}>{String(issues)}</Badge>
              </InlineStack>
              <Text as="p" tone="subdued">
                {issues > 0 ? 'Listings need review.' : 'No listing issues in the verified snapshot.'}
              </Text>
              <Link to="/issues">View issues</Link>
            </BlockStack>
          </Card>

          <Card>
            <BlockStack gap="300">
              <InlineStack align="space-between" blockAlign="center">
                <Text as="h2" variant="headingMd">Connections</Text>
                <Badge tone={statusUnavailable ? 'critical' : 'info'}>
                  {statusUnavailable ? 'Unavailable' : 'Read only'}
                </Badge>
              </InlineStack>
              <Text as="p">Canon listing · ProductPipeline</Text>
              <Text as="p" tone="subdued">{formatVerifiedAt(verifiedAt)}</Text>
              <Link to="/settings">View settings</Link>
            </BlockStack>
          </Card>
        </InlineGrid>}

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
