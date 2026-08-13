import React from 'react';
import {
  Badge,
  BlockStack,
  Card,
  EmptyState,
  InlineStack,
  Page,
  SkeletonBodyText,
  Text,
} from '@shopify/polaris';
import { Link } from 'react-router-dom';
import { useAuthoritativeListings } from '../hooks/useAuthoritativeListings';

const Issues: React.FC = () => {
  const listings = useAuthoritativeListings({ limit: 100, offset: 0 });
  const rows = listings.data?.data.filter((row) => row.audit.unresolvedCount > 0) ?? [];

  return (
    <Page title="Issues" fullWidth>
      {listings.isLoading ? (
        <Card><SkeletonBodyText lines={5} /></Card>
      ) : listings.error ? (
        <Card>
          <EmptyState
            heading="Issues unavailable"
            image=""
            action={{ content: 'Try again', onAction: () => { void listings.refetch(); } }}
          >
            <Text as="p">The verified listing record could not be loaded.</Text>
          </EmptyState>
        </Card>
      ) : rows.length === 0 ? (
        <Card>
          <EmptyState heading="No listing issues" image="">
            <Text as="p">Everything in the verified snapshot is clear.</Text>
          </EmptyState>
        </Card>
      ) : (
        <BlockStack gap="300">
          {rows.map((row) => (
            <Card key={row.id}>
              <InlineStack align="space-between" blockAlign="center" gap="300">
                <BlockStack gap="100">
                  <Text as="h2" variant="headingSm">{row.shopify.title}</Text>
                  <Text as="p" tone="subdued">{row.shopify.sku}</Text>
                </BlockStack>
                <InlineStack gap="300" blockAlign="center">
                  <Badge tone="critical">{`${row.audit.unresolvedCount} open`}</Badge>
                  <Link
                    to={`/listings/${encodeURIComponent(row.id)}`}
                    aria-label={`View ${row.shopify.title}`}
                  >
                    View
                  </Link>
                </InlineStack>
              </InlineStack>
            </Card>
          ))}
        </BlockStack>
      )}
    </Page>
  );
};

export default Issues;
