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
import { DurableMigrationState } from '../components/DurableMigrationState';
import { booleanPolicyState } from '../evidence';

const Metric: React.FC<{ label: string; value: number | string }> = ({ label, value }) => (
  <Card>
    <BlockStack gap="100">
      <Text as="p" tone="subdued">{label}</Text>
      <Text variant="headingLg" as="p">{typeof value === 'number' ? value.toLocaleString() : value}</Text>
    </BlockStack>
  </Card>
);

const PolicyRow: React.FC<{
  label: string;
  value: string;
  tone?: 'success' | 'warning' | 'critical' | 'attention' | 'info';
}> = ({
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
  const writerPolicy = booleanPolicyState(
    status?.externalWritesAllowed,
    { safe: 'Hard-disabled', unsafe: 'Allowed' },
  );
  const backfillPolicy = booleanPolicyState(
    status?.historicalBackfillAllowed,
    { safe: 'Blocked', unsafe: 'Allowed' },
  );
  const watermark = status?.cutoverWatermarkUtc === undefined
    ? 'Unavailable'
    : status.cutoverWatermarkUtc === null
      ? 'Not established'
      : status.cutoverWatermarkUtc;
  const orderCreationEligible = status?.reconciliation?.orderCreationEligible;
  const localCount = (key: string) =>
    typeof counts[key] === 'number' ? counts[key] : 'Not supplied';

  return (
    <Page
      title="Orders"
      subtitle="Observation-only migration state"
      primaryAction={{
        content: 'Refresh evidence',
        onAction: () => { void statusQuery.refetch(); },
        loading: statusQuery.isFetching,
      }}
      fullWidth
    >
      <BlockStack gap="500">
        <MigrationSafetyBanner
          status={status}
          error={statusQuery.error instanceof Error ? statusQuery.error : null}
        />
        <Banner tone="critical" title="Order ownership policy is accepted; current parity is not proven">
          <BlockStack gap="100">
            <Text as="p">
              Marketplace Connect is the accepted sole production order importer and was
              browser-observed importing eBay orders on 2026-08-11. That historical observation is
              not a current authoritative parity snapshot. Fulfillment and feedback ownership are
              also unverified.
            </Text>
            <Text as="p" tone="subdued">
              ProductPipeline order ingestion and Shopify-order creation are hard-disabled. No
              customer or order payload is exposed by this shadow-mode screen.
            </Text>
          </BlockStack>
        </Banner>

        <DurableMigrationState status={status} compact="orders" />

        {statusQuery.isLoading ? (
          <SkeletonBodyText lines={6} />
        ) : (
          <InlineGrid columns={{ xs: 1, sm: 2, md: 4 }} gap="300">
            <Metric label="Historical local eBay records" value={localCount('historicalEbayOrders')} />
            <Metric label="Historical records ineligible" value={localCount('historicalOrdersIneligible')} />
            <Metric label="Local order mappings" value={localCount('orderMappings')} />
            <Metric
              label="Eligible for ProductPipeline creation"
              value={orderCreationEligible === false ? 0 : 'Unavailable'}
            />
          </InlineGrid>
        )}

        <Card>
          <BlockStack gap="300">
            <InlineStack align="space-between" blockAlign="center">
              <Text variant="headingMd" as="h2">Effective order policy</Text>
              <Badge tone="info">Read-only</Badge>
            </InlineStack>
            <Divider />
            <PolicyRow label="Accepted production importer policy" value="Marketplace Connect" tone="attention" />
            <Divider />
            <PolicyRow label="Baseline observation" value="2026-08-11 (date-only)" tone="critical" />
            <Divider />
            <PolicyRow
              label="ProductPipeline external writers"
              value={writerPolicy.label}
              tone={writerPolicy.tone}
            />
            <Divider />
            <PolicyRow label="Historical backfill" value={backfillPolicy.label} tone={backfillPolicy.tone} />
            <Divider />
            <PolicyRow label="Cutover watermark" value={watermark} tone="critical" />
            <Divider />
            <PolicyRow label="Production parity" value="Not verified" tone="critical" />
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
