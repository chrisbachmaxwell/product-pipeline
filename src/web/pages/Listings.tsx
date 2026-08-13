import React, { useState } from 'react';
import {
  Badge,
  BlockStack,
  Box,
  Card,
  EmptyState,
  IndexTable,
  InlineStack,
  Page,
  Pagination,
  Select,
  Spinner,
  Text,
  TextField,
  Thumbnail,
} from '@shopify/polaris';
import { ProductIcon, SearchIcon } from '@shopify/polaris-icons';
import { Link, useNavigate } from 'react-router-dom';
import { useAuthoritativeListings } from '../hooks/useAuthoritativeListings';
import {
  formatListingPrice,
  formatVerifiedAt,
  isLiveCatalogResponse,
  type ListingFilter,
  listingActionLabel,
  listingAttentionText,
  listingFilterOptions,
  listingSkuLabel,
  listingStatusLabel,
  listingStatusTone,
  verifiedListingImageUrl,
} from '../operator-ui';

const PAGE_SIZE = 25;

const Listings: React.FC = () => {
  const navigate = useNavigate();
  const [filter, setFilter] = useState<ListingFilter>('all');
  const [search, setSearch] = useState('');
  const [offset, setOffset] = useState(0);
  const listings = useAuthoritativeListings({
    limit: PAGE_SIZE,
    offset,
    status: filter === 'all' ? undefined : filter,
    search: search || undefined,
  });
  const valid = isLiveCatalogResponse(listings.data);
  const rows = valid ? listings.data?.data ?? [] : [];
  const total = valid ? listings.data?.total ?? 0 : 0;
  const nextReview = rows.find((row) =>
    row.lifecycleStatus === 'not_listed' &&
    row.ebay.activeMatchCount === 0 &&
    row.ebay.inventoryItemCount === 0 &&
    row.ebay.offerCount === 0 &&
    row.ebay.unpublishedArtifactCount === 0);
  const unavailable = Boolean(listings.error || (listings.data && !valid));

  return (
    <Page
      title="Listings"
      fullWidth
      primaryAction={nextReview ? {
        content: 'Review next',
        onAction: () => navigate(`/listings/${encodeURIComponent(nextReview.id)}`),
      } : undefined}
    >
      <BlockStack gap="400">
        <Card padding="0">
          <Box padding="400">
            <BlockStack gap="400">
              <InlineStack align="space-between" gap="300" blockAlign="center">
                <InlineStack gap="200" blockAlign="center">
                  <Box minWidth="260px" maxWidth="420px">
                    <TextField
                      label="Search listings"
                      labelHidden
                      placeholder="Search product or SKU"
                      value={search}
                      onChange={(value) => {
                        setSearch(value);
                        setOffset(0);
                      }}
                      onClearButtonClick={() => {
                        setSearch('');
                        setOffset(0);
                      }}
                      prefix={<SearchIcon />}
                      clearButton
                      autoComplete="off"
                    />
                  </Box>
                  <Box minWidth="170px">
                    <Select
                      label="eBay state"
                      labelHidden
                      options={listingFilterOptions(valid ? listings.data?.summary : undefined)}
                      value={filter}
                      onChange={(value) => {
                        setFilter(value as ListingFilter);
                        setOffset(0);
                      }}
                    />
                  </Box>
                </InlineStack>
                {valid && (
                  <Text as="span" variant="bodySm" tone="subdued">
                    {formatVerifiedAt(listings.data?.observedAtUtc)}
                  </Text>
                )}
              </InlineStack>

              {unavailable ? (
                <EmptyState
                  heading="Listings unavailable"
                  image=""
                  action={{ content: 'Try again', onAction: () => { void listings.refetch(); } }}
                >
                  <Text as="p">Shopify and eBay could not be checked.</Text>
                </EmptyState>
              ) : listings.isLoading ? (
                <Box padding="1200">
                  <InlineStack align="center">
                    <Spinner accessibilityLabel="Loading listings" size="large" />
                  </InlineStack>
                </Box>
              ) : rows.length === 0 ? (
                <EmptyState heading="No matching products" image="">
                  <Text as="p">Try another search or state.</Text>
                </EmptyState>
              ) : (
                <>
                  <div className="operator-listings-desktop">
                    <IndexTable
                      resourceName={{ singular: 'product', plural: 'products' }}
                      itemCount={rows.length}
                      selectable={false}
                      headings={[
                        { title: 'Product' },
                        { title: 'eBay' },
                        { title: 'Available' },
                        { title: 'Price' },
                        { title: '' },
                      ]}
                    >
                      {rows.map((row, index) => {
                        const imageUrl = verifiedListingImageUrl(row.shopify.primaryImageUrl);
                        const attention = listingAttentionText(row);
                        const action = listingActionLabel(row.lifecycleStatus);
                        return (
                          <IndexTable.Row id={row.id} key={row.id} position={index}>
                            <IndexTable.Cell>
                              <InlineStack gap="300" blockAlign="center" wrap={false}>
                                <Thumbnail
                                  size="small"
                                  source={imageUrl ?? ProductIcon}
                                  alt={imageUrl ? row.shopify.title : ''}
                                />
                                <BlockStack gap="050">
                                  <Text as="span" fontWeight="semibold">{row.shopify.title}</Text>
                                  <Text as="span" variant="bodySm" tone="subdued">
                                    {row.shopify.variantTitle !== 'Default Title'
                                      ? `${row.shopify.variantTitle} · ${listingSkuLabel(row.shopify.sku)}`
                                      : listingSkuLabel(row.shopify.sku)}
                                  </Text>
                                </BlockStack>
                              </InlineStack>
                            </IndexTable.Cell>
                            <IndexTable.Cell>
                              <BlockStack gap="100">
                                <Badge tone={listingStatusTone(row.lifecycleStatus)}>
                                  {listingStatusLabel(row.lifecycleStatus)}
                                </Badge>
                                {attention && <Text as="span" variant="bodySm" tone="critical">{attention}</Text>}
                              </BlockStack>
                            </IndexTable.Cell>
                            <IndexTable.Cell>{row.shopify.available}</IndexTable.Cell>
                            <IndexTable.Cell>{formatListingPrice(row.shopify.price)}</IndexTable.Cell>
                            <IndexTable.Cell>
                              <Link
                                to={`/listings/${encodeURIComponent(row.id)}`}
                                aria-label={`${action} ${row.shopify.title}`}
                              >
                                {action}
                              </Link>
                            </IndexTable.Cell>
                          </IndexTable.Row>
                        );
                      })}
                    </IndexTable>
                  </div>

                  <div className="operator-listings-mobile">
                    <BlockStack gap="300">
                      {rows.map((row) => {
                        const imageUrl = verifiedListingImageUrl(row.shopify.primaryImageUrl);
                        const attention = listingAttentionText(row);
                        const action = listingActionLabel(row.lifecycleStatus);
                        return (
                          <Card key={row.id}>
                            <BlockStack gap="300">
                              <InlineStack gap="300" blockAlign="center" wrap={false}>
                                <Thumbnail
                                  size="small"
                                  source={imageUrl ?? ProductIcon}
                                  alt={imageUrl ? row.shopify.title : ''}
                                />
                                <BlockStack gap="050">
                                  <Text as="span" fontWeight="semibold">{row.shopify.title}</Text>
                                  <Text as="span" variant="bodySm" tone="subdued">
                                    {listingSkuLabel(row.shopify.sku)}
                                  </Text>
                                </BlockStack>
                              </InlineStack>
                              <InlineStack align="space-between" blockAlign="center">
                                <Badge tone={listingStatusTone(row.lifecycleStatus)}>
                                  {listingStatusLabel(row.lifecycleStatus)}
                                </Badge>
                                <Text as="span" fontWeight="semibold">
                                  {formatListingPrice(row.shopify.price)}
                                </Text>
                              </InlineStack>
                              {attention && <Text as="p" variant="bodySm" tone="critical">{attention}</Text>}
                              <InlineStack align="space-between" blockAlign="center">
                                <Text as="span" variant="bodySm" tone="subdued">
                                  {row.shopify.available} available
                                </Text>
                                <Link
                                  to={`/listings/${encodeURIComponent(row.id)}`}
                                  aria-label={`${action} ${row.shopify.title}`}
                                >
                                  {action}
                                </Link>
                              </InlineStack>
                            </BlockStack>
                          </Card>
                        );
                      })}
                    </BlockStack>
                  </div>
                </>
              )}
            </BlockStack>
          </Box>
        </Card>

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
    </Page>
  );
};

export default Listings;
