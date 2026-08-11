import React from 'react';
import {
  Badge,
  BlockStack,
  Card,
  Divider,
  InlineGrid,
  InlineStack,
  Text,
} from '@shopify/polaris';
import {
  formatEvidenceTime,
  normalizeEvidenceSources,
  normalizeResponsibilityEvidence,
} from '../evidence';
import type { MigrationStatusResponse } from '../hooks/useApi';

const humanize = (value: string) =>
  value
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[-_]/g, ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase());

const EvidenceDetail: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <InlineStack align="space-between" blockAlign="start" gap="300" wrap={false}>
    <Text as="span" tone="subdued">{label}</Text>
    <Text as="span" alignment="end" breakWord>{value}</Text>
  </InlineStack>
);

const formatAsOf = (start: string | null, end: string | null) => {
  if (start && end) return `${formatEvidenceTime(start)} → ${formatEvidenceTime(end)}`;
  return formatEvidenceTime(end ?? start);
};

export const EvidenceSourceCards: React.FC<{ status?: MigrationStatusResponse }> = ({ status }) => {
  const sources = normalizeEvidenceSources(status);

  return (
    <BlockStack gap="300">
      <InlineStack align="space-between" blockAlign="center" gap="300">
        <Text variant="headingMd" as="h2">Source evidence</Text>
        <Badge tone={sources.some((source) => source.critical) ? 'critical' : 'success'}>
          {sources.some((source) => source.critical) ? 'Authoritative evidence incomplete' : 'Sources complete and fresh'}
        </Badge>
      </InlineStack>
      <Text as="p" tone="subdued">
        A complete source card proves only that source capture. It does not by itself prove
        cross-platform parity or authorize a cutover.
      </Text>
      <InlineGrid columns={{ xs: 1, sm: 2 }} gap="300">
        {sources.map((source) => {
          const counts = Object.entries(source.counts);
          return (
            <Card key={source.key}>
              <BlockStack gap="300">
                <InlineStack align="space-between" blockAlign="center" gap="300">
                  <Text variant="headingSm" as="h3">{source.label}</Text>
                  <Badge tone={source.critical ? 'critical' : 'success'}>
                    {humanize(source.status)}
                  </Badge>
                </InlineStack>
                <Divider />
                <EvidenceDetail label="Evidence class" value={humanize(source.evidenceClass)} />
                <EvidenceDetail label="Captured" value={formatEvidenceTime(source.capturedAt)} />
                <EvidenceDetail label="As-of window" value={formatAsOf(source.asOfStart, source.asOfEnd)} />
                <EvidenceDetail label="Completeness" value={humanize(source.completeness)} />
                <EvidenceDetail label="Freshness" value={humanize(source.freshness)} />
                <EvidenceDetail
                  label="Record count"
                  value={source.recordCount === null ? 'Not supplied' : source.recordCount.toLocaleString()}
                />
                {counts.length > 0 && (
                  <BlockStack gap="100">
                    <Text as="p" tone="subdued">Redacted counts</Text>
                    <InlineStack gap="200" wrap>
                      {counts.map(([key, value]) => (
                        <Badge key={key} tone="info">{`${humanize(key)}: ${value.toLocaleString()}`}</Badge>
                      ))}
                    </InlineStack>
                  </BlockStack>
                )}
                {source.digest && (
                  <BlockStack gap="050">
                    <Text as="p" tone="subdued">Evidence digest</Text>
                    <Text as="p" variant="bodySm" breakWord>{source.digest}</Text>
                  </BlockStack>
                )}
                {source.limitations.length > 0 && (
                  <BlockStack gap="100">
                    <Text as="p" tone="subdued">Limitations</Text>
                    {source.limitations.map((limitation) => (
                      <Text as="p" variant="bodySm" key={limitation}>• {limitation}</Text>
                    ))}
                  </BlockStack>
                )}
              </BlockStack>
            </Card>
          );
        })}
      </InlineGrid>
    </BlockStack>
  );
};

export const ResponsibilityEvidenceCards: React.FC<{ status?: MigrationStatusResponse }> = ({ status }) => {
  const responsibilities = normalizeResponsibilityEvidence(status);

  return (
    <BlockStack gap="300">
      <InlineStack align="space-between" blockAlign="center" gap="300">
        <Text variant="headingMd" as="h2">Responsibility evidence</Text>
        <Badge tone="critical">Current parity not established</Badge>
      </InlineStack>
      <Text as="p" tone="subdued">
        Accepted policy ownership and observed evidence are shown separately. Policy acceptance is
        not proof that the incumbent or ProductPipeline currently matches either platform.
      </Text>
      <InlineGrid columns={{ xs: 1, sm: 2 }} gap="300">
        {responsibilities.map((item) => (
          <Card key={item.responsibility}>
            <BlockStack gap="200">
              <InlineStack align="space-between" blockAlign="center" gap="300">
                <Text variant="headingSm" as="h3">{item.label}</Text>
                <Badge tone={item.critical ? 'critical' : 'success'}>{humanize(item.evidenceStatus)}</Badge>
              </InlineStack>
              <EvidenceDetail label="Accepted policy owner" value={humanize(item.acceptedOwner)} />
              <EvidenceDetail
                label="Evidence-reported owner"
                value={item.observedOwner ? humanize(item.observedOwner) : 'Not supplied'}
              />
              <EvidenceDetail label="Captured / as of" value={formatEvidenceTime(item.capturedAt)} />
              <Text as="p" variant="bodySm" tone="subdued">{item.summary}</Text>
            </BlockStack>
          </Card>
        ))}
      </InlineGrid>
    </BlockStack>
  );
};
