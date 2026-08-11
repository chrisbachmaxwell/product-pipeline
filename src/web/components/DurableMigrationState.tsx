import React from 'react';
import {
  Badge,
  BlockStack,
  Card,
  InlineGrid,
  InlineStack,
  Text,
} from '@shopify/polaris';
import type { MigrationStatusResponse } from '../hooks/useApi';
import { durableMigrationStateView } from '../migration-state';
import { humanize } from './MigrationSafety';

const count = (counts: Record<string, number>, key: string) => counts[key] ?? 0;

const CountMetric: React.FC<{ label: string; value: number }> = ({ label, value }) => (
  <Card>
    <BlockStack gap="100">
      <Text as="p" tone="subdued">{label}</Text>
      <Text variant="headingMd" as="p">{value.toLocaleString()}</Text>
    </BlockStack>
  </Card>
);

export const DurableMigrationState: React.FC<{
  status?: MigrationStatusResponse;
  compact?: 'listings' | 'orders';
}> = ({ status, compact }) => {
  const state = status?.migrationState;
  const view = durableMigrationStateView(status);
  const scope = view.locallyVerified ? state?.scope : null;
  const audit = view.locallyVerified ? state?.audit : null;
  const counts = view.counts;

  if (compact) {
    const relevantCounts = compact === 'listings'
      ? [
          ['External identities', count(counts, 'externalIdentities')],
          ['Ownership versions', count(counts, 'ownershipVersions')],
          ['Reconciliation runs', count(counts, 'reconciliationRuns')],
        ] as const
      : [
          ['Order observations', count(counts, 'orderObservations')],
          ['Order links', count(counts, 'orderLinks')],
          ['Eligible for creation', view.eligibleOrderCount],
        ] as const;

    return (
      <Card>
        <BlockStack gap="300">
          <InlineStack align="space-between" blockAlign="center">
            <Text variant="headingMd" as="h2">Local durable state</Text>
            <Badge tone={view.available ? 'info' : 'critical'}>{view.statusLabel}</Badge>
          </InlineStack>
          <Text as="p" tone="subdued">
            These are inert local control-plane counts, not current Shopify, eBay, or Marketplace
            Connect records and not production parity proof.
          </Text>
          <InlineGrid columns={{ xs: 1, sm: 3 }} gap="300">
            {relevantCounts.map(([label, value]) => (
              <CountMetric key={label} label={label} value={value} />
            ))}
          </InlineGrid>
        </BlockStack>
      </Card>
    );
  }

  const blockerCount = Array.isArray(state?.readiness?.blockers)
    ? state.readiness.blockers.length
    : 1;

  return (
    <Card>
      <BlockStack gap="300">
        <InlineStack align="space-between" blockAlign="center">
          <Text variant="headingMd" as="h2">Local durable migration state</Text>
          <Badge tone={view.available ? 'info' : 'critical'}>{view.statusLabel}</Badge>
        </InlineStack>
        <Text as="p">
          This is ProductPipeline's inert local control-plane state. It is not authoritative
          Shopify, eBay, or Marketplace Connect truth and cannot authorize a canary or cutover.
        </Text>

        {scope ? (
          <BlockStack gap="100">
            <Text as="p" tone="subdued">
              Shopify scope: {scope.shopifyStoreDomain ?? 'Unavailable'}
            </Text>
            <Text as="p" tone="subdued">
              eBay scope: {scope.ebayEnvironment ?? 'Unavailable'} · {scope.ebayMarketplaceId ?? 'Unavailable'}
            </Text>
          </BlockStack>
        ) : (
          <Text as="p" tone="critical">
            No verified local durable scope is available. ProductPipeline remains fail-closed.
          </Text>
        )}

        <InlineGrid columns={{ xs: 1, sm: 2, md: 4 }} gap="300">
          <CountMetric label="External identities" value={count(counts, 'externalIdentities')} />
          <CountMetric label="Order observations" value={count(counts, 'orderObservations')} />
          <CountMetric label="Reconciliation runs" value={count(counts, 'reconciliationRuns')} />
          <CountMetric label="Audit records" value={audit?.recordCount ?? 0} />
        </InlineGrid>

        <InlineGrid columns={{ xs: 1, sm: 2, md: 4 }} gap="300">
          <InlineStack gap="200" blockAlign="center">
            <Text as="span">Audit chain</Text>
            <Badge tone={audit?.valid === true ? 'info' : 'critical'}>
              {audit?.valid === true ? 'Locally verified' : 'Unavailable'}
            </Badge>
          </InlineStack>
          <InlineStack gap="200" blockAlign="center">
            <Text as="span">Eligible orders</Text>
            <Badge tone="info">0</Badge>
          </InlineStack>
          <InlineStack gap="200" blockAlign="center">
            <Text as="span">Canary authorized</Text>
            <Badge tone="critical">No</Badge>
          </InlineStack>
          <InlineStack gap="200" blockAlign="center">
            <Text as="span">Cutover authorized</Text>
            <Badge tone="critical">No</Badge>
          </InlineStack>
        </InlineGrid>

        <Text as="p" tone="subdued">
          {blockerCount.toLocaleString()} local readiness {blockerCount === 1 ? 'blocker' : 'blockers'} ·
          Schema {state?.schemaVersion ?? 'unavailable'} · {humanize(state?.status)}
        </Text>
      </BlockStack>
    </Card>
  );
};
