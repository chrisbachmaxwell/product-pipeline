import React from 'react';
import {
  Badge,
  Banner,
  BlockStack,
  Card,
  Divider,
  InlineStack,
  Layout,
  Page,
  SkeletonBodyText,
  Text,
} from '@shopify/polaris';
import { useMigrationStatus } from '../hooks/useApi';
import { booleanPolicyState, formatEvidenceTime } from '../evidence';
import {
  humanize,
  MigrationSafetyBanner,
  OwnershipCards,
} from '../components/MigrationSafety';
import { DurableMigrationState } from '../components/DurableMigrationState';

const SafetyRow: React.FC<{
  label: string;
  value: string;
  tone: 'success' | 'critical' | 'warning' | 'attention' | 'info';
}> = ({ label, value, tone }) => (
  <InlineStack align="space-between" blockAlign="center" gap="300">
    <Text as="span">{label}</Text>
    <Badge tone={tone}>{value}</Badge>
  </InlineStack>
);

const Settings: React.FC = () => {
  const statusQuery = useMigrationStatus();
  const status = statusQuery.data;
  const externalWrites = booleanPolicyState(
    status?.externalWritesAllowed,
    { safe: 'Blocked', unsafe: 'Allowed' },
  );
  const historicalBackfill = booleanPolicyState(
    status?.historicalBackfillAllowed,
    { safe: 'Blocked', unsafe: 'Allowed' },
  );
  const watermark = status?.cutoverWatermarkUtc === undefined
    ? 'Unavailable'
    : status.cutoverWatermarkUtc === null
      ? 'Not established'
      : status.cutoverWatermarkUtc;
  const remoteParity = status?.remoteVerification === undefined
    ? 'Unavailable'
    : status.remoteVerification === 'not-performed'
      ? 'Not performed'
      : humanize(status.remoteVerification);

  return (
    <Page
      title="Settings"
      subtitle="Read-only migration policy and ownership"
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
        <Banner tone="info" title="Operational settings are locked during shadow mode">
          <Text as="p">
            Connection changes, sync toggles, price and inventory settings, order-import controls,
            AI prompts, pipeline automation, and bulk actions are not available here. A future
            ownership change requires reviewed parity evidence and a separately approved cutover.
          </Text>
        </Banner>

        <DurableMigrationState status={status} />

        <Layout>
          <Layout.AnnotatedSection
            title="Responsibility ownership"
            description="The effective owner and ProductPipeline access for each integration responsibility."
          >
            {statusQuery.isLoading ? <SkeletonBodyText lines={8} /> : <OwnershipCards status={status} includeAll />}
          </Layout.AnnotatedSection>

          <Layout.AnnotatedSection
            title="Safety policy"
            description="Server-enforced effective state, not editable database preferences."
          >
            <Card>
              <BlockStack gap="300">
                <SafetyRow
                  label="ProductPipeline external writes"
                  value={externalWrites.label}
                  tone={externalWrites.tone}
                />
                <Divider />
                <SafetyRow
                  label="Historical order backfill"
                  value={historicalBackfill.label}
                  tone={historicalBackfill.tone}
                />
                <Divider />
                <SafetyRow
                  label="Order cutover watermark"
                  value={watermark}
                  tone="critical"
                />
                <Divider />
                <SafetyRow
                  label="Remote parity proof"
                  value={remoteParity}
                  tone="critical"
                />
              </BlockStack>
            </Card>
          </Layout.AnnotatedSection>

          <Layout.AnnotatedSection
            title="Connections"
            description="Authentication material is never shown on this page."
          >
            <Card>
              <BlockStack gap="300">
                <Text as="p">
                  This status endpoint does not test Shopify, eBay, or Marketplace Connect
                  connectivity. Stored-token presence is not presented as a successful connection.
                </Text>
                <InlineStack gap="200" blockAlign="center">
                  <Text as="span">Remote verification</Text>
                  <Badge tone="critical">{remoteParity}</Badge>
                </InlineStack>
                <Text as="p" tone="subdued">
                  Response served: {formatEvidenceTime(status?.servedAt)}
                </Text>
                <Text as="p" tone="subdued">
                  No token, secret, scope, customer payload, or credential value is returned to the browser.
                </Text>
              </BlockStack>
            </Card>
          </Layout.AnnotatedSection>

          <Layout.AnnotatedSection
            title="Quarantine coverage"
            description="Every listed channel is denied before it can reach a commerce writer."
          >
            <Card>
              <BlockStack gap="300">
                <InlineStack gap="200" blockAlign="center">
                  <Text as="span">Enforcement</Text>
                  <Badge tone={status?.quarantine?.enabled ? 'success' : 'critical'}>
                    {status?.quarantine?.enabled ? 'Enabled' : 'Unavailable'}
                  </Badge>
                </InlineStack>
                <Divider />
                <InlineStack gap="200" wrap>
                  {(status?.quarantine?.channels ?? []).map((channel) => (
                    <Badge key={channel} tone="info">{humanize(channel)}</Badge>
                  ))}
                  {!status?.quarantine?.channels?.length && (
                    <Text as="p" tone="critical">No channel evidence is available.</Text>
                  )}
                </InlineStack>
              </BlockStack>
            </Card>
          </Layout.AnnotatedSection>
        </Layout>
      </BlockStack>
    </Page>
  );
};

export default Settings;
