import React, { useState } from 'react';
import {
  Badge,
  BlockStack,
  Card,
  EmptyState,
  InlineStack,
  Page,
  Pagination,
  SkeletonBodyText,
  Text,
} from '@shopify/polaris';
import { Link } from 'react-router-dom';
import { useAuthoritativeListings } from '../hooks/useAuthoritativeListings';
import {
  isLiveCatalogResponse,
  listingAttentionText,
  listingDisplaySku,
  listingDisplayTitle,
  listingSkuLabel,
} from '../operator-ui';
import { OperationalMonitoring } from '../components/OperationalMonitoring';

const PAGE_SIZE = 25;

const Issues: React.FC = () => {
  const [offset, setOffset] = useState(0);
  const listings = useAuthoritativeListings({
    limit: PAGE_SIZE,
    offset,
    status: 'attention',
  });
  const valid = isLiveCatalogResponse(listings.data);
  const rows = valid ? listings.data?.data ?? [] : [];
  const total = valid ? listings.data?.total ?? 0 : 0;
  const unavailable = Boolean(listings.error || (listings.data && !valid));

  return (
    <Page title="Issues" fullWidth>
      <BlockStack gap="500">
      <OperationalMonitoring />
      {listings.isLoading ? (
        <Card><SkeletonBodyText lines={5} /></Card>
      ) : unavailable ? (
        <Card>
          <EmptyState
            heading="Issues unavailable"
            image=""
            action={{ content: 'Try again', onAction: () => { void listings.refetch(); } }}
          >
            <Text as="p">Current Shopify and eBay issues are unavailable.</Text>
          </EmptyState>
        </Card>
      ) : rows.length === 0 ? (
        <Card>
          <EmptyState heading="No listing issues" image="">
            <Text as="p">Everything is clear.</Text>
          </EmptyState>
        </Card>
      ) : (
        <BlockStack gap="300">
          {rows.map((row) => {
            const title = listingDisplayTitle(row);
            return (
            <Card key={row.id}>
              <InlineStack align="space-between" blockAlign="center" gap="300">
                <BlockStack gap="100">
                  <Text as="h2" variant="headingSm">{title}</Text>
                  <Text as="p" tone="subdued">{listingSkuLabel(listingDisplaySku(row))}</Text>
                  <Text as="p" tone="critical">{listingAttentionText(row)}</Text>
                </BlockStack>
                <InlineStack gap="300" blockAlign="center">
                  <Badge tone="critical">Needs attention</Badge>
                  <Link
                    to={`/listings/${encodeURIComponent(row.id)}`}
                    aria-label={`View details for ${title}`}
                  >
                    Details
                  </Link>
                </InlineStack>
              </InlineStack>
            </Card>
            );
          })}
          {total > PAGE_SIZE && (
            <InlineStack align="center">
              <Pagination
                hasPrevious={offset > 0}
                onPrevious={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
                hasNext={offset + PAGE_SIZE < total}
                onNext={() => setOffset(offset + PAGE_SIZE)}
              />
            </InlineStack>
          )}
        </BlockStack>
      )}
      </BlockStack>
    </Page>
  );
};

export default Issues;
