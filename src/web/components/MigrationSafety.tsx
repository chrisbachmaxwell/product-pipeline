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
import { booleanPolicyState } from '../evidence';
import { MIGRATION_RESPONSIBILITIES } from '../../safety/responsibilities.js';
import type {
  MigrationResponsibilityStatus,
  MigrationStatusResponse,
} from '../hooks/useApi';

const BASELINE_RESPONSIBILITIES = ['orderImport', 'price', 'inventory'] as const;
const ALL_RESPONSIBILITIES = MIGRATION_RESPONSIBILITIES;

const LABELS: Record<string, string> = {
  orderImport: 'eBay → Shopify orders',
  price: 'Price sync',
  inventory: 'Inventory sync',
  listingCreate: 'Listing creation',
  listingRevise: 'Listing revision',
  listingEndRelist: 'Listing end / relist',
  mapping: 'Listing mapping',
  fulfillment: 'Fulfillment',
  feedback: 'Buyer feedback',
  reconciliation: 'Reconciliation',
};

export const humanize = (value: string | null | undefined) => {
  if (!value) return 'Unavailable';
  return value
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[-_]/g, ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
};

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
  const baselinePolicyAccepted = BASELINE_RESPONSIBILITIES.every((responsibility) => {
    const item = findResponsibility(status, responsibility);
    return (
      item?.owner === 'marketplace-connect' &&
      item.writesAllowed === false &&
      ['disabled', 'read-only'].includes(item.productPipelineAccess)
    );
  });
  const safelyQuarantined =
    status?.quarantine?.enabled === true &&
    Boolean(status.quarantine.channels?.length) &&
    status.externalWritesAllowed === false &&
    status.historicalBackfillAllowed === false &&
    status.cutoverWatermarkUtc === null &&
    baselinePolicyAccepted;

  if (!status || error) {
    return (
      <Banner tone="critical" title="Migration safety state unavailable">
        <Text as="p">
          ProductPipeline remains observation-only. No write action is available while the enforced
          ownership policy cannot be displayed.
        </Text>
      </Banner>
    );
  }

  const backfill = booleanPolicyState(
    status.historicalBackfillAllowed,
    { safe: 'blocked', unsafe: 'allowed' },
  );
  const watermark = status.cutoverWatermarkUtc === undefined
    ? 'unavailable'
    : status.cutoverWatermarkUtc === null
      ? 'not established'
      : status.cutoverWatermarkUtc;
  const remoteParity = status.remoteVerification === undefined
    ? 'unavailable'
    : status.remoteVerification === 'not-performed'
      ? 'not verified'
      : humanize(status.remoteVerification).toLowerCase();

  return (
    <Banner
      tone={safelyQuarantined ? 'success' : 'critical'}
      title={safelyQuarantined
        ? 'Shadow mode — ProductPipeline writers are quarantined'
        : 'Writer quarantine is not verified'}
    >
      <BlockStack gap="100">
        <Text as="p">
          {baselinePolicyAccepted
            ? 'Accepted ownership policy assigns orders, price, and inventory to Marketplace Connect. This is policy, not current cross-platform parity evidence.'
            : 'The required Marketplace Connect ownership policy is unavailable or inconsistent. ProductPipeline remains observation-only.'}
        </Text>
        <Text as="p" tone="subdued">
          Historical order backfill: {backfill.label.toLowerCase()} · Cutover watermark: {watermark} ·
          Remote parity: {remoteParity}
        </Text>
      </BlockStack>
    </Banner>
  );
};

export const OwnershipCards: React.FC<{
  status?: MigrationStatusResponse;
  includeAll?: boolean;
}> = ({ status, includeAll = false }) => {
  const keys = includeAll ? ALL_RESPONSIBILITIES : BASELINE_RESPONSIBILITIES;

  return (
    <InlineGrid columns={{ xs: 1, sm: 3 }} gap="300">
      {keys.map((responsibility) => {
        const item = findResponsibility(status, responsibility);
        const owner = item?.owner;
        const access = item?.productPipelineAccess;
        return (
          <Card key={responsibility}>
            <BlockStack gap="200">
              <Text variant="headingSm" as="h3">{responsibilityLabel(responsibility)}</Text>
              <InlineStack gap="200" blockAlign="center">
                <Text as="span" tone="subdued">Accepted policy owner</Text>
                <Badge tone={owner === 'marketplace-connect' ? 'attention' : 'critical'}>
                  {owner === 'marketplace-connect' ? 'Marketplace Connect' : humanize(owner ?? 'unverified')}
                </Badge>
              </InlineStack>
              <InlineStack gap="200" blockAlign="center">
                <Text as="span" tone="subdued">ProductPipeline policy</Text>
                <Badge tone={access ? 'info' : 'critical'}>{humanize(access)}</Badge>
              </InlineStack>
              <InlineStack gap="200" blockAlign="center">
                <Text as="span" tone="subdued">Writes</Text>
                <Badge tone={item?.writesAllowed === false ? 'success' : 'critical'}>
                  {item?.writesAllowed === false
                    ? 'Blocked'
                    : item?.writesAllowed === true
                      ? 'Allowed'
                      : 'Unavailable'}
                </Badge>
              </InlineStack>
            </BlockStack>
          </Card>
        );
      })}
    </InlineGrid>
  );
};
