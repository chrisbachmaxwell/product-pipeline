import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState } from 'react';
import { Page, Layout, Card, ResourceList, ResourceItem, Badge, Button, Thumbnail, Text, Filters, ChoiceList, Modal, Banner, BlockStack, InlineStack, Spinner, EmptyState, Tabs, Box, Divider, } from '@shopify/polaris';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { apiClient } from '../hooks/useApi';
import AutoPublishSettings from '../components/AutoPublishSettings';
// ── Helpers ────────────────────────────────────────────────────────────
const statusBadge = (status) => {
    switch (status) {
        case 'pending':
            return _jsx(Badge, { tone: "attention", children: "Pending" });
        case 'approved':
            return _jsx(Badge, { tone: "success", children: "Approved" });
        case 'rejected':
            return _jsx(Badge, { tone: "critical", children: "Rejected" });
        case 'partial':
            return _jsx(Badge, { tone: "warning", children: "Partial" });
        default:
            return _jsx(Badge, { children: status });
    }
};
const formatDate = (unix) => new Date(unix * 1000).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
});
const conditionBadge = (tags) => {
    const conditionPatterns = [
        { match: /like.new/i, label: 'Like New', tone: 'success' },
        { match: /excellent\+/i, label: 'Excellent+', tone: 'success' },
        { match: /excellent/i, label: 'Excellent', tone: 'info' },
        { match: /good/i, label: 'Good', tone: 'attention' },
        { match: /fair/i, label: 'Fair', tone: 'warning' },
        { match: /poor/i, label: 'Poor', tone: 'critical' },
        { match: /ugly/i, label: 'Ugly', tone: 'critical' },
    ];
    for (const tag of tags) {
        for (const { match, label, tone } of conditionPatterns) {
            if (match.test(tag)) {
                return _jsx(Badge, { tone: tone, children: label });
            }
        }
    }
    return null;
};
const truncateHtml = (html, maxLen = 120) => {
    const text = html.replace(/<[^>]*>/g, '').replace(/&[^;]+;/g, ' ');
    return text.length > maxLen ? text.substring(0, maxLen) + '…' : text;
};
// ── Main Component ─────────────────────────────────────────────────────
const ReviewQueue = () => {
    const queryClient = useQueryClient();
    const navigate = useNavigate();
    const [selectedTab, setSelectedTab] = useState(0);
    const [statusFilter, setStatusFilter] = useState(['pending']);
    const [page, setPage] = useState(0);
    const [bulkApproveModalOpen, setBulkApproveModalOpen] = useState(false);
    const limit = 20;
    const tabs = [
        { id: 'queue', content: 'Review Queue' },
        { id: 'settings', content: 'Auto-Publish Settings' },
    ];
    const statusValue = statusFilter[0] || 'pending';
    // ── Queries ────────────────────────────────────────────────────────
    const { data: draftsData, isLoading } = useQuery({
        queryKey: ['drafts', statusValue, page],
        queryFn: () => apiClient.get(`/drafts?status=${statusValue}&limit=${limit}&offset=${page * limit}`),
        refetchInterval: 10000,
    });
    const { data: draftCount } = useQuery({
        queryKey: ['drafts-count'],
        queryFn: () => apiClient.get('/drafts/count'),
        refetchInterval: 10000,
    });
    // ── Mutations ──────────────────────────────────────────────────────
    const bulkApproveMutation = useMutation({
        mutationFn: () => apiClient.post('/drafts/approve-all', { photos: true, description: true, confirm: true }),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['drafts'] });
            queryClient.invalidateQueries({ queryKey: ['drafts-count'] });
            setBulkApproveModalOpen(false);
        },
    });
    // ── Main Render ────────────────────────────────────────────────────
    const drafts = draftsData?.data || [];
    const total = draftsData?.total || 0;
    const pendingCount = draftCount?.count || 0;
    return (_jsxs(Page, { title: "Review Queue", subtitle: `${pendingCount} drafts awaiting review`, primaryAction: pendingCount > 0
            ? {
                content: `Approve All (${pendingCount})`,
                onAction: () => setBulkApproveModalOpen(true),
            }
            : undefined, children: [_jsx(Tabs, { tabs: tabs, selected: selectedTab, onSelect: setSelectedTab, children: selectedTab === 0 ? (_jsx(Layout, { children: _jsxs(Layout.Section, { children: [_jsxs(Card, { padding: "0", children: [_jsx(Box, { padding: "400", paddingBlockEnd: "0", children: _jsx(Filters, { queryValue: "", onQueryChange: () => { }, onQueryClear: () => { }, onClearAll: () => setStatusFilter(['pending']), filters: [
                                                {
                                                    key: 'status',
                                                    label: 'Status',
                                                    filter: (_jsx(ChoiceList, { title: "Status", titleHidden: true, choices: [
                                                            { label: 'Pending', value: 'pending' },
                                                            { label: 'Approved', value: 'approved' },
                                                            { label: 'Rejected', value: 'rejected' },
                                                            { label: 'Partial', value: 'partial' },
                                                            { label: 'All', value: 'all' },
                                                        ], selected: statusFilter, onChange: (value) => {
                                                            setStatusFilter(value);
                                                            setPage(0);
                                                        } })),
                                                    shortcut: true,
                                                },
                                            ], appliedFilters: statusFilter[0] !== 'pending'
                                                ? [
                                                    {
                                                        key: 'status',
                                                        label: `Status: ${statusFilter[0]}`,
                                                        onRemove: () => setStatusFilter(['pending']),
                                                    },
                                                ]
                                                : [], hideQueryField: true }) }), _jsx(Divider, {}), isLoading ? (_jsx(Box, { padding: "500", children: _jsx(InlineStack, { align: "center", children: _jsx(Spinner, { size: "large" }) }) })) : drafts.length === 0 ? (_jsx(Box, { padding: "500", children: _jsx(EmptyState, { heading: "No drafts found", image: "", children: _jsx(Text, { as: "p", variant: "bodyMd", children: statusValue === 'pending'
                                                    ? 'All caught up! No drafts awaiting review.'
                                                    : `No ${statusValue} drafts.` }) }) })) : (_jsx(ResourceList, { resourceName: { singular: 'draft', plural: 'drafts' }, items: drafts, renderItem: (draft) => {
                                            const thumbnail = draft.draftImages?.[0];
                                            const media = thumbnail && thumbnail.startsWith('http') ? (_jsx(Thumbnail, { source: thumbnail, alt: draft.draft_title || '', size: "medium" })) : (_jsx(Thumbnail, { source: "", alt: "", size: "medium" }));
                                            return (_jsx(ResourceItem, { id: String(draft.id), media: media, onClick: () => navigate(`/review/${draft.id}`), accessibilityLabel: `Review draft ${draft.draft_title || draft.shopify_product_id}`, children: _jsxs(InlineStack, { align: "space-between", blockAlign: "center", children: [_jsxs(BlockStack, { gap: "100", children: [_jsx(Text, { variant: "bodyMd", fontWeight: "bold", as: "span", children: draft.draft_title || draft.original_title || `Product #${draft.shopify_product_id}` }), _jsxs(Text, { variant: "bodySm", as: "span", tone: "subdued", children: [draft.draftImages.length, " photos", draft.draft_description ? ` · ${truncateHtml(draft.draft_description, 80)}` : ''] }), _jsx(Text, { variant: "bodySm", as: "span", tone: "subdued", children: formatDate(draft.created_at) })] }), statusBadge(draft.status)] }) }));
                                        } }))] }), total > limit && (_jsx(Card, { children: _jsxs(InlineStack, { align: "center", blockAlign: "center", gap: "300", children: [_jsx(Button, { disabled: page === 0, onClick: () => setPage(page - 1), children: "Previous" }), _jsxs(Text, { variant: "bodySm", as: "span", tone: "subdued", children: ["Page ", page + 1, " of ", Math.ceil(total / limit)] }), _jsx(Button, { disabled: (page + 1) * limit >= total, onClick: () => setPage(page + 1), children: "Next" })] }) }))] }) })) : (_jsx(Layout, { children: _jsx(Layout.Section, { children: _jsx(AutoPublishSettings, {}) }) })) }), _jsx(Modal, { open: bulkApproveModalOpen, onClose: () => setBulkApproveModalOpen(false), title: "Bulk Approve All Pending Drafts", primaryAction: {
                    content: `Approve All ${pendingCount} Drafts`,
                    onAction: () => bulkApproveMutation.mutate(),
                    loading: bulkApproveMutation.isPending,
                }, secondaryActions: [{ content: 'Cancel', onAction: () => setBulkApproveModalOpen(false) }], children: _jsx(Modal.Section, { children: _jsx(Banner, { tone: "warning", children: _jsxs(Text, { as: "p", children: ["This will approve ", _jsx("strong", { children: pendingCount }), " pending drafts and push their content to Shopify. This action cannot be undone."] }) }) }) })] }));
};
export default ReviewQueue;
