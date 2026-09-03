import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useState } from 'react';
import { Badge, BlockStack, Box, Card, EmptyState, IndexTable, InlineStack, Page, Pagination, Select, Spinner, Text, TextField, Thumbnail, } from '@shopify/polaris';
import { ProductIcon, SearchIcon } from '@shopify/polaris-icons';
import { Link, useNavigate } from 'react-router-dom';
import { useAuthoritativeListings } from '../hooks/useAuthoritativeListings';
import { formatListingPrice, formatVerifiedAt, isLiveCatalogResponse, listingActionLabel, listingAttentionText, listingDisplaySku, listingDisplayTitle, listingFilterOptions, formatListingQuantity, listingSkuLabel, listingStatusLabel, listingStatusTone, verifiedListingImageUrl, } from '../operator-ui';
const PAGE_SIZE = 25;
const Listings = () => {
    const navigate = useNavigate();
    const [filter, setFilter] = useState('all');
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
    const nextReview = rows.find((row) => row.shopify !== null &&
        row.lifecycleStatus === 'not_listed' &&
        row.ebay.activeMatchCount === 0 &&
        row.ebay.inventoryItemCount === 0 &&
        row.ebay.offerCount === 0 &&
        row.ebay.unpublishedArtifactCount === 0);
    const unavailable = Boolean(listings.error || (listings.data && !valid));
    return (_jsx(Page, { title: "Listings", fullWidth: true, primaryAction: nextReview ? {
            content: 'Review next',
            onAction: () => navigate(`/listings/${encodeURIComponent(nextReview.id)}`),
        } : undefined, children: _jsxs(BlockStack, { gap: "400", children: [_jsx(Card, { padding: "0", children: _jsx(Box, { padding: "400", children: _jsxs(BlockStack, { gap: "400", children: [_jsxs(InlineStack, { align: "space-between", gap: "300", blockAlign: "center", children: [_jsxs(InlineStack, { gap: "200", blockAlign: "center", children: [_jsx(Box, { minWidth: "260px", maxWidth: "420px", children: _jsx(TextField, { label: "Search listings", labelHidden: true, placeholder: "Search product or SKU", value: search, onChange: (value) => {
                                                            setSearch(value);
                                                            setOffset(0);
                                                        }, onClearButtonClick: () => {
                                                            setSearch('');
                                                            setOffset(0);
                                                        }, prefix: _jsx(SearchIcon, {}), clearButton: true, autoComplete: "off" }) }), _jsx(Box, { minWidth: "170px", children: _jsx(Select, { label: "eBay state", labelHidden: true, options: listingFilterOptions(valid ? listings.data?.summary : undefined), value: filter, onChange: (value) => {
                                                            setFilter(value);
                                                            setOffset(0);
                                                        } }) })] }), valid && (_jsx(Text, { as: "span", variant: "bodySm", tone: "subdued", children: formatVerifiedAt(listings.data?.observedAtUtc) }))] }), unavailable ? (_jsx(EmptyState, { heading: "Listings unavailable", image: "", action: { content: 'Try again', onAction: () => { void listings.refetch(); } }, children: _jsx(Text, { as: "p", children: "Current Shopify and eBay listings are unavailable." }) })) : listings.isLoading ? (_jsx(Box, { padding: "1200", children: _jsx(InlineStack, { align: "center", children: _jsx(Spinner, { accessibilityLabel: "Loading listings", size: "large" }) }) })) : rows.length === 0 ? (_jsx(EmptyState, { heading: "No matching products", image: "", children: _jsx(Text, { as: "p", children: "Try another search or state." }) })) : (_jsxs(_Fragment, { children: [_jsx("div", { className: "operator-listings-desktop", children: _jsx(IndexTable, { resourceName: { singular: 'product', plural: 'products' }, itemCount: rows.length, selectable: false, headings: [
                                                    { title: 'Product' },
                                                    { title: 'eBay' },
                                                    { title: 'Available' },
                                                    { title: 'Price' },
                                                    { title: '' },
                                                ], children: rows.map((row, index) => {
                                                    const title = listingDisplayTitle(row);
                                                    const sku = listingDisplaySku(row);
                                                    const imageUrl = verifiedListingImageUrl(row.shopify?.primaryImageUrl ?? null);
                                                    const attention = listingAttentionText(row);
                                                    const action = listingActionLabel(row.lifecycleStatus);
                                                    return (_jsxs(IndexTable.Row, { id: row.id, position: index, children: [_jsx(IndexTable.Cell, { children: _jsxs(InlineStack, { gap: "300", blockAlign: "center", wrap: false, children: [_jsx(Thumbnail, { size: "small", source: imageUrl ?? ProductIcon, alt: imageUrl ? title : '' }), _jsxs(BlockStack, { gap: "050", children: [_jsx(Text, { as: "span", fontWeight: "semibold", children: title }), _jsx(Text, { as: "span", variant: "bodySm", tone: "subdued", children: row.shopify && row.shopify.variantTitle !== 'Default Title'
                                                                                        ? `${row.shopify.variantTitle} · ${listingSkuLabel(sku)}`
                                                                                        : listingSkuLabel(sku) })] })] }) }), _jsx(IndexTable.Cell, { children: _jsxs(BlockStack, { gap: "100", children: [_jsx(Badge, { tone: listingStatusTone(row.lifecycleStatus), children: listingStatusLabel(row.lifecycleStatus) }), attention && _jsx(Text, { as: "span", variant: "bodySm", tone: "critical", children: attention })] }) }), _jsx(IndexTable.Cell, { children: formatListingQuantity(row.shopify?.available ?? null) }), _jsx(IndexTable.Cell, { children: formatListingPrice(row.shopify?.price ?? null) }), _jsx(IndexTable.Cell, { children: _jsx(Link, { to: `/listings/${encodeURIComponent(row.id)}`, "aria-label": `${action} ${title}`, children: action }) })] }, row.id));
                                                }) }) }), _jsx("div", { className: "operator-listings-mobile", children: _jsx(BlockStack, { gap: "300", children: rows.map((row) => {
                                                    const title = listingDisplayTitle(row);
                                                    const sku = listingDisplaySku(row);
                                                    const imageUrl = verifiedListingImageUrl(row.shopify?.primaryImageUrl ?? null);
                                                    const attention = listingAttentionText(row);
                                                    const action = listingActionLabel(row.lifecycleStatus);
                                                    return (_jsx(Card, { children: _jsxs(BlockStack, { gap: "300", children: [_jsxs(InlineStack, { gap: "300", blockAlign: "center", wrap: false, children: [_jsx(Thumbnail, { size: "small", source: imageUrl ?? ProductIcon, alt: imageUrl ? title : '' }), _jsxs(BlockStack, { gap: "050", children: [_jsx(Text, { as: "span", fontWeight: "semibold", children: title }), _jsx(Text, { as: "span", variant: "bodySm", tone: "subdued", children: listingSkuLabel(sku) })] })] }), _jsxs(InlineStack, { align: "space-between", blockAlign: "center", children: [_jsx(Badge, { tone: listingStatusTone(row.lifecycleStatus), children: listingStatusLabel(row.lifecycleStatus) }), _jsx(Text, { as: "span", fontWeight: "semibold", children: formatListingPrice(row.shopify?.price ?? null) })] }), attention && _jsx(Text, { as: "p", variant: "bodySm", tone: "critical", children: attention }), _jsxs(InlineStack, { align: "space-between", blockAlign: "center", children: [_jsxs(Text, { as: "span", variant: "bodySm", tone: "subdued", children: [formatListingQuantity(row.shopify?.available ?? null), " available"] }), _jsx(Link, { to: `/listings/${encodeURIComponent(row.id)}`, "aria-label": `${action} ${title}`, children: action })] })] }) }, row.id));
                                                }) }) })] }))] }) }) }), total > PAGE_SIZE && (_jsx(InlineStack, { align: "center", children: _jsx(Pagination, { hasPrevious: offset > 0, onPrevious: () => setOffset(Math.max(0, offset - PAGE_SIZE)), hasNext: offset + PAGE_SIZE < total, onNext: () => setOffset(offset + PAGE_SIZE) }) }))] }) }));
};
export default Listings;
