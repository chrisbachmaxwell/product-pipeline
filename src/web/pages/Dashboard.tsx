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
import { useNavigate } from 'react-router-dom';
import { useMigrationStatus } from '../hooks/useApi';
import {
  humanize,
  MigrationSafetyBanner,
  OwnershipCards,
} from '../components/MigrationSafety';

const formatObservedAt = (value?: string) => {
  if (!value) return 'Not available';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? 'Not available' : parsed.toLocaleString();
};

const Dashboard: React.FC = () => {
  const navigate = useNavigate();
  const { data: status, isLoading, error } = useMigrationStatus();
  const exceptions = status?.reconciliation?.exceptions ?? [];

  return (
    <Page
      title="Overview"
      subtitle="Marketplace Connect replacement control plane"
      primaryAction={{ content: 'View reconciliation', onAction: () => navigate('/reconciliation') }}
      fullWidth
    >
      <BlockStack gap="500">
        <MigrationSafetyBanner
          status={status}
          error={error instanceof Error ? error : null}
        />

        <BlockStack gap="300">
          <Text variant="headingMd" as="h2">Production responsibility</Text>
          {isLoading ? <SkeletonBodyText lines={4} /> : <OwnershipCards status={status} />}
        </BlockStack>

        <InlineGrid columns={{ xs: 1, sm: 2, md: 4 }} gap="300">
          <Card>
            <BlockStack gap="200">
              <Text as="p" tone="subdued">Migration phase</Text>
              <Badge tone="attention">{status ? humanize(status.phase) : 'Unavailable'}</Badge>
            </BlockStack>
          </Card>
          <Card>
            <BlockStack gap="200">
              <Text as="p" tone="subdued">Effective mode</Text>
              <Badge tone={status?.effectiveMode === 'shadow-read-only' ? 'success' : 'critical'}>
                {status ? humanize(status.effectiveMode) : 'Unavailable'}
              </Badge>
            </BlockStack>
          </Card>
          <Card>
            <BlockStack gap="200">
              <Text as="p" tone="subdued">Remote parity</Text>
              <Badge tone="warning">
                {status?.remoteVerification === 'not-performed'
                  ? 'Not verified'
                  : humanize(status?.remoteVerification ?? 'unknown')}
              </Badge>
            </BlockStack>
          </Card>
          <Card>
            <BlockStack gap="200">
              <Text as="p" tone="subdued">Open exceptions</Text>
              <Text variant="headingLg" as="p">{exceptions.length}</Text>
            </BlockStack>
          </Card>
        </InlineGrid>

        <Card>
          <BlockStack gap="300">
            <InlineStack align="space-between" blockAlign="center">
              <Text variant="headingMd" as="h2">Evidence boundary</Text>
              <Badge tone="info">Local observation only</Badge>
            </InlineStack>
            <Text as="p">
              This screen reports the enforced ProductPipeline policy and local reconciliation
              evidence. It does not prove current Shopify, eBay, or Marketplace Connect parity.
            </Text>
            <Text as="p" tone="subdued">Observed: {formatObservedAt(status?.observedAt)}</Text>
            <Text as="p" tone="subdued">
              Quarantined channels: {status?.quarantine?.channels?.length
                ? status.quarantine.channels.map(humanize).join(', ')
                : 'Not available'}
            </Text>
          </BlockStack>
        </Card>
      </BlockStack>
    </Page>
  );
};

export default Dashboard;
