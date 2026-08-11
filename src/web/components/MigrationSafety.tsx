import React from 'react';
import {
  Badge,
  Banner,
  BlockStack,
  Card,
  InlineGrid,
  InlineStack,
  Text,
} from '@shopify/polaris';
import type {
  MigrationResponsibilityStatus,
  MigrationStatusResponse,
} from '../hooks/useApi';

const BASELINE_RESPONSIBILITIES = ['orderImport', 'price', 'inventory'] as const;

const LABELS: Record<string, string> = {
  orderImport: 'eBay → Shopify orders',
  price: 'Price sync',
  inventory: 'Inventory sync',
};

export const humanize = (value: string) =>
  value
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[-_]/g, ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase());

export const responsibilityLabel = (responsibility: string) =>
  LABELS[responsibility] ?? humanize(responsibility);

export const findResponsibility = (
  status: MigrationStatusResponse | undefined,
  responsibility: string,
): MigrationResponsibilityStatus | undefined =>
  status?.responsibilities?.find((item) => item.responsibility === responsibility);

export const MigrationSafetyBanner: React.FC<{
  status?: MigrationStatusResponse;
  error?: Error | null;
}> = ({ status, error }) => {
  const baselineOwnershipVerified = BASELINE_RESPONSIBILITIES.every((responsibility) => {
    const item = findResponsibility(status, responsibility);
    return item?.owner === 'marketplace-connect' && item.writesAllowed !== true;
  });
  const safelyQuarantined =
    status?.quarantine?.enabled === true &&
    status.externalWritesAllowed === false &&
    baselineOwnershipVerified;

  if (!status || error) {
    return (
      <Banner tone="critical" title="Migration safety state unavailable">
        <Text as="p">
          ProductPipeline remains observation-only. No write action is available while the enforced
          ownership state cannot be displayed.
        </Text>
      </Banner>
    );
  }

  return (
    <Banner
      tone={safelyQuarantined ? 'success' : 'critical'}
      title={safelyQuarantined
        ? 'Shadow mode — ProductPipeline writers are quarantined'
        : 'Writer quarantine is not verified'}
    >
      <BlockStack gap="100">
        <Text as="p">
          {baselineOwnershipVerified
            ? 'Marketplace Connect remains the production owner for orders, price, and inventory. ProductPipeline is read-only and cannot perform those writes.'
            : 'The required Marketplace Connect ownership baseline is unavailable or inconsistent. ProductPipeline remains observation-only.'}
        </Text>
        <Text as="p" tone="subdued">
          Historical order backfill: {status.historicalBackfillAllowed ? 'allowed' : 'blocked'} ·
          Cutover watermark: {status.cutoverWatermarkUtc ?? 'not established'} · Remote parity:{' '}
          {status.remoteVerification === 'not-performed' ? 'not verified' : humanize(status.remoteVerification)}
        </Text>
      </BlockStack>
    </Banner>
  );
};

export const OwnershipCards: React.FC<{
  status?: MigrationStatusResponse;
  includeAll?: boolean;
}> = ({ status, includeAll = false }) => {
  const responsibilities = includeAll
    ? status?.responsibilities ?? []
    : BASELINE_RESPONSIBILITIES.map((key) => findResponsibility(status, key)).filter(
        (item): item is MigrationResponsibilityStatus => Boolean(item),
      );

  if (responsibilities.length === 0) {
    return (
      <Card>
        <Text as="p" tone="critical">Ownership data is unavailable; ProductPipeline remains read-only.</Text>
      </Card>
    );
  }

  return (
    <InlineGrid columns={{ xs: 1, sm: 3 }} gap="300">
      {responsibilities.map((item) => (
        <Card key={item.responsibility}>
          <BlockStack gap="200">
            <Text variant="headingSm" as="h3">{responsibilityLabel(item.responsibility)}</Text>
            <InlineStack gap="200" blockAlign="center">
              <Text as="span" tone="subdued">Owner</Text>
              <Badge tone={item.owner === 'marketplace-connect' ? 'success' : 'warning'}>
                {item.owner === 'marketplace-connect' ? 'Marketplace Connect' : humanize(item.owner)}
              </Badge>
            </InlineStack>
            <InlineStack gap="200" blockAlign="center">
              <Text as="span" tone="subdued">ProductPipeline</Text>
              <Badge tone="info">{humanize(item.productPipelineAccess)}</Badge>
            </InlineStack>
          </BlockStack>
        </Card>
      ))}
    </InlineGrid>
  );
};
