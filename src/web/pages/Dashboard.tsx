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
import { useMigrationStatus } from '../hooks/useApi';
import { formatEvidenceTime, normalizeEvidenceSources } from '../evidence';
import {
  humanize,
  MigrationSafetyBanner,
  OwnershipCards,
} from '../components/MigrationSafety';
import { DurableMigrationState } from '../components/DurableMigrationState';

const Dashboard: React.FC = () => {
  const statusQuery = useMigrationStatus();
  const { data: status, isLoading, error } = statusQuery;
  const exceptions = status?.reconciliation?.exceptions ?? [];
  const sources = normalizeEvidenceSources(status);
  const sourceEvidenceIncomplete = sources.some((source) => source.critical);

  return (
    <Page
      title="Overview"
      subtitle="Marketplace Connect replacement control plane"
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
          error={error instanceof Error ? error : null}
        />

        <BlockStack gap="300">
          <Text variant="headingMd" as="h2">Production responsibility</Text>
          {isLoading ? <SkeletonBodyText lines={4} /> : <OwnershipCards status={status} />}
        </BlockStack>

        <DurableMigrationState status={status} />

        <InlineGrid columns={{ xs: 1, sm: 2, md: 4 }} gap="300">
          <Card>
            <BlockStack gap="200">
              <Text as="p" tone="subdued">Migration phase</Text>
              <Badge tone={status?.phase ? 'attention' : 'critical'}>{humanize(status?.phase)}</Badge>
            </BlockStack>
          </Card>
          <Card>
            <BlockStack gap="200">
              <Text as="p" tone="subdued">Effective mode</Text>
              <Badge tone={status?.effectiveMode === 'shadow-read-only' ? 'success' : 'critical'}>
                {humanize(status?.effectiveMode)}
              </Badge>
            </BlockStack>
          </Card>
          <Card>
            <BlockStack gap="200">
              <Text as="p" tone="subdued">Remote parity</Text>
              <Badge tone="critical">
                {status?.remoteVerification === 'not-performed'
                  ? 'Not verified'
                  : humanize(status?.remoteVerification)}
              </Badge>
            </BlockStack>
          </Card>
          <Card>
            <BlockStack gap="200">
              <Text as="p" tone="subdued">Open exceptions</Text>
              <Text variant="headingLg" as="p">
                {status?.reconciliation?.exceptions ? exceptions.length : 'Unavailable'}
              </Text>
            </BlockStack>
          </Card>
        </InlineGrid>

        <Card>
          <BlockStack gap="300">
            <InlineStack align="space-between" blockAlign="center">
              <Text variant="headingMd" as="h2">Evidence boundary</Text>
              <Badge tone={sourceEvidenceIncomplete ? 'critical' : 'attention'}>
                {sourceEvidenceIncomplete ? 'Authoritative sources incomplete' : 'Source captures supplied'}
              </Badge>
            </InlineStack>
            <Text as="p">
              This screen reports the enforced ProductPipeline policy and local reconciliation
              evidence. It does not prove current Shopify, eBay, or Marketplace Connect parity.
            </Text>
            <Text as="p" tone="subdued">
              Response served: {formatEvidenceTime(status?.servedAt)}
            </Text>
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
