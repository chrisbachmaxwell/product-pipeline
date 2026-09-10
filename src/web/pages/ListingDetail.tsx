import React, { useEffect, useState } from 'react';
import {
  Badge,
  Banner,
  Modal,
  BlockStack,
  Button,
  Card,
  EmptyState,
  InlineGrid,
  InlineStack,
  Page,
  SkeletonBodyText,
  Text,
} from '@shopify/polaris';
import { useNavigate, useParams } from 'react-router-dom';
import ListingDraftEditor from '../components/ListingDraftEditor';
import { apiClient, usePriceCheck } from '../hooks/useApi';
import ListingDescriptionPreviewModal from '../components/ListingDescriptionPreviewModal';
import {
  isListingDraftBoundToWorkspace,
  isListingDraftResponse,
  useListingDraft,
  useSaveListingDraft,
} from '../hooks/useListingDraft';
import {
  isListingWorkspaceResponse,
  useListingWorkspace,
} from '../hooks/useListingWorkspace';
import {
  descriptionSummary,
  formatListingPrice,
  formatListingQuantity,
  formatVerifiedAt,
  formatWorkspaceMoney,
  listingDisplaySku,
  listingDisplayTitle,
  listingSkuLabel,
  listingStatusLabel,
  listingStatusTone,
  verifiedEbayListingUrl,
  verifiedShopifyProductUrl,
} from '../operator-ui';

const Fact: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <BlockStack gap="100">
    <Text as="p" variant="bodySm" tone="subdued">{label}</Text>
    <div>{children}</div>
  </BlockStack>
);

const Value: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <Text as="p" fontWeight="medium">{children}</Text>
);

const MappingNode: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <BlockStack gap="050">
    <Text as="span" variant="bodySm" tone="subdued">{label}</Text>
    <Text as="span" fontWeight="semibold">{value}</Text>
  </BlockStack>
);

const Difference: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <Text as="p" variant="bodySm" tone="subdued">Shopify: {children}</Text>
);

const ListingDetail: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const workspace = useListingWorkspace(id);
  const localDraft = useListingDraft(id);
  const saveDraft = useSaveListingDraft(id);
  const [editing, setEditing] = useState(false);
  const [openingEditor, setOpeningEditor] = useState(false);
  const [descriptionPreviewOpen, setDescriptionPreviewOpen] = useState(false);
  const currentWorkspace = isListingWorkspaceResponse(workspace.data, id)
    ? workspace.data
    : null;
  const currentDraft = currentWorkspace
    && isListingDraftResponse(localDraft.data, id)
    && isListingDraftBoundToWorkspace(localDraft.data, currentWorkspace)
    ? localDraft.data
    : null;
  const currentCatalog = currentWorkspace?.catalog ?? null;
  const currentMapping = currentWorkspace?.mapping ?? null;
  const currentEditEligible = Boolean(
    !workspace.error
    && !localDraft.error
    && currentWorkspace
    && currentDraft
    && (currentCatalog?.lifecycleStatus === 'active'
      || currentCatalog?.lifecycleStatus === 'not_listed')
    && currentCatalog.shopify
    && currentCatalog.shopify.sku.trim() !== ''
    && !(currentMapping?.managementModel === 'inventory_offer'
      && currentMapping.inventorySku === null)
    && currentDraft.capabilities.saveDraft
    && currentDraft.capabilities.previewChanges,
  );
  useEffect(() => {
    if (!currentEditEligible) setEditing(false);
  }, [currentEditEligible]);

  // A not-yet-listed item opens straight into the editor, Shopify-style —
  // no Edit click. Listed items keep the read view (they sync automatically).
  useEffect(() => {
    if (currentEditEligible && currentCatalog?.lifecycleStatus === 'not_listed' && !editing) {
      setEditing(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentEditEligible, currentCatalog?.lifecycleStatus]);

  // HOOKS MUST PRECEDE the early loading/error returns below — placing any
  // hook after them is React error #310 the moment loading flips to loaded
  // (shipped and hit live on 2026-09-10; this ordering is the fix).
  const [priceCheckOpen, setPriceCheckOpen] = useState(false);
  const priceCheck = usePriceCheck(id, priceCheckOpen);
  const [publishConfirmOpen, setPublishConfirmOpen] = useState(false);
  const [draftState, setDraftState] = useState<{ dirty: boolean; descriptionHtml: string | null }>(
    { dirty: false, descriptionHtml: null },
  );

  // Warn before losing unsaved edits: browser/tab close via beforeunload,
  // and the in-app back action via confirm below. (Shopify admin's own left
  // nav cannot be intercepted from inside the iframe.)
  useEffect(() => {
    if (!draftState.dirty) return undefined;
    const handler = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [draftState.dirty]);
  const [publishing, setPublishing] = useState(false);
  const [publishResult, setPublishResult] = useState<
    | { ok: true; listingId: string | null }
    | { ok: false; message: string }
    | null
  >(null);

  const draftRevision = currentDraft?.revision ?? null;
  const publishReady = Boolean(
    currentCatalog?.lifecycleStatus === 'not_listed'
    && currentEditEligible
    && draftRevision
    && currentCatalog?.shopify,
  );

  const runPublish = async () => {
    if (!currentCatalog?.shopify || !draftRevision || !id) return;
    setPublishing(true);
    setPublishResult(null);
    try {
      const result = await apiClient.post<{ status: string; listingId: string | null }>(
        '/listing-publish',
        {
          catalogId: id,
          sku: currentCatalog.shopify.sku,
          revisionDigest: draftRevision.revisionDigest,
        },
      );
      setPublishResult({ ok: true, listingId: result.listingId ?? null });
      void workspace.refetch();
    } catch (error) {
      const raw = error instanceof Error ? error.message : 'Publish failed';
      const friendly = /REQUIRED_FIELD|PREREQUISITE/i.test(raw)
        ? 'The draft is missing something eBay requires — category, condition, description, or photos. Add it, save, and publish again.'
        : /NOT_ARMED/i.test(raw)
          ? 'Publishing is not switched on for the server yet.'
          : /BUSY/i.test(raw)
            ? 'Another publish is still running — give it a moment.'
            : raw;
      setPublishResult({ ok: false, message: friendly });
    } finally {
      setPublishing(false);
      setPublishConfirmOpen(false);
    }
  };


  if (workspace.isLoading) {
    return (
      <Page title="Listing" backAction={{ content: 'Listings', url: '/listings' }}>
        <Card><SkeletonBodyText lines={8} /></Card>
      </Page>
    );
  }

  if (workspace.error || !currentWorkspace) {
    return (
      <Page title="Listing" backAction={{ content: 'Listings', url: '/listings' }}>
        <Card>
          <EmptyState
            heading="Listing unavailable"
            image=""
            action={{ content: 'Try again', onAction: () => { void workspace.refetch(); } }}
          >
            <Text as="p">Current Shopify and eBay details are unavailable.</Text>
          </EmptyState>
        </Card>
      </Page>
    );
  }

  const { catalog, mapping, ebayDetail, evidence } = currentWorkspace;
  const actual = ebayDetail?.actual ?? null;
  const title = actual?.content.title ?? listingDisplayTitle(catalog);
  const sku = listingDisplaySku(catalog);
  const ebayUrl = verifiedEbayListingUrl(catalog.ebay.listingId, catalog.ebay.url);
  const shopifyUrl = verifiedShopifyProductUrl(catalog.shopify?.productId ?? null);
  const actualPrice = actual?.commerce.price ?? null;
  const shopifyPrice = catalog.shopify?.price ?? null;
  const actualQuantity = actual?.commerce.availableQuantity ?? null;
  const shopifyQuantity = catalog.shopify?.available ?? null;
  const priceDiffers = Boolean(actualPrice && shopifyPrice && (
    actualPrice.currency !== shopifyPrice.currency || actualPrice.value !== shopifyPrice.amount
  ));
  const quantityDiffers = actualQuantity !== null && shopifyQuantity !== null
    && actualQuantity !== shopifyQuantity;
  const titleDiffers = Boolean(actual?.content.title && catalog.shopify?.title
    && actual.content.title.trim() !== catalog.shopify.title.trim());
  const aspectEntries = actual ? Object.entries(actual.aspects).slice(0, 8) : [];
  const identifiers = actual ? [
    ['Brand', actual.identifiers.brand],
    ['MPN', actual.identifiers.mpn],
    ['UPC', actual.identifiers.upc.join(', ') || null],
    ['EAN', actual.identifiers.ean.join(', ') || null],
    ['ISBN', actual.identifiers.isbn.join(', ') || null],
    ['ePID', actual.identifiers.epid],
  ].filter((entry): entry is [string, string] => Boolean(entry[1])) : [];
  const managementLabel = mapping.managementModel === 'inventory_offer'
    ? 'Inventory item'
    : mapping.managementModel === 'legacy_trading'
      ? 'Legacy listing'
      : 'Not listed';
  const category = actual
    ? `${actual.category.primary.name ?? 'Category'}${actual.category.primary.id
      ? ` · ${actual.category.primary.id}` : ''}`
    : '—';
  const observedAt = evidence.detailObservedAtUtc ?? evidence.catalogObservedAtUtc;
  const validDraft = currentDraft;
  const draftValid = validDraft !== null;
  const draftCapabilities = validDraft?.capabilities ?? null;
  const editableStatus = catalog.lifecycleStatus === 'active'
    || catalog.lifecycleStatus === 'not_listed';
  const draftReadOnlyReason = catalog.lifecycleStatus === 'unknown'
    ? 'Current listing state is unavailable.'
    : catalog.lifecycleStatus === 'attention'
      ? 'Resolve listing issues before editing.'
      : catalog.shopify === null
        ? 'Map this listing to Shopify before editing.'
        : catalog.shopify.sku.trim() === ''
          || (mapping.managementModel === 'inventory_offer' && mapping.inventorySku === null)
          ? 'A unique SKU is required before editing.'
          : localDraft.error || (localDraft.data && !draftValid)
            ? 'Local draft is unavailable.'
            : !draftCapabilities?.saveDraft || !draftCapabilities.previewChanges
              ? 'Local draft editing is unavailable.'
              : null;
  const canEdit = currentEditEligible && editableStatus
    && draftReadOnlyReason === null && draftValid;
  const existingDraft = validDraft?.revision ?? null;
  const openFreshEditor = async () => {
    if (!canEdit || openingEditor) return;
    const trustedWorkspace = workspace.data;
    if (!trustedWorkspace) return;
    setOpeningEditor(true);
    setEditing(false);
    try {
      const refreshed = await localDraft.refetch();
      const freshDraft = isListingDraftResponse(refreshed.data, id)
        && isListingDraftBoundToWorkspace(refreshed.data, trustedWorkspace)
        ? refreshed.data
        : null;
      if (freshDraft?.capabilities.saveDraft && freshDraft.capabilities.previewChanges) {
        setEditing(true);
      }
    } finally {
      setOpeningEditor(false);
    }
  };


  return (
    <Page
      title={title || 'Listing'}
      subtitle={listingSkuLabel(sku)}
      backAction={{
        content: 'Listings',
        onAction: () => {
          if (draftState.dirty
            // eslint-disable-next-line no-alert
            && !window.confirm('You have unsaved changes. Leave without saving?')) {
            return;
          }
          navigate('/listings');
        },
      }}
      titleMetadata={(
        <InlineStack gap="200" blockAlign="center">
          <Badge tone={listingStatusTone(catalog.lifecycleStatus)}>
            {listingStatusLabel(catalog.lifecycleStatus)}
          </Badge>
        </InlineStack>
      )}
      primaryAction={publishReady ? {
        content: 'Publish to eBay',
        loading: publishing,
        onAction: () => setPublishConfirmOpen(true),
      } : ebayUrl ? {
        content: 'View on eBay',
        url: ebayUrl,
        external: true,
      } : undefined}
      secondaryActions={[
        ...(canEdit ? [{ content: 'Edit local draft', onAction: () => { void openFreshEditor(); } }] : []),
        { content: 'Preview eBay description', onAction: () => setDescriptionPreviewOpen(true) },
        { content: 'Check market prices', onAction: () => setPriceCheckOpen(true) },
        ...(shopifyUrl ? [{ content: 'View in Shopify', url: shopifyUrl, external: true }] : []),
      ]}
    >
      <BlockStack gap="400">
        <InlineStack align="end">
          <Text as="span" variant="bodySm" tone="subdued">
            {formatVerifiedAt(observedAt)} · refreshes every minute
          </Text>
        </InlineStack>

        {publishResult && (
          <Banner
            tone={publishResult.ok ? 'success' : 'critical'}
            onDismiss={() => setPublishResult(null)}
          >
            {publishResult.ok ? (
              <Text as="p">
                Published to eBay.
                {publishResult.listingId
                  ? ` Listing ${publishResult.listingId} is live — it will appear here on the next refresh.`
                  : ' It will appear here on the next refresh.'}
              </Text>
            ) : (
              <Text as="p">{publishResult.message}</Text>
            )}
          </Banner>
        )}

        {publishConfirmOpen && (
          <Modal
            open
            onClose={() => setPublishConfirmOpen(false)}
            title="Publish to eBay?"
            primaryAction={{ content: 'Publish', loading: publishing, onAction: () => { void runPublish(); } }}
            secondaryActions={[{ content: 'Cancel', onAction: () => setPublishConfirmOpen(false) }]}
          >
            <Modal.Section>
              <BlockStack gap="200">
                <Text as="p">
                  This creates a live eBay listing for “{title}” using the saved draft
                  {currentCatalog?.shopify
                    ? ` at $${currentCatalog.shopify.price.amount} · ${currentCatalog.shopify.available ?? 0} available`
                    : ''}.
                </Text>
                <Text as="p" tone="subdued">
                  Buyers can purchase immediately. You can end the listing later from eBay.
                </Text>
              </BlockStack>
            </Modal.Section>
          </Modal>
        )}

        {priceCheckOpen && (
          <Card>
            <BlockStack gap="300">
              <InlineStack align="space-between" blockAlign="center">
                <Text as="h3" variant="headingMd">Market prices</Text>
                <Button variant="plain" onClick={() => setPriceCheckOpen(false)}>Close</Button>
              </InlineStack>
              {priceCheck.isLoading ? (
                <Text as="p" tone="subdued">Checking current eBay listings…</Text>
              ) : priceCheck.error || !priceCheck.data ? (
                <Text as="p" tone="subdued">
                  Market prices are unavailable right now. Try again in a minute.
                </Text>
              ) : priceCheck.data.sampleSize === 0 ? (
                <Text as="p" tone="subdued">No comparable active listings found.</Text>
              ) : (
                <BlockStack gap="200">
                  <Text as="p">
                    {priceCheck.data.sampleSize} comparable active listings ·
                    {' '}median {priceCheck.data.median ? `$${priceCheck.data.median}` : '—'}
                  </Text>
                  {priceCheck.data.comps.slice(0, 6).map((comp, index) => (
                    <InlineStack key={index} align="space-between" blockAlign="center" gap="300">
                      <Text as="span" variant="bodySm" truncate>{comp.title}</Text>
                      <Text as="span" variant="bodySm" fontWeight="semibold">
                        ${comp.price.value}
                      </Text>
                    </InlineStack>
                  ))}
                  <Text as="p" variant="bodySm" tone="subdued">
                    Live eBay search for similar items — a sanity check, not an appraisal.
                  </Text>
                </BlockStack>
              )}
            </BlockStack>
          </Card>
        )}

        {id && (
          <ListingDescriptionPreviewModal
            catalogId={id}
            open={descriptionPreviewOpen}
            hasUnsavedChanges={draftState.dirty}
            draftDescriptionHtml={draftState.descriptionHtml}
            onClose={() => setDescriptionPreviewOpen(false)}
          />
        )}

        {editing && canEdit && validDraft ? (
          <ListingDraftEditor
            draft={validDraft}
            saving={saveDraft.isPending}
            onDraftStateChange={setDraftState}
            statusCard={(
              <Card>
                <InlineStack align="space-between" blockAlign="center" gap="300">
                  <BlockStack gap="050">
                    <Text as="h2" variant="headingMd">
                      {publishReady ? 'Ready to publish' : 'Not on eBay yet'}
                    </Text>
                    <Text as="p" variant="bodySm" tone="subdued">
                      {publishReady
                        ? 'Save any edits, then publish — buyers can purchase immediately.'
                        : 'Fill in the required fields and save, then Publish appears here.'}
                    </Text>
                  </BlockStack>
                  {publishReady && (
                    <Button
                      variant="primary"
                      loading={publishing}
                      onClick={() => setPublishConfirmOpen(true)}
                    >
                      Publish to eBay
                    </Button>
                  )}
                </InlineStack>
              </Card>
            )}
            onCancel={() => setEditing(false)}
            onSave={async (input) => {
              await saveDraft.mutateAsync(input);
            }}
          />
        ) : (
          <Card>
            <InlineStack align="space-between" blockAlign="center" gap="300">
              <BlockStack gap="100">
                <InlineStack gap="200" blockAlign="center">
                  <Text as="h2" variant="headingMd">Local draft</Text>
                  {existingDraft && <Badge tone="info">{`Draft ${existingDraft.revisionNumber}`}</Badge>}
                </InlineStack>
                <Text as="p" tone="subdued">
                  {existingDraft ? `Saved ${formatVerifiedAt(existingDraft.createdAtUtc).replace('Updated ', '')}`
                    : 'Prepare changes without sending them to Shopify or eBay.'}
                </Text>
              </BlockStack>
              {localDraft.isLoading ? (
                <Text as="span" tone="subdued">Loading</Text>
              ) : canEdit ? (
                <Button onClick={() => { void openFreshEditor(); }} loading={openingEditor}>Edit</Button>
              ) : (
                <Badge tone="attention">Read only</Badge>
              )}
            </InlineStack>
            {draftReadOnlyReason && !localDraft.isLoading && (
              <div style={{ marginTop: '1rem' }}>
                <Banner tone="info"><Text as="p">{draftReadOnlyReason}</Text></Banner>
              </div>
            )}
          </Card>
        )}

        {!editing && (
          <>
        {/* The Mapping card (join keys, gids, control API) was removed
            2026-09-10: pure sync internals, meaningless to the operator. */}

        <Card>
          <BlockStack gap="400">
            <InlineStack align="space-between" blockAlign="center" gap="300">
              <Text as="h2" variant="headingMd">Listing</Text>
              <InlineStack gap="200" blockAlign="center">
                <Badge tone="attention">Owner unverified</Badge>
                <Badge tone="info">Synced automatically</Badge>
              </InlineStack>
            </InlineStack>
            <InlineGrid columns={{ xs: 1, sm: 2, md: 3 }} gap="400">
              <Fact label="Status"><Value>{actual?.lifecycle.status ?? '—'}</Value></Fact>
              <Fact label="Title">
                <Value>{actual?.content.title ?? '—'}</Value>
                {titleDiffers && <Difference>{catalog.shopify?.title}</Difference>}
              </Fact>
              <Fact label="Category"><Value>{category}</Value></Fact>
              <Fact label="Condition">
                <Value>{actual?.condition.name ?? actual?.condition.id ?? '—'}</Value>
              </Fact>
              <Fact label={mapping.ownership.price === 'marketplace_connect'
                ? 'Price · synced from Shopify' : 'Price'}>
                <Value>{formatWorkspaceMoney(actualPrice)}</Value>
                {priceDiffers && <Difference>{formatListingPrice(shopifyPrice)}</Difference>}
              </Fact>
              <Fact label={mapping.ownership.inventory === 'marketplace_connect'
                ? 'Quantity · synced from Shopify' : 'Quantity'}>
                <Value>{formatListingQuantity(actualQuantity)}</Value>
                {quantityDiffers && <Difference>{formatListingQuantity(shopifyQuantity)}</Difference>}
              </Fact>
            </InlineGrid>
          </BlockStack>
        </Card>

        <Card>
          <BlockStack gap="400">
            <InlineStack align="space-between" blockAlign="center" gap="300">
              <Text as="h2" variant="headingMd">Content</Text>
              <Badge tone="info">eBay actual</Badge>
            </InlineStack>
            <InlineGrid columns={{ xs: 1, md: '2fr 1fr' }} gap="500">
              <Fact label="Description">
                <Text as="p">{descriptionSummary(actual?.content.descriptionHtml ?? null)}</Text>
              </Fact>
              <InlineGrid columns={2} gap="300">
                <Fact label="Images"><Value>{actual?.content.imageUrls.length ?? '—'}</Value></Fact>
                <Fact label="Best offer">
                  <Value>{actual?.commerce.bestOfferEnabled === null || !actual
                    ? '—'
                    : actual.commerce.bestOfferEnabled ? 'On' : 'Off'}</Value>
                </Fact>
              </InlineGrid>
            </InlineGrid>
            <InlineGrid columns={{ xs: 1, sm: 2 }} gap="500">
              <Fact label="Item specifics">
                {aspectEntries.length ? (
                  <BlockStack gap="100">
                    {aspectEntries.map(([name, values]) => (
                      <Text as="p" key={name}><strong>{name}:</strong> {values.join(', ')}</Text>
                    ))}
                  </BlockStack>
                ) : <Value>—</Value>}
              </Fact>
              <Fact label="Identifiers">
                {identifiers.length ? (
                  <BlockStack gap="100">
                    {identifiers.map(([name, value]) => (
                      <Text as="p" key={name}><strong>{name}:</strong> {value}</Text>
                    ))}
                  </BlockStack>
                ) : <Value>—</Value>}
              </Fact>
            </InlineGrid>
          </BlockStack>
        </Card>

        <Card>
          <BlockStack gap="400">
            <InlineStack align="space-between" blockAlign="center" gap="300">
              <Text as="h2" variant="headingMd">Delivery</Text>
              <Badge tone="info">eBay actual</Badge>
            </InlineStack>
            <InlineGrid columns={{ xs: 1, sm: 2, md: 3 }} gap="400">
              <Fact label="Fulfillment policy"><Value>{actual?.policies.fulfillmentPolicyId ?? '—'}</Value></Fact>
              <Fact label="Payment policy"><Value>{actual?.policies.paymentPolicyId ?? '—'}</Value></Fact>
              <Fact label="Return policy"><Value>{actual?.policies.returnPolicyId ?? '—'}</Value></Fact>
              <Fact label="Location">
                <Value>{actual?.location.publicLocation ?? actual?.location.countryCode ?? '—'}</Value>
              </Fact>
              <Fact label="Returns">
                <Value>{actual?.policies.returnsAccepted === null || !actual
                  ? '—'
                  : actual.policies.returnsAccepted ? 'Accepted' : 'Not accepted'}</Value>
              </Fact>
              <Fact label="Shipping">
                <Value>{actual?.policies.domesticServices.slice(0, 3).join(', ') || '—'}</Value>
              </Fact>
            </InlineGrid>
          </BlockStack>
        </Card>
          </>
        )}
      </BlockStack>
    </Page>
  );
};

export default ListingDetail;
