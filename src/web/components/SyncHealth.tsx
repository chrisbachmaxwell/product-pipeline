import React, { useState } from 'react';
import {
  Badge,
  BlockStack,
  Button,
  Card,
  Collapsible,
  InlineStack,
  Text,
} from '@shopify/polaris';
import { useOperationalMonitoring } from '../hooks/useApi';

const Row: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <InlineStack align="space-between" blockAlign="center">
    <Text as="span">{label}</Text>
    {children}
  </InlineStack>
);

/**
 * The system's health in operator words. The raw counters exist behind a
 * collapsible for debugging conversations; nothing on the surface uses
 * internal vocabulary, digests, or milestone codes.
 */
export const SyncHealth: React.FC = () => {
  const monitoring = useOperationalMonitoring();
  const [showDetails, setShowDetails] = useState(false);
  const data = monitoring.data;
  if (monitoring.isLoading || !data) return null;

  const catalog = data.health.catalogRead;
  const store = data.health.migrationStore === 'verified' && data.health.auditChain === 'verified';
  const writes = data.dailyDigest.writes;
  const shadow = data.dailyDigest.shadow;

  return (
    <Card>
      <BlockStack gap="300">
        <Text as="h3" variant="headingMd">Sync health</Text>
        <Row label="eBay connection">
          {catalog === 'current'
            ? <Badge tone="success">Live</Badge>
            : catalog === 'pending'
              ? <Badge tone="attention">Refreshing</Badge>
              : <Badge tone="critical">Trouble reading eBay</Badge>}
        </Row>
        <Row label="Change history">
          {store ? <Badge tone="success">Intact</Badge> : <Badge tone="attention">Being verified</Badge>}
        </Row>
        {writes.performed > 0 && (
          <Row label="Updates sent to eBay (last day)">
            <Text as="span">
              {writes.succeeded} of {writes.performed} confirmed
              {writes.unresolved > 0 ? ` · ${writes.unresolved} still confirming` : ''}
            </Text>
          </Row>
        )}
        {shadow.observedCount > 0 && (
          <Row label="eBay orders in Shopify">
            <Text as="span">{shadow.matchedCount} of {shadow.observedCount} confirmed</Text>
          </Row>
        )}
        <Button
          variant="plain"
          onClick={() => setShowDetails((current) => !current)}
          ariaExpanded={showDetails}
          ariaControls="sync-health-details"
        >
          {showDetails ? 'Hide technical details' : 'Technical details'}
        </Button>
        <Collapsible id="sync-health-details" open={showDetails}>
          <BlockStack gap="100">
            <Text as="p" variant="bodySm" tone="subdued">
              status {data.status} · unresolved jobs {data.counters.unresolvedJobs} ·
              failed jobs {data.counters.failedJobs} · reconciliation exceptions{' '}
              {data.counters.reconciliationExceptions} · catalog read failures{' '}
              {data.counters.catalogReadFailures} · shadow unmatched{' '}
              {data.counters.shadowUnmatchedOrders} · blocked {data.counters.shadowBlockedOrders}
            </Text>
            <Text as="p" variant="bodySm" tone="subdued">
              digest window {data.dailyDigest.dateUtc ?? '—'} · generated {data.generatedAtUtc}
            </Text>
          </BlockStack>
        </Collapsible>
      </BlockStack>
    </Card>
  );
};

export default SyncHealth;
