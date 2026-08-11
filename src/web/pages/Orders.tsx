import React from 'react';
import {
  Badge,
  Banner,
  BlockStack,
  Card,
  Divider,
  InlineGrid,
  InlineStack,
  Page,
  SkeletonBodyText,
  Text,
} from '@shopify/polaris';
import { useMigrationStatus } from '../hooks/useApi';
import { MigrationSafetyBanner } from '../components/MigrationSafety';

const Metric: React.FC<{ label: string; value: number | string }> = ({ label, value }) => (
  <Card>
    <BlockStack gap="100">
      <Text as="p" tone="subdued">{label}</Text>
      <Text variant="headingLg" as="p">{typeof value === 'number' ? value.toLocaleString() : value}</Text>
    </BlockStack>
  </Card>
);

const PolicyRow: React.FC<{ label: string; value: string; tone?: 'success' | 'warning' }> = ({
  label,
  value,
  tone = 'success',
}) => (
  <InlineStack align="space-between" blockAlign="center" gap="300">
    <Text as="span">{label}</Text>
    <Badge tone={tone}>{value}</Badge>
  </InlineStack>
);

const Orders: React.FC = () => {
  const statusQuery = useMigrationStatus();
  const status = statusQuery.data;
  const counts = status?.reconciliation?.counts ?? {};

  return (
    <Page title="Orders" subtitle="Observation-only migration state" fullWidth>
      <BlockStack gap="500">
        <MigrationSafetyBanner
          status={status}
          error={statusQuery.error instanceof Error ? statusQuery.error : null}
        />
        <Banner tone="warning" title="Marketplace Connect is the sole production order importer">
          <BlockStack gap="100">
            <Text as="p">
              ProductPipeline order ingestion and Shopify-order creation are hard-disabled. No
              cutover watermark exists, no historical backfill is permitted, and every historical
              local record is ineligible for creation by ProductPipeline.
            </Text>
            <Text as="p" tone="subdued">
              Customer and order payloads are intentionally not exposed by this shadow-mode screen.
            </Text>
          </BlockStack>
        </Banner>

        {statusQuery.isLoading ? (
          <SkeletonBodyText lines={6} />
        ) : (
          <InlineGrid columns={{ xs: 1, sm: 2, md: 4 }} gap="300">
            <Metric label="Historical local eBay records" value={counts.historicalEbayOrders ?? 0} />
            <Metric label="Historical records ineligible" value={counts.historicalOrdersIneligible ?? 0} />
            <Metric label="Local order mappings" value={counts.orderMappings ?? 0} />
            <Metric label="Eligible for ProductPipeline creation" value={0} />
          </InlineGrid>
        )}

        <Card>
          <BlockStack gap="300">
            <InlineStack align="space-between" blockAlign="center">
              <Text variant="headingMd" as="h2">Effective order policy</Text>
              <Badge tone="info">Read-only</Badge>
            </InlineStack>
            <Divider />
            <PolicyRow label="Production importer" value="Marketplace Connect" />
            <Divider />
            <PolicyRow label="ProductPipeline order writer" value="Hard-disabled" />
            <Divider />
            <PolicyRow label="Historical backfill" value="Blocked" />
            <Divider />
            <PolicyRow label="Cutover watermark" value={status?.cutoverWatermarkUtc ?? 'Not established'} />
            <Divider />
            <PolicyRow label="Production parity" value="Not verified" tone="warning" />
          </BlockStack>
        </Card>

        <Card>
          <BlockStack gap="200">
            <Text variant="headingMd" as="h2">Next gate</Text>
            <Text as="p">
              Order import remains unavailable until durable external-ID idempotency, an explicit
              UTC watermark, single-writer proof, reconciliation, rollback, and a separately
              authorized cutover are all evidenced.
            </Text>
          </BlockStack>
        </Card>
      </BlockStack>
    </Page>
  );
};

export default Orders;
