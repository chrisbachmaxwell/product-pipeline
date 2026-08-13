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
  listingSkuLabel,
} from '../operator-ui';

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
      {listings.isLoading ? (
        <Card><SkeletonBodyText lines={5} /></Card>
      ) : unavailable ? (
        <Card>
          <EmptyState
            heading="Issues unavailable"
            image=""
            action={{ content: 'Try again', onAction: () => { void listings.refetch(); } }}
          >
            <Text as="p">Shopify and eBay could not be checked.</Text>
          </EmptyState>
        </Card>
      ) : rows.length === 0 ? (
        <Card>
          <EmptyState heading="No listing issues" image="">
            <Text as="p">Everything checked is clear.</Text>
          </EmptyState>
        </Card>
      ) : (
        <BlockStack gap="300">
          {rows.map((row) => (
            <Card key={row.id}>
              <InlineStack align="space-between" blockAlign="center" gap="300">
                <BlockStack gap="100">
                  <Text as="h2" variant="headingSm">{row.shopify.title}</Text>
                  <Text as="p" tone="subdued">{listingSkuLabel(row.shopify.sku)}</Text>
                  <Text as="p" tone="critical">{listingAttentionText(row)}</Text>
                </BlockStack>
                <InlineStack gap="300" blockAlign="center">
                  <Badge tone="critical">Needs attention</Badge>
                  <Link
                    to={`/listings/${encodeURIComponent(row.id)}`}
                    aria-label={`View details for ${row.shopify.title}`}
                  >
                    Details
                  </Link>
                </InlineStack>
              </InlineStack>
            </Card>
          ))}
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
    </Page>
  );
};

export default Issues;
