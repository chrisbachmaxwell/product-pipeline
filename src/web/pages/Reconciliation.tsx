import React, { useMemo } from 'react';
import {
  Badge,
  Banner,
  BlockStack,
  Card,
  InlineGrid,
  InlineStack,
  Page,
  SkeletonBodyText,
  Text,
} from '@shopify/polaris';
import { useMigrationStatus } from '../hooks/useApi';
import {
  humanize,
  MigrationSafetyBanner,
  OwnershipCards,
} from '../components/MigrationSafety';

const formatTimestamp = (value?: string | null) => {
  if (!value) return 'Not available';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Not available' : date.toLocaleString();
};

const Reconciliation: React.FC = () => {
  const statusQuery = useMigrationStatus();
  const status = statusQuery.data;
  const reconciliation = status?.reconciliation;
  const counts = useMemo(
    () => Object.entries(reconciliation?.counts ?? {}).filter((entry): entry is [string, number] => typeof entry[1] === 'number'),
    [reconciliation?.counts],
  );
  const exceptions = reconciliation?.exceptions ?? [];
  const audit = reconciliation?.audit;

  return (
    <Page
      title="Reconciliation"
      subtitle="Read-only migration evidence and exceptions"
      primaryAction={{
        content: 'Refresh local evidence',
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
        <Banner tone="info" title="Evidence is limited to the local ProductPipeline ledger">
          <Text as="p">
            This view performs no Shopify, eBay, Marketplace Connect, order, listing, price, or
            inventory write. Local agreement does not establish remote parity or authorize a cutover.
          </Text>
        </Banner>

        <BlockStack gap="300">
          <InlineStack align="space-between" blockAlign="center">
            <Text variant="headingMd" as="h2">Responsibility baseline</Text>
            <Badge tone="attention">Marketplace Connect incumbent</Badge>
          </InlineStack>
          {statusQuery.isLoading ? <SkeletonBodyText lines={4} /> : <OwnershipCards status={status} />}
        </BlockStack>

        <BlockStack gap="300">
          <InlineStack align="space-between" blockAlign="center">
            <Text variant="headingMd" as="h2">Local evidence</Text>
            <Badge tone="info">{humanize(reconciliation?.scope ?? 'local-ledger')}</Badge>
          </InlineStack>
          {counts.length > 0 ? (
            <InlineGrid columns={{ xs: 1, sm: 2, md: 4 }} gap="300">
              {counts.map(([key, value]) => (
                <Card key={key}>
                  <BlockStack gap="100">
                    <Text as="p" tone="subdued">{humanize(key)}</Text>
                    <Text variant="headingLg" as="p">{value.toLocaleString()}</Text>
                  </BlockStack>
                </Card>
              ))}
            </InlineGrid>
          ) : (
            <Card>
              <Text as="p" tone="subdued">No local reconciliation counts are available.</Text>
            </Card>
          )}
          <Text as="p" variant="bodySm" tone="subdued">
            Observed: {formatTimestamp(reconciliation?.observedAt ?? reconciliation?.generatedAt ?? status?.observedAt)}
          </Text>
        </BlockStack>

        <Card>
          <BlockStack gap="300">
            <InlineStack align="space-between" blockAlign="center">
              <Text variant="headingMd" as="h2">Exceptions</Text>
              <Badge tone={exceptions.length > 0 ? 'warning' : 'info'}>{String(exceptions.length)}</Badge>
            </InlineStack>
            {exceptions.length === 0 ? (
              <Text as="p" tone="subdued">
                No local exceptions were reported. This is not a claim of cross-platform parity.
              </Text>
            ) : (
              <BlockStack gap="200">
                {exceptions.map((exception, index) => (
                  <Card key={exception.id ?? index}>
                    <BlockStack gap="100">
                      <InlineStack align="space-between" blockAlign="center">
                        <Text as="p" fontWeight="semibold">
                          {exception.message ?? exception.code ?? exception.id ?? `Exception ${index + 1}`}
                        </Text>
                        <Badge tone={exception.severity === 'critical' ? 'critical' : 'warning'}>
                          {humanize(exception.severity ?? 'warning')}
                        </Badge>
                      </InlineStack>
                      {(exception.detail || exception.setting) && (
                        <Text as="p" tone="subdued">
                          {exception.detail ?? `${exception.setting}: observed ${String(exception.observed ?? 'unset')}; expected ${String(exception.expected ?? 'unset')}. Effective behavior remains ${exception.effectiveBehavior ?? 'quarantined'}.`}
                        </Text>
                      )}
                    </BlockStack>
                  </Card>
                ))}
              </BlockStack>
            )}
          </BlockStack>
        </Card>

        <Card>
          <BlockStack gap="200">
            <InlineStack align="space-between" blockAlign="center">
              <Text variant="headingMd" as="h2">Audit evidence</Text>
              <Badge tone={audit?.valid ? 'success' : 'warning'}>
                {audit?.valid ? 'Chain verified' : 'CLI verification required'}
              </Badge>
            </InlineStack>
            <Text as="p" tone="subdued">Records: {audit?.recordCount ?? 0}</Text>
            <Text as="p" tone="subdued">Verified: {formatTimestamp(audit?.verifiedAt)}</Text>
            <Text as="p" tone="subdued" breakWord>
              Head: {audit?.headHash ?? 'No audit head available'}
            </Text>
            {audit?.note && <Text as="p" tone="subdued">{audit.note}</Text>}
          </BlockStack>
        </Card>
      </BlockStack>
    </Page>
  );
};

export default Reconciliation;
