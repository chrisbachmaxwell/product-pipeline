import { jsxs as _jsxs, jsx as _jsx, Fragment as _Fragment } from "react/jsx-runtime";
import { useState } from 'react';
import { Banner, Button, ButtonGroup, Card, BlockStack, InlineStack, Text, Badge, Divider, Box, } from '@shopify/polaris';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '../hooks/useApi';
import { useAppStore } from '../store';
const formatDate = (unix) => {
    return new Date(unix * 1000).toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
    });
};
const truncateHtml = (html, maxLen = 150) => {
    const text = html.replace(/<[^>]*>/g, '').replace(/&[^;]+;/g, ' ');
    return text.length > maxLen ? text.substring(0, maxLen) + '...' : text;
};
const InlineDraftApproval = ({ productId }) => {
    const queryClient = useQueryClient();
    const { addNotification } = useAppStore();
    const [showPreview, setShowPreview] = useState(false);
    // Fetch pending draft for this product
    const { data: draftData, isLoading } = useQuery({
        queryKey: ['draft-by-product', productId],
        queryFn: () => apiClient.get(`/drafts/product/${productId}`),
        enabled: Boolean(productId),
        refetchInterval: 30000, // Check for new drafts periodically
    });
    // Approve mutation
    const approveMutation = useMutation({
        mutationFn: ({ draftId, photos, description }) => apiClient.post(`/drafts/${draftId}/approve`, { photos, description }),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['draft-by-product', productId] });
            queryClient.invalidateQueries({ queryKey: ['product-info', productId] });
            queryClient.invalidateQueries({ queryKey: ['products-overview'] });
            addNotification({
                type: 'success',
                title: 'Draft approved',
                message: 'Changes have been applied to the live product',
                autoClose: 4000
            });
        },
        onError: (error) => {
            addNotification({
                type: 'error',
                title: 'Approval failed',
                message: error instanceof Error ? error.message : 'Unknown error',
            });
        },
    });
    // Reject/dismiss mutation
    const rejectMutation = useMutation({
        mutationFn: (draftId) => apiClient.post(`/drafts/${draftId}/reject`),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['draft-by-product', productId] });
            addNotification({
                type: 'success',
                title: 'Draft dismissed',
                autoClose: 3000
            });
        },
        onError: (error) => {
            addNotification({
                type: 'error',
                title: 'Failed to dismiss draft',
                message: error instanceof Error ? error.message : 'Unknown error',
            });
        },
    });
    const handleApprove = (photos, description) => {
        if (draftData?.draft) {
            approveMutation.mutate({
                draftId: draftData.draft.id,
                photos,
                description
            });
        }
    };
    const handleDismiss = () => {
        if (draftData?.draft) {
            rejectMutation.mutate(draftData.draft.id);
        }
    };
    // Don't render if no draft or loading
    if (isLoading || !draftData?.draft || draftData.draft.status !== 'pending') {
        return null;
    }
    const { draft, live } = draftData;
    const hasDescription = Boolean(draft.draft_description);
    const hasImages = draft.draftImages.length > 0;
    return (_jsx(Card, { children: _jsx(Banner, { title: "AI has generated a new description for this product", action: {
                content: showPreview ? 'Hide preview' : 'Show preview',
                onAction: () => setShowPreview(!showPreview),
            }, secondaryAction: {
                content: 'Dismiss',
                onAction: handleDismiss,
            }, children: _jsxs(BlockStack, { gap: "300", children: [_jsxs(InlineStack, { gap: "200", align: "space-between", children: [_jsxs(Text, { as: "p", variant: "bodyMd", children: ["Ready for review \u2022 Created ", formatDate(draft.created_at)] }), _jsx(Badge, { tone: "attention", children: "Pending Approval" })] }), _jsxs(ButtonGroup, { children: [_jsx(Button, { variant: "primary", size: "medium", onClick: () => handleApprove(hasImages, hasDescription), loading: approveMutation.isPending, disabled: !hasDescription && !hasImages, children: "Approve All" }), hasDescription && (_jsx(Button, { onClick: () => handleApprove(false, true), loading: approveMutation.isPending, size: "medium", children: "Approve Description Only" })), hasImages && (_jsx(Button, { onClick: () => handleApprove(true, false), loading: approveMutation.isPending, size: "medium", children: "Approve Photos Only" }))] }), showPreview && (_jsx(Box, { padding: "400", background: "bg-surface-secondary", children: _jsxs(BlockStack, { gap: "300", children: [hasDescription && (_jsxs(_Fragment, { children: [_jsx(Text, { variant: "headingSm", as: "h4", children: "Description Changes" }), _jsxs("div", { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }, children: [_jsx(Card, { children: _jsxs(BlockStack, { gap: "200", children: [_jsx(Text, { variant: "bodySm", as: "h5", tone: "subdued", children: "Current" }), _jsx("div", { style: {
                                                                    fontSize: '13px',
                                                                    lineHeight: 1.4,
                                                                    maxHeight: '200px',
                                                                    overflow: 'auto',
                                                                }, children: live.description ? (_jsx("div", { dangerouslySetInnerHTML: { __html: truncateHtml(live.description, 300) } })) : (_jsx(Text, { as: "p", tone: "subdued", children: _jsx("em", { children: "No description" }) })) })] }) }), _jsx(Card, { children: _jsxs(BlockStack, { gap: "200", children: [_jsx(Text, { variant: "bodySm", as: "h5", tone: "subdued", children: "Proposed" }), _jsx("div", { style: {
                                                                    fontSize: '13px',
                                                                    lineHeight: 1.4,
                                                                    maxHeight: '200px',
                                                                    overflow: 'auto',
                                                                }, children: draft.draft_description ? (_jsx("div", { style: { whiteSpace: 'pre-wrap' }, children: truncateHtml(draft.draft_description, 300) })) : (_jsx(Text, { as: "p", tone: "subdued", children: _jsx("em", { children: "No changes" }) })) })] }) })] })] })), hasImages && (_jsxs(_Fragment, { children: [hasDescription && _jsx(Divider, {}), _jsx(Text, { variant: "headingSm", as: "h4", children: "Image Changes" }), _jsxs(InlineStack, { gap: "200", children: [_jsxs(Text, { as: "p", variant: "bodyMd", children: [_jsx("strong", { children: draft.draftImages.length }), " processed images ready"] }), live.images.length > 0 && (_jsxs(Text, { as: "p", variant: "bodyMd", tone: "subdued", children: ["(replacing ", live.images.length, " current)"] }))] })] }))] }) }))] }) }) }));
};
export default InlineDraftApproval;
