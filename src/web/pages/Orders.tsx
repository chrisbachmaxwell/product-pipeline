import React from 'react';
import {
  Badge,
  BlockStack,
  Card,
  InlineStack,
  Page,
  Text,
} from '@shopify/polaris';
import { useMigrationStatus, useOperationalMonitoring } from '../hooks/useApi';

/**
 * Orders is a reassurance page, not a work surface: imports are automatic,
 * and the actual orders live in Shopify's own Orders section where the
 * operator already works. This page says what runs, and what never will.
 */
const Orders: React.FC = () => {
  const migration = useMigrationStatus();
  const monitoring = useOperationalMonitoring();
  const historical = migration.data?.reconciliation?.counts?.historicalEbayOrders
    ?? migration.data?.reconciliation?.counts?.historicalOrdersIneligible;
  const shadow = monitoring.data?.dailyDigest?.shadow;

  return (
    <Page title="Orders" fullWidth>
      <BlockStack gap="400">
        <Card>
          <BlockStack gap="200">
            <InlineStack align="space-between" blockAlign="center">
              <Text as="h3" variant="headingMd">Automatic import</Text>
              <Badge tone="success">On</Badge>
            </InlineStack>
            <Text as="p" tone="subdued">
              When something sells on eBay, ProductPipeline creates the Shopify order
              (tagged “eBay”), lowers the stock count, and — once you ship with a
              tracking number — sends that tracking back to eBay. No clicks needed.
            </Text>
            <Text as="p" tone="subdued">
              Find the orders themselves in Shopify’s Orders section, filtered by the
              “eBay” tag.
            </Text>
          </BlockStack>
        </Card>

        {shadow && shadow.observedCount > 0 && (
          <Card>
            <BlockStack gap="200">
              <Text as="h3" variant="headingMd">Latest check</Text>
              <Text as="p">
                {shadow.matchedCount} of {shadow.observedCount} recent eBay orders are
                confirmed in Shopify
                {shadow.unmatchedCount > 0
                  ? ` — ${shadow.unmatchedCount} still importing or need a look.`
                  : '.'}
              </Text>
            </BlockStack>
          </Card>
        )}

        <Card>
          <BlockStack gap="200">
            <InlineStack align="space-between" blockAlign="center">
              <Text as="h3" variant="headingMd">Old eBay orders</Text>
              <Text as="p" variant="headingLg">{typeof historical === 'number' ? historical : '—'}</Text>
            </InlineStack>
            <Text as="p" tone="subdued">
              Orders from before September 8, 2026 stay in eBay’s history and are never
              imported into Shopify. That protection is permanent.
            </Text>
          </BlockStack>
        </Card>
      </BlockStack>
    </Page>
  );
};

export default Orders;
