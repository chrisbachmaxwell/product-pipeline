import React from 'react';
import {
  Badge,
  Banner,
  BlockStack,
  Card,
  InlineGrid,
  InlineStack,
  SkeletonBodyText,
  Text,
} from '@shopify/polaris';
import { useOperationalMonitoring } from '../hooks/useApi';

const Count: React.FC<{ label: string; value: number }> = ({ label, value }) => (
  <Card>
    <BlockStack gap="100">
      <Text as="p" tone="subdued">{label}</Text>
      <Text as="p" variant="headingLg">{value.toLocaleString()}</Text>
    </BlockStack>
  </Card>
);

export const OperationalMonitoring: React.FC = () => {
  const query = useOperationalMonitoring();
  if (query.isLoading) return <Card><SkeletonBodyText lines={5} /></Card>;
  const monitor = query.data;
  if (query.error || !monitor || monitor.schemaVersion !== 1) {
    return (
      <Banner tone="critical" title="Operational monitoring unavailable">
        <Text as="p">The read-only operations digest could not be verified. No write is enabled.</Text>
      </Banner>
    );
  }
  const tone = monitor.status === 'green'
    ? 'success' as const
    : monitor.status === 'critical' ? 'critical' as const : 'warning' as const;
  return (
    <BlockStack gap="400">
      <Banner tone={tone} title={`Operations status: ${monitor.status}`}>
        <Text as="p">
          Read-only local monitoring. It performs no provider read or write and sends no message.
        </Text>
      </Banner>
      <InlineGrid columns={{ xs: 1, sm: 2, md: 3 }} gap="300">
        <Count label="Unresolved jobs" value={monitor.counters.unresolvedJobs} />
        <Count label="Confirmed missing jobs" value={monitor.counters.failedJobs} />
        <Count label="Reconciliation exceptions" value={monitor.counters.reconciliationExceptions} />
        <Count label="Unmatched shadow orders" value={monitor.counters.shadowUnmatchedOrders} />
        <Count label="Blocked shadow lookups" value={monitor.counters.shadowBlockedOrders} />
        <Count label="Catalog read failures" value={monitor.counters.catalogReadFailures} />
      </InlineGrid>
      <Card>
        <BlockStack gap="300">
          <InlineStack align="space-between" blockAlign="center">
            <Text as="h2" variant="headingMd">Daily operations digest</Text>
            <Badge tone={tone}>{monitor.dailyDigest.dateUtc ?? 'Unavailable'}</Badge>
          </InlineStack>
          <InlineGrid columns={{ xs: 2, md: 4 }} gap="300">
            <Count label="Writes performed" value={monitor.dailyDigest.writes.performed} />
            <Count label="Writes succeeded" value={monitor.dailyDigest.writes.succeeded} />
            <Count label="Writes failed" value={monitor.dailyDigest.writes.failed} />
            <Count label="Writes unresolved" value={monitor.dailyDigest.writes.unresolved} />
          </InlineGrid>
          <Text as="p" variant="bodySm" tone="subdued">
            Skipped-write counts are not journaled until the separately gated G18 workers exist.
            Digest {monitor.dailyDigest.digest}
          </Text>
        </BlockStack>
      </Card>
    </BlockStack>
  );
};
