import React, { useEffect, useState } from 'react';
import {
  Badge,
  Banner,
  BlockStack,
  Button,
  Card,
  Divider,
  InlineGrid,
  InlineStack,
  Spinner,
  Text,
} from '@shopify/polaris';
import type {
  ListingProposalField,
  ListingProposalResponse,
} from '../hooks/useListingProposal';

interface Props {
  response: ListingProposalResponse;
  canAdjust: boolean;
  generating: boolean;
  approving: boolean;
  generationFailed: boolean;
  approvalFailed: boolean;
  onGenerate: () => void;
  onApprove: () => void;
  onAdjust: () => void;
}

const CHANGED_DECISIONS = new Set(['add', 'change', 'remove']);

export const proposalChangedFields = (
  fields: readonly ListingProposalField[],
): ListingProposalField[] => fields.filter((field) => CHANGED_DECISIONS.has(field.decision));

export const humanizeProposalCode = (value: string): string => value
  .replaceAll('_', ' ')
  .replaceAll('-', ' ')
  .replace(/\b\w/gu, (character) => character.toUpperCase());

export const displayProposalValue = (
  key: ListingProposalField['key'],
  value: string | null,
): string => {
  if (value === null || value === '') return 'Not set';
  if (key !== 'images') return value;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (Array.isArray(parsed) && parsed.every((item) => typeof item === 'string')) {
      return parsed.length > 0 ? parsed.join('\n') : 'Not set';
    }
  } catch {
    // The response validator already treats this as plain text; display it safely as-is.
  }
  return value;
};

const ProposalValue: React.FC<{
  label: string;
  field: ListingProposalField;
  value: string | null;
  accent?: boolean;
}> = ({ label, field, value, accent = false }) => (
  <BlockStack gap="100">
    <Text as="p" variant="bodySm" tone="subdued">{label}</Text>
    <div style={{
      border: `1px solid ${accent ? '#8a8a8a' : '#e3e3e3'}`,
      borderRadius: '0.5rem',
      padding: '0.75rem',
      background: accent ? '#f7f7f7' : '#fff',
      maxHeight: '18rem',
      overflow: 'auto',
      overflowWrap: 'anywhere',
      whiteSpace: 'pre-wrap',
    }}>
      <Text as="p" fontWeight={accent ? 'semibold' : 'regular'}>
        {displayProposalValue(field.key, value)}
      </Text>
    </div>
  </BlockStack>
);

const ChangedField: React.FC<{ field: ListingProposalField }> = ({ field }) => (
  <BlockStack gap="300">
    <InlineStack align="space-between" blockAlign="center" gap="200">
      <InlineStack gap="200" blockAlign="center">
        <Text as="h3" variant="headingSm">{field.label}</Text>
        <Badge tone={field.confidence === 'blocked'
          ? 'critical' : field.confidence === 'review' ? 'attention' : 'success'}>
          {field.confidence === 'high' ? 'High confidence' : humanizeProposalCode(field.confidence)}
        </Badge>
      </InlineStack>
      <Text as="span" variant="bodySm" tone="subdued">
        {humanizeProposalCode(field.reasonCode)}
      </Text>
    </InlineStack>
    <InlineGrid columns={{ xs: 1, md: 3 }} gap="300">
      <ProposalValue label="Shopify" field={field} value={field.currentShopify} />
      <ProposalValue label="eBay now" field={field} value={field.currentEbay} />
      <ProposalValue label="Agent proposal" field={field} value={field.proposed} accent />
    </InlineGrid>
  </BlockStack>
);

const LockedCommerce: React.FC<{
  label: string;
  field: ListingProposalField | undefined;
}> = ({ label, field }) => (
  <BlockStack gap="100">
    <InlineStack gap="200" blockAlign="center">
      <Text as="p" variant="bodySm" tone="subdued">{label}</Text>
      <Badge>Locked</Badge>
    </InlineStack>
    <Text as="p" fontWeight="medium">
      {field ? displayProposalValue(field.key, field.currentEbay ?? field.currentShopify) : '—'}
    </Text>
    <Text as="p" variant="bodySm" tone="subdued">Marketplace Connect</Text>
  </BlockStack>
);

const ListingProposalReview: React.FC<Props> = ({
  response,
  canAdjust,
  generating,
  approving,
  generationFailed,
  approvalFailed,
  onGenerate,
  onApprove,
  onAdjust,
}) => {
  const [reviewOpen, setReviewOpen] = useState(false);
  const proposal = response.proposal;
  const proposalKey = proposal ? `${proposal.id}:${proposal.digest}` : response.state;

  useEffect(() => {
    setReviewOpen(false);
  }, [proposalKey]);

  if (response.state === 'approved_local' && proposal) {
    return (
      <Card>
        <InlineStack align="space-between" blockAlign="center" gap="300">
          <BlockStack gap="100">
            <InlineStack gap="200" blockAlign="center">
              <Text as="h2" variant="headingMd">Agent proposal</Text>
              <Badge tone="success">Approved locally</Badge>
            </InlineStack>
            <Text as="p" tone="subdued">Approved locally · eBay unchanged</Text>
          </BlockStack>
          {canAdjust && response.capabilities.adjustLocal && (
            <Button onClick={onAdjust}>Adjust</Button>
          )}
        </InlineStack>
      </Card>
    );
  }

  if (response.state === 'preparing' || generating) {
    return (
      <Card>
        <InlineStack align="space-between" blockAlign="center" gap="300">
          <BlockStack gap="100">
            <Text as="h2" variant="headingMd">Agent proposal</Text>
            <Text as="p" tone="subdued">Preparing a local draft · eBay unchanged</Text>
          </BlockStack>
          <Spinner accessibilityLabel="Preparing listing proposal" size="small" />
        </InlineStack>
      </Card>
    );
  }

  if (response.state === 'not_prepared' || response.state === 'stale') {
    return (
      <Card>
        <BlockStack gap="300">
          <InlineStack align="space-between" blockAlign="center" gap="300">
            <BlockStack gap="100">
              <Text as="h2" variant="headingMd">Agent proposal</Text>
              <Text as="p" tone="subdued">
                {response.state === 'stale' ? 'Source data changed.' : 'Waiting to prepare a local draft.'}
              </Text>
            </BlockStack>
            {response.capabilities.generate && (
              <Button onClick={onGenerate}>Prepare proposal</Button>
            )}
          </InlineStack>
          {generationFailed && (
            <Banner tone="critical"><Text as="p">Proposal wasn’t prepared.</Text></Banner>
          )}
        </BlockStack>
      </Card>
    );
  }

  if (response.state === 'failed') {
    return (
      <Card>
        <InlineStack align="space-between" blockAlign="center" gap="300">
          <BlockStack gap="100">
            <InlineStack gap="200" blockAlign="center">
              <Text as="h2" variant="headingMd">Agent proposal</Text>
              <Badge tone="critical">Unavailable</Badge>
            </InlineStack>
            <Text as="p" tone="subdued">No draft was approved. eBay unchanged.</Text>
          </BlockStack>
          {response.capabilities.generate && <Button onClick={onGenerate}>Try again</Button>}
        </InlineStack>
      </Card>
    );
  }

  if (response.state === 'no_changes') {
    return (
      <Card>
        <InlineStack align="space-between" blockAlign="center" gap="300">
          <BlockStack gap="100">
            <InlineStack gap="200" blockAlign="center">
              <Text as="h2" variant="headingMd">Agent proposal</Text>
              <Badge tone="success">No changes</Badge>
            </InlineStack>
            <Text as="p" tone="subdued">The current listing looks right · eBay unchanged</Text>
          </BlockStack>
          {canAdjust && response.capabilities.adjustLocal && (
            <Button onClick={onAdjust}>Adjust</Button>
          )}
        </InlineStack>
      </Card>
    );
  }

  if ((response.state !== 'ready' && response.state !== 'blocked') || !proposal) {
    return (
      <Card>
        <BlockStack gap="100">
          <Text as="h2" variant="headingMd">Agent proposal</Text>
          <Text as="p" tone="subdued">Proposal unavailable · eBay unchanged</Text>
        </BlockStack>
      </Card>
    );
  }

  const changedFields = proposalChangedFields(proposal.fields);
  const price = proposal.fields.find((field) => field.key === 'price');
  const quantity = proposal.fields.find((field) => field.key === 'quantity');
  const blocked = response.state === 'blocked' || proposal.summary.blockedFieldCount > 0
    || proposal.warnings.some((warning) => warning.severity === 'blocking');
  const canApprove = response.state === 'ready' && !blocked
    && response.capabilities.review && response.capabilities.approveLocal;

  return (
    <Card>
      <BlockStack gap="400">
        <InlineStack align="space-between" blockAlign="center" gap="300">
          <BlockStack gap="100">
            <InlineStack gap="200" blockAlign="center">
              <Text as="h2" variant="headingMd">Agent proposal</Text>
              <Badge tone={blocked ? 'attention' : 'success'}>
                {blocked ? 'Needs review' : 'Ready to review'}
              </Badge>
              <Badge>{`${proposal.summary.changedFieldCount} ${proposal.summary.changedFieldCount === 1 ? 'change' : 'changes'}`}</Badge>
            </InlineStack>
            <Text as="p" tone="subdued">Review the choices · eBay unchanged</Text>
          </BlockStack>
          <Button onClick={() => setReviewOpen((open) => !open)}
            ariaExpanded={reviewOpen} ariaControls="listing-proposal-review">
            {reviewOpen ? 'Close review' : 'Review proposal'}
          </Button>
        </InlineStack>

        {reviewOpen && (
          <div id="listing-proposal-review">
            <BlockStack gap="500">
              <Divider />
              {proposal.warnings.map((warning) => (
                <Banner key={`${warning.code}:${warning.fieldKey ?? 'proposal'}`}
                  tone={warning.severity === 'blocking' ? 'critical' : 'warning'}>
                  <Text as="p">{warning.message}</Text>
                </Banner>
              ))}

              {changedFields.length > 0 ? changedFields.map((field, index) => (
                <React.Fragment key={field.key}>
                  {index > 0 && <Divider />}
                  <ChangedField field={field} />
                </React.Fragment>
              )) : (
                <Text as="p" tone="subdued">No editable changes were proposed.</Text>
              )}

              <Divider />
              <InlineGrid columns={{ xs: 1, sm: 2 }} gap="400">
                <LockedCommerce label="Price" field={price} />
                <LockedCommerce label="Quantity" field={quantity} />
              </InlineGrid>

              {approvalFailed && (
                <Banner tone="critical">
                  <Text as="p">Approval wasn’t saved. Reload this listing and try again.</Text>
                </Banner>
              )}

              <InlineStack align="end" gap="300">
                {canAdjust && response.capabilities.adjustLocal && (
                  <Button onClick={onAdjust} disabled={approving}>Adjust</Button>
                )}
                <Button variant="primary" onClick={onApprove} loading={approving}
                  disabled={!canApprove}>
                  Approve draft
                </Button>
              </InlineStack>
            </BlockStack>
          </div>
        )}
      </BlockStack>
    </Card>
  );
};

export default ListingProposalReview;
