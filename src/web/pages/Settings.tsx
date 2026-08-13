import React from 'react';
import {
  Badge,
  BlockStack,
  Card,
  Divider,
  InlineStack,
  Page,
  Text,
} from '@shopify/polaris';
import { useAuthoritativeListings } from '../hooks/useAuthoritativeListings';
import { useMigrationStatus } from '../hooks/useApi';
import {
  isHistoricalBackfillProtected,
  isMigrationPolicyAvailable,
  isVerifiedListingSnapshot,
} from '../operator-ui';

const Row: React.FC<{ label: string; value: string; tone: 'info' | 'attention' | 'success' | 'critical' }> = ({
  label,
  value,
  tone,
}) => (
  <InlineStack align="space-between" blockAlign="center" gap="300">
    <Text as="p">{label}</Text>
    <Badge tone={tone}>{value}</Badge>
  </InlineStack>
);

const Settings: React.FC = () => {
  const migration = useMigrationStatus();
  const listings = useAuthoritativeListings({ limit: 1, offset: 0 });
  const migrationAvailable = !migration.error && isMigrationPolicyAvailable(migration.data);
  const ebayVerified = !listings.error && isVerifiedListingSnapshot(listings.data);
  const backfillProtected = isHistoricalBackfillProtected(migration.data);

  const shopifyState = migration.isLoading
    ? { value: 'Checking', tone: 'info' as const }
    : migrationAvailable
      ? { value: 'Embedded app', tone: 'info' as const }
      : { value: 'Unavailable', tone: 'critical' as const };
  const ebayState = listings.isLoading
    ? { value: 'Checking', tone: 'info' as const }
    : ebayVerified
      ? { value: 'Verified snapshot', tone: 'info' as const }
      : { value: 'Unavailable', tone: 'critical' as const };
  const protectionState = migration.isLoading
    ? { value: 'Checking', tone: 'info' as const }
    : !migrationAvailable || migration.data?.historicalBackfillAllowed === undefined
      ? { value: 'Unavailable', tone: 'critical' as const }
      : backfillProtected
        ? { value: 'On', tone: 'success' as const }
        : { value: 'Off', tone: 'critical' as const };

  return (
    <Page title="Settings" fullWidth>
      <BlockStack gap="500">
        <Card>
          <BlockStack gap="300">
            <Text as="h2" variant="headingMd">Connections</Text>
            <Row label="Shopify" {...shopifyState} />
            <Divider />
            <Row label="eBay" {...ebayState} />
          </BlockStack>
        </Card>

        <Card>
          <BlockStack gap="300">
            <Text as="h2" variant="headingMd">Ownership</Text>
            <Row label="Canon listing canary" value="ProductPipeline" tone="info" />
            <Divider />
            <Row label="Orders" value="Marketplace Connect" tone="attention" />
            <Divider />
            <Row label="Price" value="Marketplace Connect" tone="attention" />
            <Divider />
            <Row label="Inventory" value="Marketplace Connect" tone="attention" />
          </BlockStack>
        </Card>

        <Card>
          <InlineStack align="space-between" blockAlign="center">
            <BlockStack gap="100">
              <Text as="h2" variant="headingMd">Historical orders</Text>
              <Text as="p" tone="subdued">Backfill protection</Text>
            </BlockStack>
            <Badge tone={protectionState.tone}>{protectionState.value}</Badge>
          </InlineStack>
        </Card>
      </BlockStack>
    </Page>
  );
};

export default Settings;
