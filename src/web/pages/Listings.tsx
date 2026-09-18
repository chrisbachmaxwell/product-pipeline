import React, { useEffect, useState } from 'react';
import {
  Badge,
  Banner,
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
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useAuthoritativeListings } from '../hooks/useAuthoritativeListings';
import { apiClient } from '../hooks/useApi';
import {
  formatListingPrice,
  formatVerifiedAt,
  isLiveCatalogResponse,
  type ListingFilter,
  listingActionLabel,
  listingAttentionText,
  listingDisplaySku,
  listingDisplayTitle,
  listingFilterOptions,
  formatListingQuantity,
  listingSkuLabel,
  listingStatusLabel,
  listingStatusTone,
  verifiedListingImageUrl,
} from '../operator-ui';

const PAGE_SIZE = 25;

const Listings: React.FC = () => {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [filter, setFilter] = useState<ListingFilter | 'ready'>(
    searchParams.get('filter') === 'ready' ? 'ready' : 'all',
  );
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [offset, setOffset] = useState(0);
  // Debounce: one request when typing pauses, not one per keystroke.
  useEffect(() => {
    const handle = setTimeout(() => {
      setSearch(searchInput);
      setOffset(0);
    }, 300);
    return () => clearTimeout(handle);
  }, [searchInput]);
  const listings = useAuthoritativeListings({
    limit: PAGE_SIZE,
    offset,
    status: filter === 'all' || filter === 'ready' ? undefined : filter,
    ready: filter === 'ready' || undefined,
    search: search || undefined,
  });
  // Publish-all: one click publishes every ready item through the same
  // per-item ceremonies as the single Publish button, with live progress.
  type PublishAllStatus = {
    state: 'idle' | 'running' | 'finished' | 'stopped';
    totalReady: number;
    currentSku: string | null;
    stopReason: string | null;
    items: Array<{ sku: string; title: string; status: string; listingId?: string; reason?: string }>;
  };
  const [publishAll, setPublishAll] = useState<PublishAllStatus | null>(null);
  const [publishAllError, setPublishAllError] = useState<string | null>(null);
  const publishAllRunning = publishAll?.state === 'running';
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const poll = async () => {
      try {
        const next = await apiClient.get<PublishAllStatus>('/listing-publish-all');
        if (cancelled) return;
        setPublishAll(next);
        if (next.state === 'running') timer = setTimeout(() => { void poll(); }, 5000);
        else void listings.refetch();
      } catch {
        if (!cancelled) timer = setTimeout(() => { void poll(); }, 15000);
      }
    };
    void poll();
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const startPublishAll = async () => {
    setPublishAllError(null);
    try {
      const next = await apiClient.post<PublishAllStatus>('/listing-publish-all', {});
      setPublishAll(next);
      const tick = async () => {
        try {
          const polled = await apiClient.get<PublishAllStatus>('/listing-publish-all');
          setPublishAll(polled);
          if (polled.state === 'running') setTimeout(() => { void tick(); }, 5000);
          else void listings.refetch();
        } catch { setTimeout(() => { void tick(); }, 15000); }
      };
      setTimeout(() => { void tick(); }, 5000);
    } catch (error) {
      setPublishAllError(error instanceof Error
        ? error.message.replace(/\s*\([A-Z_]+\)\s*$/, '')
        : 'Publish-all could not start');
    }
  };

  const valid = isLiveCatalogResponse(listings.data);
  const rows = valid ? listings.data?.data ?? [] : [];
  const total = valid ? listings.data?.total ?? 0 : 0;
  const nextReview = rows.find((row) =>
    row.shopify !== null &&
    row.lifecycleStatus === 'not_listed' &&
    row.ebay.activeMatchCount === 0 &&
    row.ebay.inventoryItemCount === 0 &&
    row.ebay.offerCount === 0 &&
    row.ebay.unpublishedArtifactCount === 0);
  const unavailable = Boolean(listings.error || (listings.data && !valid));

  return (
    <Page
      title="Listings"
      primaryAction={{
        content: publishAllRunning ? 'Publishing…' : 'Publish all ready',
        loading: publishAllRunning,
        disabled: publishAllRunning,
        onAction: () => { void startPublishAll(); },
      }}
      secondaryActions={nextReview ? [{
        content: 'Review next',
        onAction: () => navigate(`/listings/${encodeURIComponent(nextReview.id)}`),
      }] : undefined}
    >
      <BlockStack gap="400">
        {publishAllError && (
          <Banner tone="critical" onDismiss={() => setPublishAllError(null)}>
            <Text as="p">{publishAllError}</Text>
          </Banner>
        )}
        {publishAll && publishAll.state !== 'idle'
          && (publishAllRunning || publishAll.items.length > 0 || publishAll.stopReason) && (
          <Banner
            tone={publishAll.state === 'stopped' ? 'critical'
              : publishAll.state === 'running' ? 'info' : 'success'}
            title={publishAll.state === 'running'
              ? `Publishing ${publishAll.items.length + 1} of ${publishAll.totalReady}`
                + (publishAll.currentSku ? ` — ${publishAll.currentSku}` : '')
              : publishAll.state === 'stopped'
                ? 'Publish-all stopped'
                : `Publish-all finished — ${publishAll.items.filter((item) => item.status === 'published').length} published`}
          >
            <BlockStack gap="100">
              {publishAll.stopReason && <Text as="p">{publishAll.stopReason}</Text>}
              {publishAll.items.slice(-8).map((item) => (
                <Text as="p" variant="bodySm" key={item.sku}>
                  {item.status === 'published'
                    ? `✓ ${item.sku} — live as ${item.listingId}`
                    : `${item.status === 'failed' ? '✗' : '⏭'} ${item.sku} — ${item.reason ?? item.status}`}
                </Text>
              ))}
            </BlockStack>
          </Banner>
        )}
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
                      value={searchInput}
                      onChange={setSearchInput}
                      onClearButtonClick={() => {
                        setSearchInput('');
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
                      options={[
                        ...listingFilterOptions(valid ? listings.data?.summary : undefined),
                        {
                          label: `Ready to list${
                            typeof listings.data?.summary?.readyToList === 'number'
                              ? ` (${listings.data.summary.readyToList})`
                              : ''
                          }`,
                          value: 'ready',
                        },
                      ]}
                      value={filter}
                      onChange={(value) => {
                        setFilter(value as ListingFilter | 'ready');
                        setOffset(0);
                      }}
                    />
                  </Box>
                </InlineStack>
                {valid && (
                  <Text as="span" variant="bodySm" tone="subdued">
                    {listings.isPlaceholderData
                      ? 'Updating…'
                      : formatVerifiedAt(listings.data?.observedAtUtc)}
                  </Text>
                )}
              </InlineStack>

              {unavailable ? (
                <EmptyState
                  heading="Listings unavailable"
                  image=""
                  action={{ content: 'Try again', onAction: () => { void listings.refetch(); } }}
                >
                  <Text as="p">Current Shopify and eBay listings are unavailable.</Text>
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
                        { title: 'In stock' },
                        { title: 'Price' },
                        { title: '' },
                      ]}
                    >
                      {rows.map((row, index) => {
                        const title = listingDisplayTitle(row);
                        const sku = listingDisplaySku(row);
                        const imageUrl = verifiedListingImageUrl(row.shopify?.primaryImageUrl ?? null);
                        const attention = listingAttentionText(row);
                        const action = listingActionLabel(row.lifecycleStatus, row.readyToList);
                        return (
                          <IndexTable.Row
                            id={row.id}
                            key={row.id}
                            position={index}
                            onClick={() => navigate(`/listings/${encodeURIComponent(row.id)}`)}
                          >
                            <IndexTable.Cell>
                              <InlineStack gap="300" blockAlign="center" wrap={false}>
                                <Thumbnail
                                  size="small"
                                  source={imageUrl ?? ProductIcon}
                                  alt={imageUrl ? title : ''}
                                />
                                <BlockStack gap="050">
                                  <Text as="span" fontWeight="semibold">{title}</Text>
                                  <Text as="span" variant="bodySm" tone="subdued">
                                    {row.shopify && row.shopify.variantTitle !== 'Default Title'
                                      ? `${row.shopify.variantTitle} · ${listingSkuLabel(sku)}`
                                      : listingSkuLabel(sku)}
                                  </Text>
                                </BlockStack>
                              </InlineStack>
                            </IndexTable.Cell>
                            <IndexTable.Cell>
                              <BlockStack gap="100" inlineAlign="start">
                                <Badge tone={listingStatusTone(row.lifecycleStatus, row.readyToList)}>
                                  {listingStatusLabel(row.lifecycleStatus, row.readyToList)}
                                </Badge>
                                {row.readyToListGaps?.includes('condition') && (
                                  <Badge tone="warning">Add condition tag in Shopify</Badge>
                                )}
                                {attention && <Text as="span" variant="bodySm" tone="critical">{attention}</Text>}
                              </BlockStack>
                            </IndexTable.Cell>
                            <IndexTable.Cell>{formatListingQuantity(row.shopify?.available ?? null)}</IndexTable.Cell>
                            <IndexTable.Cell>{formatListingPrice(row.shopify?.price ?? null)}</IndexTable.Cell>
                            <IndexTable.Cell>
                              <Link
                                to={`/listings/${encodeURIComponent(row.id)}`}
                                aria-label={`${action} ${title}`}
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
                        const title = listingDisplayTitle(row);
                        const sku = listingDisplaySku(row);
                        const imageUrl = verifiedListingImageUrl(row.shopify?.primaryImageUrl ?? null);
                        const attention = listingAttentionText(row);
                        const action = listingActionLabel(row.lifecycleStatus, row.readyToList);
                        return (
                          <Card key={row.id}>
                            <BlockStack gap="300">
                              <InlineStack gap="300" blockAlign="center" wrap={false}>
                                <Thumbnail
                                  size="small"
                                  source={imageUrl ?? ProductIcon}
                                  alt={imageUrl ? title : ''}
                                />
                                <BlockStack gap="050">
                                  <Text as="span" fontWeight="semibold">{title}</Text>
                                  <Text as="span" variant="bodySm" tone="subdued">
                                    {listingSkuLabel(sku)}
                                  </Text>
                                </BlockStack>
                              </InlineStack>
                              <InlineStack align="space-between" blockAlign="center">
                                <Badge tone={listingStatusTone(row.lifecycleStatus, row.readyToList)}>
                                  {listingStatusLabel(row.lifecycleStatus, row.readyToList)}
                                </Badge>
                                <Text as="span" fontWeight="semibold">
                                  {formatListingPrice(row.shopify?.price ?? null)}
                                </Text>
                              </InlineStack>
                              {row.readyToListGaps?.includes('condition') && (
                                <Badge tone="warning">Add condition tag in Shopify</Badge>
                              )}
                              {attention && <Text as="p" variant="bodySm" tone="critical">{attention}</Text>}
                              <InlineStack align="space-between" blockAlign="center">
                                <Text as="span" variant="bodySm" tone="subdued">
                                  {formatListingQuantity(row.shopify?.available ?? null)} available
                                </Text>
                                <Link
                                  to={`/listings/${encodeURIComponent(row.id)}`}
                                  aria-label={`${action} ${title}`}
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
