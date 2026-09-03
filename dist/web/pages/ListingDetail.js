import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useEffect, useState } from 'react';
import { Badge, Banner, BlockStack, Button, Card, EmptyState, InlineGrid, InlineStack, Page, SkeletonBodyText, Text, } from '@shopify/polaris';
import { useParams } from 'react-router-dom';
import ListingDraftEditor from '../components/ListingDraftEditor';
import ListingDescriptionPreviewModal from '../components/ListingDescriptionPreviewModal';
import { isListingDraftBoundToWorkspace, isListingDraftResponse, useListingDraft, useSaveListingDraft, } from '../hooks/useListingDraft';
import { isListingWorkspaceResponse, useListingWorkspace, } from '../hooks/useListingWorkspace';
import { descriptionSummary, formatListingPrice, formatListingQuantity, formatVerifiedAt, formatWorkspaceMoney, listingDisplaySku, listingDisplayTitle, listingSkuLabel, listingStatusLabel, listingStatusTone, verifiedEbayListingUrl, verifiedShopifyProductUrl, } from '../operator-ui';
const Fact = ({ label, children }) => (_jsxs(BlockStack, { gap: "100", children: [_jsx(Text, { as: "p", variant: "bodySm", tone: "subdued", children: label }), _jsx("div", { children: children })] }));
const Value = ({ children }) => (_jsx(Text, { as: "p", fontWeight: "medium", children: children }));
const MappingNode = ({ label, value }) => (_jsxs(BlockStack, { gap: "050", children: [_jsx(Text, { as: "span", variant: "bodySm", tone: "subdued", children: label }), _jsx(Text, { as: "span", fontWeight: "semibold", children: value })] }));
const Difference = ({ children }) => (_jsxs(Text, { as: "p", variant: "bodySm", tone: "subdued", children: ["Shopify: ", children] }));
const ListingDetail = () => {
    const { id } = useParams();
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
    const currentEditEligible = Boolean(!workspace.error
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
        && currentDraft.capabilities.previewChanges);
    useEffect(() => {
        if (!currentEditEligible)
            setEditing(false);
    }, [currentEditEligible]);
    if (workspace.isLoading) {
        return (_jsx(Page, { title: "Listing", backAction: { content: 'Listings', url: '/listings' }, children: _jsx(Card, { children: _jsx(SkeletonBodyText, { lines: 8 }) }) }));
    }
    if (workspace.error || !currentWorkspace) {
        return (_jsx(Page, { title: "Listing", backAction: { content: 'Listings', url: '/listings' }, children: _jsx(Card, { children: _jsx(EmptyState, { heading: "Listing unavailable", image: "", action: { content: 'Try again', onAction: () => { void workspace.refetch(); } }, children: _jsx(Text, { as: "p", children: "Current Shopify and eBay details are unavailable." }) }) }) }));
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
    const priceDiffers = Boolean(actualPrice && shopifyPrice && (actualPrice.currency !== shopifyPrice.currency || actualPrice.value !== shopifyPrice.amount));
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
    ].filter((entry) => Boolean(entry[1])) : [];
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
        if (!canEdit || openingEditor)
            return;
        const trustedWorkspace = workspace.data;
        if (!trustedWorkspace)
            return;
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
        }
        finally {
            setOpeningEditor(false);
        }
    };
    return (_jsx(Page, { title: title || 'Listing', subtitle: listingSkuLabel(sku), backAction: { content: 'Listings', url: '/listings' }, titleMetadata: (_jsxs(InlineStack, { gap: "200", blockAlign: "center", children: [_jsx(Badge, { tone: listingStatusTone(catalog.lifecycleStatus), children: listingStatusLabel(catalog.lifecycleStatus) }), _jsx(Badge, { tone: "info", children: "Remote read only" })] })), primaryAction: ebayUrl ? {
            content: 'View on eBay',
            url: ebayUrl,
            external: true,
        } : undefined, secondaryActions: [
            ...(canEdit ? [{ content: 'Edit local draft', onAction: () => { void openFreshEditor(); } }] : []),
            { content: 'Preview eBay description', onAction: () => setDescriptionPreviewOpen(true) },
            ...(shopifyUrl ? [{ content: 'View in Shopify', url: shopifyUrl, external: true }] : []),
        ], fullWidth: true, children: _jsxs(BlockStack, { gap: "400", children: [_jsx(InlineStack, { align: "end", children: _jsxs(Text, { as: "span", variant: "bodySm", tone: "subdued", children: [formatVerifiedAt(observedAt), " \u00B7 refreshes every minute"] }) }), id && (_jsx(ListingDescriptionPreviewModal, { catalogId: id, open: descriptionPreviewOpen, hasUnsavedChanges: editing, onClose: () => setDescriptionPreviewOpen(false) })), editing && canEdit && validDraft ? (_jsx(ListingDraftEditor, { draft: validDraft, saving: saveDraft.isPending, onCancel: () => setEditing(false), onSave: async (input) => {
                        await saveDraft.mutateAsync(input);
                        setEditing(false);
                    } })) : (_jsxs(Card, { children: [_jsxs(InlineStack, { align: "space-between", blockAlign: "center", gap: "300", children: [_jsxs(BlockStack, { gap: "100", children: [_jsxs(InlineStack, { gap: "200", blockAlign: "center", children: [_jsx(Text, { as: "h2", variant: "headingMd", children: "Local draft" }), existingDraft && _jsx(Badge, { tone: "info", children: `Draft ${existingDraft.revisionNumber}` })] }), _jsx(Text, { as: "p", tone: "subdued", children: existingDraft ? `Saved ${formatVerifiedAt(existingDraft.createdAtUtc).replace('Updated ', '')}`
                                                : 'Prepare changes without sending them to Shopify or eBay.' })] }), localDraft.isLoading ? (_jsx(Text, { as: "span", tone: "subdued", children: "Loading" })) : canEdit ? (_jsx(Button, { onClick: () => { void openFreshEditor(); }, loading: openingEditor, children: "Edit" })) : (_jsx(Badge, { tone: "attention", children: "Read only" }))] }), draftReadOnlyReason && !localDraft.isLoading && (_jsx("div", { style: { marginTop: '1rem' }, children: _jsx(Banner, { tone: "info", children: _jsx(Text, { as: "p", children: draftReadOnlyReason }) }) }))] })), _jsx(Card, { children: _jsxs(BlockStack, { gap: "400", children: [_jsxs(InlineStack, { align: "space-between", blockAlign: "center", gap: "300", children: [_jsx(Text, { as: "h2", variant: "headingMd", children: "Mapping" }), _jsxs(InlineStack, { gap: "200", blockAlign: "center", children: [_jsx(Badge, { tone: "attention", children: "Owner unverified" }), _jsx(Badge, { tone: "info", children: "Remote read only" })] })] }), _jsxs(InlineStack, { gap: "300", blockAlign: "center", wrap: true, children: [_jsx(MappingNode, { label: "Shopify variant", value: catalog.shopify?.variantTitle !== 'Default Title'
                                            ? catalog.shopify?.variantTitle ?? 'Not mapped'
                                            : 'Default variant' }), _jsx(Text, { as: "span", tone: "subdued", children: "\u2192" }), _jsx(MappingNode, { label: "SKU", value: listingSkuLabel(mapping.inventorySku ?? sku) }), _jsx(Text, { as: "span", tone: "subdued", children: "\u2192" }), _jsx(MappingNode, { label: "Model", value: managementLabel }), mapping.offerId && (_jsxs(_Fragment, { children: [_jsx(Text, { as: "span", tone: "subdued", children: "\u2192" }), _jsx(MappingNode, { label: "Offer", value: mapping.offerId })] })), _jsx(Text, { as: "span", tone: "subdued", children: "\u2192" }), _jsx(MappingNode, { label: "Listing", value: mapping.listingId ?? 'Not listed' })] }), _jsxs(InlineGrid, { columns: { xs: 1, sm: 2, md: 4 }, gap: "300", children: [_jsx(Fact, { label: "State", children: _jsx(Value, { children: mapping.state.replaceAll('_', ' ') }) }), _jsx(Fact, { label: "Join", children: _jsx(Value, { children: "Exact SKU" }) }), _jsx(Fact, { label: "Shopify variant ID", children: _jsx(Value, { children: mapping.shopifyVariantId ?? '—' }) }), _jsx(Fact, { label: "Control API", children: _jsx(Value, { children: ebayDetail?.management.controlApi ?? '—' }) })] })] }) }), _jsx(Card, { children: _jsxs(BlockStack, { gap: "400", children: [_jsxs(InlineStack, { align: "space-between", blockAlign: "center", gap: "300", children: [_jsx(Text, { as: "h2", variant: "headingMd", children: "Listing" }), _jsxs(InlineStack, { gap: "200", blockAlign: "center", children: [_jsx(Badge, { tone: "attention", children: "Owner unverified" }), _jsx(Badge, { tone: "info", children: "Remote read only" })] })] }), _jsxs(InlineGrid, { columns: { xs: 1, sm: 2, md: 3 }, gap: "400", children: [_jsx(Fact, { label: "Status", children: _jsx(Value, { children: actual?.lifecycle.status ?? '—' }) }), _jsxs(Fact, { label: "Title", children: [_jsx(Value, { children: actual?.content.title ?? '—' }), titleDiffers && _jsx(Difference, { children: catalog.shopify?.title })] }), _jsx(Fact, { label: "Category", children: _jsx(Value, { children: category }) }), _jsx(Fact, { label: "Condition", children: _jsx(Value, { children: actual?.condition.name ?? actual?.condition.id ?? '—' }) }), _jsxs(Fact, { label: mapping.ownership.price === 'marketplace_connect'
                                            ? 'Price · Marketplace Connect' : 'Price', children: [_jsx(Value, { children: formatWorkspaceMoney(actualPrice) }), priceDiffers && _jsx(Difference, { children: formatListingPrice(shopifyPrice) })] }), _jsxs(Fact, { label: mapping.ownership.inventory === 'marketplace_connect'
                                            ? 'Quantity · Marketplace Connect' : 'Quantity', children: [_jsx(Value, { children: formatListingQuantity(actualQuantity) }), quantityDiffers && _jsx(Difference, { children: formatListingQuantity(shopifyQuantity) })] })] })] }) }), _jsx(Card, { children: _jsxs(BlockStack, { gap: "400", children: [_jsxs(InlineStack, { align: "space-between", blockAlign: "center", gap: "300", children: [_jsx(Text, { as: "h2", variant: "headingMd", children: "Content" }), _jsx(Badge, { tone: "info", children: "eBay actual" })] }), _jsxs(InlineGrid, { columns: { xs: 1, md: '2fr 1fr' }, gap: "500", children: [_jsx(Fact, { label: "Description", children: _jsx(Text, { as: "p", children: descriptionSummary(actual?.content.descriptionHtml ?? null) }) }), _jsxs(InlineGrid, { columns: 2, gap: "300", children: [_jsx(Fact, { label: "Images", children: _jsx(Value, { children: actual?.content.imageUrls.length ?? '—' }) }), _jsx(Fact, { label: "Best offer", children: _jsx(Value, { children: actual?.commerce.bestOfferEnabled === null || !actual
                                                        ? '—'
                                                        : actual.commerce.bestOfferEnabled ? 'On' : 'Off' }) })] })] }), _jsxs(InlineGrid, { columns: { xs: 1, sm: 2 }, gap: "500", children: [_jsx(Fact, { label: "Item specifics", children: aspectEntries.length ? (_jsx(BlockStack, { gap: "100", children: aspectEntries.map(([name, values]) => (_jsxs(Text, { as: "p", children: [_jsxs("strong", { children: [name, ":"] }), " ", values.join(', ')] }, name))) })) : _jsx(Value, { children: "\u2014" }) }), _jsx(Fact, { label: "Identifiers", children: identifiers.length ? (_jsx(BlockStack, { gap: "100", children: identifiers.map(([name, value]) => (_jsxs(Text, { as: "p", children: [_jsxs("strong", { children: [name, ":"] }), " ", value] }, name))) })) : _jsx(Value, { children: "\u2014" }) })] })] }) }), _jsx(Card, { children: _jsxs(BlockStack, { gap: "400", children: [_jsxs(InlineStack, { align: "space-between", blockAlign: "center", gap: "300", children: [_jsx(Text, { as: "h2", variant: "headingMd", children: "Delivery" }), _jsx(Badge, { tone: "info", children: "eBay actual" })] }), _jsxs(InlineGrid, { columns: { xs: 1, sm: 2, md: 3 }, gap: "400", children: [_jsx(Fact, { label: "Fulfillment policy", children: _jsx(Value, { children: actual?.policies.fulfillmentPolicyId ?? '—' }) }), _jsx(Fact, { label: "Payment policy", children: _jsx(Value, { children: actual?.policies.paymentPolicyId ?? '—' }) }), _jsx(Fact, { label: "Return policy", children: _jsx(Value, { children: actual?.policies.returnPolicyId ?? '—' }) }), _jsx(Fact, { label: "Location", children: _jsx(Value, { children: actual?.location.publicLocation ?? actual?.location.countryCode ?? '—' }) }), _jsx(Fact, { label: "Returns", children: _jsx(Value, { children: actual?.policies.returnsAccepted === null || !actual
                                                ? '—'
                                                : actual.policies.returnsAccepted ? 'Accepted' : 'Not accepted' }) }), _jsx(Fact, { label: "Shipping", children: _jsx(Value, { children: actual?.policies.domesticServices.slice(0, 3).join(', ') || '—' }) })] })] }) })] }) }));
};
export default ListingDetail;
