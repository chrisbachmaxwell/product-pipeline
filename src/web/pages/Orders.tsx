import React from 'react';
import {
  Badge,
  BlockStack,
  Card,
  Divider,
  InlineStack,
  Page,
  SkeletonBodyText,
  Text,
} from '@shopify/polaris';
import { useMigrationStatus } from '../hooks/useApi';

const Orders: React.FC = () => {
  const migration = useMigrationStatus();
  const status = migration.data;
  const historicalCount = status?.reconciliation?.counts?.historicalEbayOrders;

  return (
    <Page title="Orders" fullWidth>
      <BlockStack gap="500">
        <Card>
          {migration.isLoading ? (
            <SkeletonBodyText lines={4} />
          ) : migration.error ? (
            <InlineStack align="space-between" blockAlign="center">
              <Text as="p">Order status unavailable</Text>
              <Badge tone="critical">Unavailable</Badge>
            </InlineStack>
          ) : (
            <BlockStack gap="300">
              <InlineStack align="space-between" blockAlign="center">
                <Text as="h2" variant="headingMd">Order import</Text>
                <Badge tone="attention">Marketplace Connect</Badge>
              </InlineStack>
              <Text as="p" tone="subdued">ProductPipeline order import is off.</Text>
              <Divider />
              <InlineStack align="space-between" blockAlign="center">
                <Text as="p">Cutover</Text>
                <Badge tone="info">Not started</Badge>
              </InlineStack>
              <InlineStack align="space-between" blockAlign="center">
                <Text as="p">Historical import</Text>
                <Badge tone="success">Blocked</Badge>
              </InlineStack>
            </BlockStack>
          )}
        </Card>

        {typeof historicalCount === 'number' && (
          <Card>
            <InlineStack align="space-between" blockAlign="center">
              <BlockStack gap="100">
                <Text as="h2" variant="headingMd">Historical records</Text>
                <Text as="p" tone="subdued">View only · never eligible for import</Text>
              </BlockStack>
              <Text as="p" variant="headingXl">{historicalCount.toLocaleString()}</Text>
            </InlineStack>
          </Card>
        )}
      </BlockStack>
    </Page>
  );
};

export default Orders;
