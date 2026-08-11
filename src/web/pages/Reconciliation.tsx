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
import { formatEvidenceTime, normalizeEvidenceSources, normalizeResponsibilityEvidence } from '../evidence';
import {
  humanize,
  MigrationSafetyBanner,
  OwnershipCards,
} from '../components/MigrationSafety';
import {
  EvidenceSourceCards,
  ResponsibilityEvidenceCards,
} from '../components/EvidenceProjection';

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
  const sourceEvidence = normalizeEvidenceSources(status);
  const responsibilityEvidence = normalizeResponsibilityEvidence(status);
  const evidenceIncomplete =
    sourceEvidence.some((source) => source.critical) ||
    responsibilityEvidence.some((responsibility) => responsibility.critical);
  const watermark = status?.cutoverWatermarkUtc === undefined
    ? 'Unavailable'
    : status.cutoverWatermarkUtc === null
      ? 'Not established'
      : status.cutoverWatermarkUtc;
  const orderCreationEligible = reconciliation?.orderCreationEligible;

  return (
    <Page
      title="Reconciliation"
      subtitle="Read-only migration evidence and exceptions"
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
        <Banner
          tone={evidenceIncomplete ? 'critical' : 'warning'}
          title={evidenceIncomplete
            ? 'Authoritative cross-platform evidence is incomplete'
            : 'Source captures are supplied; parity still requires reconciliation'}
        >
          <Text as="p">
            This view performs no Shopify, eBay, Marketplace Connect, order, listing, price, or
            inventory write. Missing or partial source evidence blocks parity and cannot authorize a
            cutover.
          </Text>
        </Banner>

        <BlockStack gap="300">
          <InlineStack align="space-between" blockAlign="center">
            <Text variant="headingMd" as="h2">Accepted ownership policy</Text>
            <Badge tone="attention">Not observation evidence</Badge>
          </InlineStack>
          {statusQuery.isLoading ? <SkeletonBodyText lines={4} /> : <OwnershipCards status={status} />}
        </BlockStack>

        <EvidenceSourceCards status={status} />

        <ResponsibilityEvidenceCards status={status} />

        <BlockStack gap="300">
          <InlineStack align="space-between" blockAlign="center">
            <Text variant="headingMd" as="h2">Legacy local ledger counts</Text>
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
            Response served: {formatEvidenceTime(status?.servedAt)}. Response generation time is not
            source capture time.
          </Text>
        </BlockStack>

        <Card>
          <BlockStack gap="300">
            <InlineStack align="space-between" blockAlign="center">
              <Text variant="headingMd" as="h2">Cutover gates</Text>
              <Badge tone="critical">Blocked</Badge>
            </InlineStack>
            <InlineStack align="space-between" blockAlign="center" gap="300">
              <Text as="span">Explicit UTC watermark</Text>
              <Badge tone="critical">{watermark}</Badge>
            </InlineStack>
            <InlineStack align="space-between" blockAlign="center" gap="300">
              <Text as="span">Orders eligible for ProductPipeline creation</Text>
              <Badge tone={orderCreationEligible === false ? 'success' : 'critical'}>
                {orderCreationEligible === false ? '0' : 'Unavailable'}
              </Badge>
            </InlineStack>
          </BlockStack>
        </Card>

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
              <Badge tone={audit?.valid ? 'success' : 'critical'}>
                {audit?.valid ? 'Chain verified' : 'CLI verification required'}
              </Badge>
            </InlineStack>
            <Text as="p" tone="subdued">
              Records: {typeof audit?.recordCount === 'number' ? audit.recordCount : 'Not supplied'}
            </Text>
            <Text as="p" tone="subdued">Verified: {formatEvidenceTime(audit?.verifiedAt)}</Text>
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
