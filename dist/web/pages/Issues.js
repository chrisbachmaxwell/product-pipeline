import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState } from 'react';
import { Badge, BlockStack, Card, EmptyState, InlineStack, Page, Pagination, SkeletonBodyText, Text, } from '@shopify/polaris';
import { Link } from 'react-router-dom';
import { useAuthoritativeListings } from '../hooks/useAuthoritativeListings';
import { isLiveCatalogResponse, listingAttentionText, listingDisplaySku, listingDisplayTitle, listingSkuLabel, } from '../operator-ui';
import { OperationalMonitoring } from '../components/OperationalMonitoring';
const PAGE_SIZE = 25;
const Issues = () => {
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
    return (_jsx(Page, { title: "Issues", fullWidth: true, children: _jsxs(BlockStack, { gap: "500", children: [_jsx(OperationalMonitoring, {}), listings.isLoading ? (_jsx(Card, { children: _jsx(SkeletonBodyText, { lines: 5 }) })) : unavailable ? (_jsx(Card, { children: _jsx(EmptyState, { heading: "Issues unavailable", image: "", action: { content: 'Try again', onAction: () => { void listings.refetch(); } }, children: _jsx(Text, { as: "p", children: "Current Shopify and eBay issues are unavailable." }) }) })) : rows.length === 0 ? (_jsx(Card, { children: _jsx(EmptyState, { heading: "No listing issues", image: "", children: _jsx(Text, { as: "p", children: "Everything is clear." }) }) })) : (_jsxs(BlockStack, { gap: "300", children: [rows.map((row) => {
                            const title = listingDisplayTitle(row);
                            return (_jsx(Card, { children: _jsxs(InlineStack, { align: "space-between", blockAlign: "center", gap: "300", children: [_jsxs(BlockStack, { gap: "100", children: [_jsx(Text, { as: "h2", variant: "headingSm", children: title }), _jsx(Text, { as: "p", tone: "subdued", children: listingSkuLabel(listingDisplaySku(row)) }), _jsx(Text, { as: "p", tone: "critical", children: listingAttentionText(row) })] }), _jsxs(InlineStack, { gap: "300", blockAlign: "center", children: [_jsx(Badge, { tone: "critical", children: "Needs attention" }), _jsx(Link, { to: `/listings/${encodeURIComponent(row.id)}`, "aria-label": `View details for ${title}`, children: "Details" })] })] }) }, row.id));
                        }), total > PAGE_SIZE && (_jsx(InlineStack, { align: "center", children: _jsx(Pagination, { hasPrevious: offset > 0, onPrevious: () => setOffset(Math.max(0, offset - PAGE_SIZE)), hasNext: offset + PAGE_SIZE < total, onNext: () => setOffset(offset + PAGE_SIZE) }) }))] }))] }) }));
};
export default Issues;
