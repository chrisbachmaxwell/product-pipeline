import React from 'react';
import {
  Badge,
  BlockStack,
  Card,
  InlineStack,
  Page,
  Text,
} from '@shopify/polaris';
import { useMigrationStatus } from '../hooks/useApi';
import { useAuthoritativeListings } from '../hooks/useAuthoritativeListings';
import { isLiveCatalogResponse } from '../operator-ui';

const Row: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <InlineStack align="space-between" blockAlign="center">
    <Text as="span">{label}</Text>
    {children}
  </InlineStack>
);

/** Owner labels the server reports -> what the operator should read. */
const OWNER_LABEL: Record<string, { text: string; tone: 'success' | 'attention' }> = {
  'product-pipeline': { text: 'ProductPipeline', tone: 'success' },
  'marketplace-connect': { text: 'Marketplace Connect', tone: 'attention' },
  unverified: { text: 'Not yet transferred', tone: 'attention' },
};

const RESPONSIBILITY_LABEL: Record<string, string> = {
  orderImport: 'Order import',
  price: 'Prices',
  inventory: 'Inventory',
  listingCreate: 'New listings',
  listingRevise: 'Listing edits',
  listingEndRelist: 'Ending and relisting',
  fulfillment: 'Tracking numbers',
};

const Settings: React.FC = () => {
  const migration = useMigrationStatus();
  const listings = useAuthoritativeListings({ limit: 1, offset: 0 });
  const ebayCurrent = isLiveCatalogResponse(listings.data);
  const responsibilities = (migration.data?.responsibilities ?? [])
    .filter((entry) => entry.responsibility in RESPONSIBILITY_LABEL);

  return (
    <Page title="Settings" fullWidth>
      <BlockStack gap="400">
        <Card>
          <BlockStack gap="300">
            <Text as="h3" variant="headingMd">Connections</Text>
            <Row label="Shopify">
              <Badge tone="success">Connected</Badge>
            </Row>
            <Row label="eBay">
              {ebayCurrent
                ? <Badge tone="success">Connected</Badge>
                : <Badge tone="attention">Checking…</Badge>}
            </Row>
          </BlockStack>
        </Card>

        <Card>
          <BlockStack gap="300">
            <Text as="h3" variant="headingMd">What ProductPipeline runs</Text>
            {responsibilities.map((entry) => {
              const owner = OWNER_LABEL[entry.owner ?? ''] ?? OWNER_LABEL.unverified;
              return (
                <Row key={entry.responsibility} label={RESPONSIBILITY_LABEL[entry.responsibility]}>
                  <Badge tone={owner.tone}>{owner.text}</Badge>
                </Row>
              );
            })}
            <Text as="p" variant="bodySm" tone="subdued">
              Marketplace Connect was retired on September 8, 2026. Every change to eBay
              is recorded in a tamper-evident history.
            </Text>
          </BlockStack>
        </Card>

        <Card>
          <BlockStack gap="200">
            <InlineStack align="space-between" blockAlign="center">
              <Text as="h3" variant="headingMd">Old eBay orders</Text>
              <Badge tone="success">Protected</Badge>
            </InlineStack>
            <Text as="p" tone="subdued">
              Orders from before September 8, 2026 are never imported into Shopify.
              This protection is permanent and cannot be switched off.
            </Text>
          </BlockStack>
        </Card>
      </BlockStack>
    </Page>
  );
};

export default Settings;
