import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import React, { useState, useCallback, useEffect, useMemo } from 'react';
import { Page, Layout, Card, Badge, Button, Text, BlockStack, InlineStack, Divider, Box, Spinner, TextField, Banner, Modal, InlineGrid, Thumbnail, Checkbox, } from '@shopify/polaris';
import { ExternalIcon, EditIcon, ViewIcon, CheckIcon, XSmallIcon, ArrowLeftIcon, RefreshIcon, } from '@shopify/polaris-icons';
import { useParams, useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiClient, useProductNotes, useSaveProductNotes } from '../hooks/useApi';
import { useAppStore } from '../store';
import ProductPhotoEditor from '../components/ProductPhotoEditor';
import DraggablePhotoGrid from '../components/DraggablePhotoGrid';
import ConditionBadge, { getConditionFromTags } from '../components/ConditionBadge';
// ── Step Indicator ─────────────────────────────────────────────────────
const STEPS = [
    { num: 1, label: 'Review Content' },
    { num: 2, label: 'Save to Shopify' },
    { num: 3, label: 'List on eBay' },
];
const StepIndicator = ({ currentStep }) => (_jsx("div", { style: {
        display: 'flex',
        alignItems: 'center',
        gap: 0,
        padding: '16px 20px',
        background: '#f6f6f7',
        borderRadius: '12px',
        marginBottom: '20px',
        border: '1px solid #e3e3e3',
    }, children: STEPS.map((step, idx) => {
        const isActive = step.num === currentStep;
        const isDone = step.num < currentStep;
        return (_jsxs(React.Fragment, { children: [idx > 0 && (_jsx("div", { style: {
                        flex: 1,
                        height: '2px',
                        background: isDone ? '#008060' : '#e3e3e3',
                        margin: '0 8px',
                    } })), _jsxs("div", { style: { display: 'flex', alignItems: 'center', gap: '8px', flexShrink: 0 }, children: [_jsx("div", { style: {
                                width: '28px',
                                height: '28px',
                                borderRadius: '50%',
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                fontSize: '13px',
                                fontWeight: 700,
                                background: isActive ? '#008060' : isDone ? '#008060' : '#d0d0d0',
                                color: isActive || isDone ? '#fff' : '#666',
                                transition: 'background 0.2s',
                            }, children: isDone ? '✓' : step.num }), _jsx("span", { style: {
                                fontSize: '13px',
                                fontWeight: isActive ? 700 : 500,
                                color: isActive ? '#008060' : isDone ? '#008060' : '#6d7175',
                            }, children: step.label })] })] }, step.num));
    }) }));
// ── Helpers ────────────────────────────────────────────────────────────
const statusBadge = (status) => {
    switch (status) {
        case 'pending':
            return _jsx(Badge, { tone: "attention", children: "Pending Review" });
        case 'approved':
            return _jsx(Badge, { tone: "success", children: "Approved" });
        case 'rejected':
            return _jsx(Badge, { tone: "critical", children: "Rejected" });
        case 'partial':
            return _jsx(Badge, { tone: "warning", children: "Partially Approved" });
        case 'listed':
            return _jsx(Badge, { tone: "success", children: "Listed on eBay" });
        default:
            return _jsx(Badge, { children: status });
    }
};
const formatDate = (unix) => new Date(unix * 1000).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
});
const CONDITION_LABELS = {
    NEW: 'New',
    NEW_OTHER: 'New - Other',
    LIKE_NEW: 'Like New',
    USED_EXCELLENT: 'Excellent',
    VERY_GOOD: 'Very Good',
    GOOD: 'Good',
    ACCEPTABLE: 'Acceptable',
    FOR_PARTS_OR_NOT_WORKING: 'For Parts / Not Working',
};
// ── eBay Compact Preview ───────────────────────────────────────────────
const EbayCompactPreview = ({ preview }) => {
    const [activeImg, setActiveImg] = useState(0);
    const priceNum = parseFloat(preview.price) || 0;
    const conditionLabel = CONDITION_LABELS[preview.condition] || preview.condition;
    return (_jsxs("div", { style: {
            border: '1px solid #e5e7eb',
            borderRadius: '8px',
            overflow: 'hidden',
            fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
            background: '#fff',
        }, children: [_jsxs("div", { style: {
                    background: 'linear-gradient(135deg, #e53238 0%, #0064d3 100%)',
                    padding: '8px 16px',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '8px',
                }, children: [_jsx("span", { style: { color: '#fff', fontWeight: 800, fontSize: '18px', letterSpacing: '-0.5px' }, children: "ebay" }), _jsx("span", { style: { color: 'rgba(255,255,255,0.8)', fontSize: '11px' }, children: "Preview \u2014 not live yet" })] }), _jsxs("div", { style: { padding: '16px' }, children: [_jsx("h2", { style: { fontSize: '16px', fontWeight: 700, color: '#111', margin: '0 0 10px 0', lineHeight: '1.3' }, children: preview.title || 'Untitled Product' }), _jsx("div", { style: { marginBottom: '10px' }, children: _jsxs("span", { style: {
                                display: 'inline-block',
                                padding: '2px 8px',
                                background: '#f0f7ff',
                                color: '#0064d3',
                                borderRadius: '4px',
                                fontSize: '11px',
                                fontWeight: 600,
                                border: '1px solid #c8e0ff',
                            }, children: ["Condition: ", conditionLabel] }) }), _jsxs("div", { style: { display: 'flex', gap: '16px', marginBottom: '12px' }, children: [_jsx("div", { style: { flexShrink: 0, width: '200px' }, children: preview.imageUrls.length > 0 ? (_jsxs(_Fragment, { children: [_jsx("div", { style: {
                                                width: '200px',
                                                height: '200px',
                                                border: '1px solid #e5e7eb',
                                                borderRadius: '4px',
                                                overflow: 'hidden',
                                                background: '#fafafa',
                                                marginBottom: '6px',
                                            }, children: _jsx("img", { src: preview.imageUrls[activeImg], alt: "Product", style: { width: '100%', height: '100%', objectFit: 'contain' }, onError: (e) => { e.target.style.display = 'none'; } }) }), _jsx("div", { style: { display: 'flex', gap: '3px', flexWrap: 'wrap' }, children: preview.imageUrls.slice(0, 6).map((url, i) => (_jsx("div", { onClick: () => setActiveImg(i), style: {
                                                    width: '36px',
                                                    height: '36px',
                                                    border: `2px solid ${i === activeImg ? '#0064d3' : '#e5e7eb'}`,
                                                    borderRadius: '3px',
                                                    overflow: 'hidden',
                                                    cursor: 'pointer',
                                                    background: '#fafafa',
                                                }, children: _jsx("img", { src: url, alt: "", style: { width: '100%', height: '100%', objectFit: 'cover' } }) }, i))) })] })) : (_jsx("div", { style: {
                                        width: '200px',
                                        height: '200px',
                                        border: '1px dashed #d1d5db',
                                        borderRadius: '4px',
                                        display: 'flex',
                                        alignItems: 'center',
                                        justifyContent: 'center',
                                        color: '#9ca3af',
                                        fontSize: '13px',
                                    }, children: "No photos" })) }), _jsxs("div", { style: { flex: 1 }, children: [_jsxs("div", { style: { fontSize: '26px', fontWeight: 700, color: '#111', marginBottom: '4px' }, children: ["US $", priceNum.toFixed(2)] }), _jsx("div", { style: { fontSize: '11px', color: '#555', marginBottom: '12px' }, children: "+ Free shipping \u00B7 Free returns" }), _jsxs("div", { style: { padding: '10px', background: '#f0f9f0', borderRadius: '6px', border: '1px solid #c3e6cb', marginBottom: '8px' }, children: [_jsx("div", { style: { fontSize: '12px', fontWeight: 600, color: '#1a7f37' }, children: "Add to cart" }), _jsx("div", { style: { fontSize: '11px', color: '#555' }, children: "Ships from Salt Lake City, UT" })] }), preview.conditionDescription && (_jsxs("div", { style: { fontSize: '11px', color: '#555', fontStyle: 'italic' }, children: ["\"", preview.conditionDescription, "\""] }))] })] }), Object.entries(preview.aspects).length > 0 && (_jsxs(_Fragment, { children: [_jsx(Divider, {}), _jsxs("div", { style: { marginTop: '10px' }, children: [_jsx("div", { style: { fontSize: '13px', fontWeight: 600, color: '#111', marginBottom: '8px' }, children: "Item specifics" }), _jsxs("div", { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px 16px' }, children: [preview.brand && (_jsxs(React.Fragment, { children: [_jsx("div", { style: { fontSize: '12px', color: '#555' }, children: "Brand" }), _jsx("div", { style: { fontSize: '12px', fontWeight: 500, color: '#111' }, children: preview.brand })] }, "brand")), Object.entries(preview.aspects)
                                                .slice(0, 6)
                                                .map(([key, vals]) => (_jsxs(React.Fragment, { children: [_jsx("div", { style: { fontSize: '12px', color: '#555' }, children: key }), _jsx("div", { style: { fontSize: '12px', fontWeight: 500, color: '#111' }, children: Array.isArray(vals) ? vals.join(', ') : String(vals) })] }, key)))] })] })] }))] })] }));
};
// ── Main Component ─────────────────────────────────────────────────────
const ReviewDetail = () => {
    const { id } = useParams();
    const navigate = useNavigate();
    const queryClient = useQueryClient();
    const { addNotification } = useAppStore();
    const draftId = parseInt(id || '0');
    // ── Wizard State ─────────────────────────────────────────────────────
    const [wizardStep, setWizardStep] = useState(1);
    // Step 1 editing state
    const [editTitle, setEditTitle] = useState('');
    const [editDescription, setEditDescription] = useState('');
    const [localDraftImages, setLocalDraftImages] = useState([]);
    const [stateInitialized, setStateInitialized] = useState(false);
    // UI state
    const [lightboxSrc, setLightboxSrc] = useState(null);
    const [editingPhotoIndex, setEditingPhotoIndex] = useState(null);
    const [editingPhotoUrl, setEditingPhotoUrl] = useState(null);
    const [localNotes, setLocalNotes] = useState('');
    const [notesInit, setNotesInit] = useState(false);
    // Step 2 state
    const [shopifySuccess, setShopifySuccess] = useState(false);
    const [publishOnShopify, setPublishOnShopify] = useState(true);
    const [publishedToShopify, setPublishedToShopify] = useState(null);
    // Step 3 state
    const [ebayPreview, setEbayPreview] = useState(null);
    const [ebaySuccess, setEbaySuccess] = useState(null);
    const [ebayError, setEbayError] = useState(null);
    // ── Queue Navigation ─────────────────────────────────────────────────
    const { data: queueData } = useQuery({
        queryKey: ['drafts', 'pending,approved', 'nav'],
        queryFn: () => apiClient.get('/drafts?status=pending,approved,partial&limit=200&offset=0'),
        staleTime: 30000,
    });
    const queueIds = useMemo(() => queueData?.data?.map((d) => d.id) || [], [queueData]);
    const currentIndex = useMemo(() => queueIds.indexOf(draftId), [queueIds, draftId]);
    const prevId = currentIndex > 0 ? queueIds[currentIndex - 1] : null;
    const nextId = currentIndex >= 0 && currentIndex < queueIds.length - 1 ? queueIds[currentIndex + 1] : null;
    // ── Data Fetching ─────────────────────────────────────────────────────
    const { data: detailData, isLoading } = useQuery({
        queryKey: ['draft-detail', draftId],
        queryFn: () => apiClient.get(`/drafts/${draftId}`),
        enabled: draftId > 0,
    });
    const draft = detailData?.draft;
    const live = detailData?.live;
    const productId = draft?.shopify_product_id;
    const { data: notesData } = useProductNotes(productId);
    const saveNotesMutation = useSaveProductNotes();
    // ── Initialize editing state from draft ───────────────────────────────
    useEffect(() => {
        if (draft && !stateInitialized) {
            setEditTitle(draft.draft_title || '');
            setEditDescription(draft.draft_description || '');
            const imgs = (draft.draftImages || []).filter((img) => img && img.startsWith('http'));
            setLocalDraftImages(imgs);
            setStateInitialized(true);
        }
    }, [draft, stateInitialized]);
    // Reset when navigating to a different draft
    useEffect(() => {
        setStateInitialized(false);
        setWizardStep(1);
        setShopifySuccess(false);
        setPublishedToShopify(null);
        setEbayPreview(null);
        setEbaySuccess(null);
        setNotesInit(false);
        setLocalNotes('');
    }, [draftId]);
    // Auto-resume: approved drafts without eBay listing should start at eBay step
    useEffect(() => {
        if (draft && draft.status === 'approved' && !draft.ebay_listing_id && wizardStep === 1) {
            setWizardStep(3);
        }
    }, [draft, wizardStep]);
    useEffect(() => {
        if (notesData?.notes !== undefined && !notesInit) {
            setLocalNotes(notesData.notes);
            setNotesInit(true);
        }
    }, [notesData, notesInit]);
    // ── Keyboard Navigation ──────────────────────────────────────────────
    useEffect(() => {
        const handler = (e) => {
            if (wizardStep !== 1)
                return;
            if (e.key === 'ArrowLeft' && prevId)
                navigate(`/review/${prevId}`);
            if (e.key === 'ArrowRight' && nextId)
                navigate(`/review/${nextId}`);
        };
        window.addEventListener('keydown', handler);
        return () => window.removeEventListener('keydown', handler);
    }, [prevId, nextId, navigate, wizardStep]);
    // ── Auto-advance to Step 3 after Shopify success ─────────────────────
    useEffect(() => {
        if (shopifySuccess && wizardStep === 2) {
            const t = setTimeout(() => setWizardStep(3), 1200);
            return () => clearTimeout(t);
        }
    }, [shopifySuccess, wizardStep]);
    // ── Mutations ─────────────────────────────────────────────────────────
    const rejectMutation = useMutation({
        mutationFn: () => apiClient.post(`/drafts/${draftId}/reject`),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['drafts'] });
            queryClient.invalidateQueries({ queryKey: ['drafts-count'] });
            addNotification({ type: 'success', title: 'Draft rejected', autoClose: 4000 });
            if (nextId)
                navigate(`/review/${nextId}`, { replace: true });
            else
                navigate('/review', { replace: true });
        },
        onError: (err) => {
            addNotification({
                type: 'error',
                title: 'Reject failed',
                message: err instanceof Error ? err.message : 'Unknown error',
                autoClose: 8000,
            });
        },
    });
    const updateMutation = useMutation({
        mutationFn: (changes) => apiClient.put(`/drafts/${draftId}`, changes),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['draft-detail', draftId] });
        },
    });
    const reorderMutation = useMutation({
        mutationFn: (newImages) => apiClient.put(`/drafts/${draftId}`, { images: newImages }),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['draft-detail', draftId] });
        },
        onError: (err) => {
            addNotification({
                type: 'error',
                title: 'Photo save failed',
                message: err instanceof Error ? err.message : 'Unknown error',
                autoClose: 6000,
            });
        },
    });
    const approveMutation = useMutation({
        mutationFn: () => apiClient.post(`/drafts/${draftId}/approve`, { photos: true, description: true, publish: publishOnShopify }),
        onSuccess: (data) => {
            queryClient.invalidateQueries({ queryKey: ['drafts'] });
            queryClient.invalidateQueries({ queryKey: ['drafts-count'] });
            setShopifySuccess(true);
            setPublishedToShopify(data?.published ?? false);
            if (data?.published === false && data?.publishError) {
                addNotification({
                    type: 'warning',
                    title: 'Saved to Shopify (not published)',
                    message: 'Content saved but product was not published. You can publish manually in Shopify.',
                    autoClose: 8000,
                });
            }
            else {
                addNotification({
                    type: 'success',
                    title: '✅ Saved to Shopify!',
                    message: data?.published ? 'Content pushed and product published' : 'Content pushed to Shopify',
                    autoClose: 4000,
                });
            }
            // Load eBay preview while user sees success; step advance handled by useEffect
            ebayPreviewMutation.mutate();
        },
        onError: (err) => {
            addNotification({
                type: 'error',
                title: 'Save failed',
                message: err instanceof Error ? err.message : 'Unknown error',
                autoClose: 8000,
            });
        },
    });
    const ebayPreviewMutation = useMutation({
        mutationFn: () => apiClient.post(`/drafts/${draftId}/preview-ebay-listing`),
        onSuccess: (data) => {
            if (data.preview) {
                setEbayPreview(data.preview);
            }
        },
    });
    const listOnEbayMutation = useMutation({
        mutationFn: () => apiClient.post(`/drafts/${draftId}/list-on-ebay`, {}),
        onSuccess: (data) => {
            if (data.success && data.listingId) {
                queryClient.invalidateQueries({ queryKey: ['draft-detail', draftId] });
                queryClient.invalidateQueries({ queryKey: ['drafts'] });
                setEbayError(null);
                setEbaySuccess({
                    listingId: data.listingId,
                    ebayUrl: data.ebayUrl || `https://www.ebay.com/itm/${data.listingId}`,
                });
                addNotification({ type: 'success', title: '🎉 Listed on eBay!', message: `Listing #${data.listingId}`, autoClose: 8000 });
            }
            else {
                const errorMsg = data.error || 'Unknown error';
                setEbayError(errorMsg);
                addNotification({
                    type: 'error',
                    title: 'eBay listing failed',
                    message: errorMsg,
                    autoClose: 30000,
                });
            }
        },
        onError: (err) => {
            const errorMsg = err instanceof Error ? err.message : 'Unknown error';
            setEbayError(errorMsg);
            addNotification({
                type: 'error',
                title: 'eBay listing failed',
                message: errorMsg,
                autoClose: 30000,
            });
        },
    });
    // ── Handlers ──────────────────────────────────────────────────────────
    const handleReorderPhotos = useCallback(async (newImages) => {
        setLocalDraftImages(newImages);
        await reorderMutation.mutateAsync(newImages);
    }, [reorderMutation]);
    const handleApproveContent = useCallback(async () => {
        // Save any edits to title/description before advancing
        const promises = [];
        if (draft) {
            const titleChanged = editTitle !== (draft.draft_title || '');
            const descChanged = editDescription !== (draft.draft_description || '');
            if (titleChanged || descChanged) {
                promises.push(updateMutation.mutateAsync({
                    title: editTitle,
                    description: editDescription,
                }));
            }
        }
        await Promise.all(promises);
        setWizardStep(2);
    }, [draft, editTitle, editDescription, updateMutation]);
    const handleSaveToShopify = useCallback(() => {
        approveMutation.mutate();
    }, [approveMutation]);
    const handleAdvanceToEbay = useCallback(() => {
        setWizardStep(3);
        if (!ebayPreview) {
            ebayPreviewMutation.mutate();
        }
    }, [ebayPreview, ebayPreviewMutation]);
    const handleSkipEbay = useCallback(() => {
        if (nextId)
            navigate(`/review/${nextId}`, { replace: true });
        else
            navigate('/review', { replace: true });
    }, [nextId, navigate]);
    const handleFinish = useCallback(() => {
        if (nextId)
            navigate(`/review/${nextId}`, { replace: true });
        else
            navigate('/review', { replace: true });
    }, [nextId, navigate]);
    // ── Loading State ─────────────────────────────────────────────────────
    if (isLoading || !draft || !live) {
        return (_jsx(Page, { backAction: { content: 'Review Queue', url: '/review' }, title: "Loading...", children: _jsx(Box, { padding: "600", children: _jsx(InlineStack, { align: "center", children: _jsx(Spinner, { size: "large" }) }) }) }));
    }
    const title = draft.draft_title || draft.original_title || `Product #${draft.shopify_product_id}`;
    const shopifyAdminUrl = `https://admin.shopify.com/store/pictureline/products/${draft.shopify_product_id}`;
    const draftImages = localDraftImages.length > 0
        ? localDraftImages
        : (draft.draftImages || []).filter((img) => img && img.startsWith('http'));
    const liveImages = (live.images || []).filter((img) => img && img.startsWith('http'));
    const tags = draft.parsedTags || [];
    const listingId = ebaySuccess?.listingId || draft.ebay_listing_id;
    // Non-pending drafts: show read-only view (but NOT if approved without eBay listing — those resume at step 3)
    const isApprovedNeedsEbay = draft.status === 'approved' && !draft.ebay_listing_id;
    if (draft.status !== 'pending' && !isApprovedNeedsEbay && wizardStep === 1) {
        return (_jsxs(_Fragment, { children: [_jsx(Page, { backAction: { content: 'Review Queue', url: '/review' }, title: title, titleMetadata: statusBadge(draft.status), subtitle: `Created ${formatDate(draft.created_at)}${draft.reviewed_at ? ` · Reviewed ${formatDate(draft.reviewed_at)}` : ''}`, children: _jsxs(Layout, { children: [_jsxs(Layout.Section, { children: [_jsx(Card, { children: _jsxs(BlockStack, { gap: "400", children: [_jsxs(InlineStack, { gap: "200", blockAlign: "center", children: [_jsx(Text, { variant: "headingMd", as: "h2", children: "Photos" }), tags.length > 0 && _jsx(ConditionBadge, { tags: tags })] }), draftImages.length > 0 ? (_jsx(DraggablePhotoGrid, { imageUrls: draftImages, onChange: handleReorderPhotos, onEditPhoto: (i) => { setEditingPhotoIndex(i); setEditingPhotoUrl(draftImages[i]); }, enableBulkEdit: true, draftId: draftId })) : (_jsx(Banner, { tone: "info", children: _jsx(Text, { as: "p", children: "No photos available." }) }))] }) }), _jsx(Card, { children: _jsxs(BlockStack, { gap: "300", children: [_jsx(Text, { variant: "headingMd", as: "h2", children: "Description" }), _jsx(Card, { background: "bg-surface-secondary", padding: "300", children: _jsx(Box, { children: _jsx("div", { dangerouslySetInnerHTML: { __html: draft.draft_description || '<em>No description</em>' } }) }) })] }) })] }), _jsxs(Layout.Section, { variant: "oneThird", children: [_jsx(Card, { children: _jsxs(BlockStack, { gap: "200", children: [_jsx(Text, { variant: "headingMd", as: "h2", children: "Status" }), statusBadge(draft.status), draft.reviewed_at && (_jsxs(Text, { variant: "bodySm", as: "p", tone: "subdued", children: ["Reviewed ", formatDate(draft.reviewed_at)] }))] }) }), listingId && (_jsx(Card, { children: _jsxs(BlockStack, { gap: "300", children: [_jsxs(InlineStack, { align: "space-between", blockAlign: "center", children: [_jsx(Text, { variant: "headingMd", as: "h2", children: "eBay Listing" }), _jsx(Badge, { tone: "success", children: "Live" })] }), _jsx(Badge, { tone: "success", children: `Listing #${listingId}` }), _jsx(Button, { fullWidth: true, icon: ExternalIcon, size: "slim", url: ebaySuccess?.ebayUrl || `https://www.ebay.com/itm/${listingId}`, target: "_blank", children: "View on eBay" })] }) })), _jsx(Card, { children: _jsxs(BlockStack, { gap: "200", children: [_jsx(Text, { variant: "headingMd", as: "h2", children: "Product Info" }), _jsx(Button, { fullWidth: true, icon: ExternalIcon, size: "slim", url: shopifyAdminUrl, target: "_blank", children: "View in Shopify" })] }) })] })] }) }), _jsx(Modal, { open: Boolean(lightboxSrc), onClose: () => setLightboxSrc(null), title: "Photo preview", primaryAction: { content: 'Close', onAction: () => setLightboxSrc(null) }, children: _jsx(Modal.Section, { children: _jsx(InlineStack, { align: "center", children: lightboxSrc ? _jsx(Thumbnail, { source: lightboxSrc, alt: "Enlarged photo", size: "large" }) : null }) }) }), editingPhotoIndex !== null && editingPhotoUrl && (_jsx(ProductPhotoEditor, { open: true, imageUrl: editingPhotoUrl, draftId: draftId, imageIndex: editingPhotoIndex, allDraftImages: draftImages.length > 0 ? draftImages : liveImages, onSave: () => {
                        queryClient.invalidateQueries({ queryKey: ['draft-detail', draftId] });
                        setEditingPhotoIndex(null);
                        setEditingPhotoUrl(null);
                        addNotification({ type: 'success', title: 'Photo updated', message: 'Edited photo saved', autoClose: 4000 });
                    }, onClose: () => { setEditingPhotoIndex(null); setEditingPhotoUrl(null); }, productId: draft.shopify_product_id }))] }));
    }
    // ── WIZARD RENDER ──────────────────────────────────────────────────────
    return (_jsxs(_Fragment, { children: [_jsxs(Page, { backAction: { content: 'Review Queue', url: '/review' }, title: title, titleMetadata: statusBadge(draft.status), subtitle: `Created ${formatDate(draft.created_at)}`, pagination: queueIds.length > 0 && wizardStep === 1
                    ? {
                        hasPrevious: prevId !== null,
                        hasNext: nextId !== null,
                        onPrevious: () => prevId && navigate(`/review/${prevId}`),
                        onNext: () => nextId && navigate(`/review/${nextId}`),
                        label: `${currentIndex + 1} of ${queueIds.length}`,
                    }
                    : undefined, children: [_jsx(StepIndicator, { currentStep: wizardStep }), wizardStep === 1 && (_jsxs(Layout, { children: [_jsxs(Layout.Section, { children: [tags.length > 0 && (_jsx("div", { style: { marginBottom: '16px' }, children: _jsx(Card, { children: _jsxs(InlineStack, { gap: "300", blockAlign: "center", children: [_jsx(Text, { variant: "headingSm", as: "h3", children: "Condition from TIM:" }), _jsx(ConditionBadge, { tags: tags }), _jsx(Text, { variant: "bodySm", as: "p", tone: "subdued", children: (() => {
                                                            const c = getConditionFromTags(tags);
                                                            return c ? c.label : tags.filter((t) => t.startsWith('condition-')).join(', ');
                                                        })() })] }) }) })), _jsx(Card, { children: _jsxs(BlockStack, { gap: "400", children: [_jsxs(InlineStack, { align: "space-between", blockAlign: "center", children: [_jsx(Text, { variant: "headingMd", as: "h2", children: "Photos" }), _jsx(Badge, { children: `${draftImages.length} draft${liveImages.length > 0 ? ` · ${liveImages.length} live` : ''}` })] }), draftImages.length === 0 && liveImages.length === 0 ? (_jsx(Banner, { tone: "info", children: _jsx(Text, { as: "p", children: "No photos available for this draft." }) })) : draftImages.length > 0 && liveImages.length > 0 ? (_jsxs(InlineGrid, { columns: { xs: 1, sm: 2 }, gap: "600", children: [_jsxs(BlockStack, { gap: "300", children: [_jsx(Text, { variant: "headingSm", as: "h3", tone: "subdued", children: "\u2728 New Draft Photos" }), _jsx(DraggablePhotoGrid, { imageUrls: draftImages, onChange: handleReorderPhotos, onEditPhoto: (i) => { setEditingPhotoIndex(i); setEditingPhotoUrl(draftImages[i] || liveImages[i] || null); }, enableBulkEdit: true, draftId: draftId })] }), _jsxs(BlockStack, { gap: "300", children: [_jsx(Text, { variant: "headingSm", as: "h3", tone: "subdued", children: "\uD83D\uDCF7 Current Live Photos" }), _jsx(InlineGrid, { columns: { xs: 2, sm: 2 }, gap: "200", children: liveImages.map((img, i) => (_jsx(Card, { padding: "200", children: _jsxs(BlockStack, { gap: "200", inlineAlign: "center", children: [_jsx(Thumbnail, { source: img, alt: `Live photo ${i + 1}`, size: "large" }), _jsx(Button, { variant: "plain", icon: ViewIcon, onClick: () => setLightboxSrc(img), children: "View" })] }) }, `live-${i}`))) })] })] })) : draftImages.length > 0 ? (_jsxs(BlockStack, { gap: "200", children: [_jsx(Text, { variant: "headingSm", as: "h3", tone: "subdued", children: "\u2728 New Draft Photos \u2014 drag to reorder" }), _jsx(DraggablePhotoGrid, { imageUrls: draftImages, onChange: handleReorderPhotos, onEditPhoto: (i) => { setEditingPhotoIndex(i); setEditingPhotoUrl(draftImages[i] || liveImages[i] || null); }, enableBulkEdit: true, draftId: draftId })] })) : (
                                                // Only live photos — use DraggablePhotoGrid so they're editable
                                                _jsxs(BlockStack, { gap: "200", children: [_jsx(Text, { variant: "headingSm", as: "h3", tone: "subdued", children: "\uD83D\uDCF7 Current Live Photos \u2014 drag to reorder" }), _jsx(DraggablePhotoGrid, { imageUrls: liveImages, onChange: async (newImages) => {
                                                                // live image reorder — update the draft's images to new order
                                                                setLocalDraftImages(newImages);
                                                                await reorderMutation.mutateAsync(newImages);
                                                            }, onEditPhoto: (i) => { setEditingPhotoIndex(i); setEditingPhotoUrl(liveImages[i]); }, enableBulkEdit: true, draftId: draftId })] }))] }) }), _jsx(Card, { children: _jsxs(BlockStack, { gap: "400", children: [_jsx(Text, { variant: "headingMd", as: "h2", children: "Title" }), draft.original_title && draft.original_title !== editTitle && (_jsxs(BlockStack, { gap: "200", children: [_jsx(Text, { variant: "headingSm", as: "h3", tone: "subdued", children: "\uD83D\uDCC4 Original Title" }), _jsx(Card, { background: "bg-surface-secondary", padding: "300", children: _jsx(Text, { as: "p", children: draft.original_title }) })] })), _jsxs(BlockStack, { gap: "200", children: [_jsx(Text, { variant: "headingSm", as: "h3", tone: "subdued", children: "\u2728 AI-Generated Title" }), _jsx(TextField, { label: "", labelHidden: true, value: editTitle, onChange: setEditTitle, autoComplete: "off", placeholder: "Product title" })] })] }) }), _jsx(Card, { children: _jsxs(BlockStack, { gap: "400", children: [_jsx(Text, { variant: "headingMd", as: "h2", children: "Description" }), live.description ? (_jsxs(InlineGrid, { columns: { xs: 1, sm: 2 }, gap: "400", children: [_jsxs(BlockStack, { gap: "200", children: [_jsx(Text, { variant: "headingSm", as: "h3", tone: "subdued", children: "\uD83D\uDCC4 Current Live Description" }), _jsx(Card, { background: "bg-surface-secondary", padding: "300", children: _jsx(Box, { children: _jsx("div", { style: { maxHeight: '400px', overflow: 'auto', fontSize: '13px', lineHeight: '1.6' }, dangerouslySetInnerHTML: { __html: live.description } }) }) })] }), _jsxs(BlockStack, { gap: "200", children: [_jsx(Text, { variant: "headingSm", as: "h3", tone: "subdued", children: "\u2728 AI-Generated Description" }), _jsx(TextField, { label: "", labelHidden: true, value: editDescription, onChange: setEditDescription, multiline: 14, autoComplete: "off" })] })] })) : (_jsxs(BlockStack, { gap: "200", children: [_jsx(Text, { variant: "headingSm", as: "h3", tone: "subdued", children: "\u2728 AI-Generated Description" }), _jsx(TextField, { label: "", labelHidden: true, value: editDescription, onChange: setEditDescription, multiline: 12, autoComplete: "off" })] }))] }) })] }), _jsx(Layout.Section, { variant: "oneThird", children: _jsxs("div", { style: { position: 'sticky', top: '16px' }, children: [_jsx(Card, { children: _jsxs(BlockStack, { gap: "400", children: [_jsx(Text, { variant: "headingMd", as: "h2", children: "Step 1 Actions" }), tags.length > 0 && (_jsxs(BlockStack, { gap: "100", children: [_jsx(Text, { variant: "bodySm", as: "p", tone: "subdued", children: "Condition Grade" }), _jsx(ConditionBadge, { tags: tags })] })), _jsx(Divider, {}), _jsx(Button, { variant: "primary", tone: "success", size: "large", fullWidth: true, icon: CheckIcon, onClick: handleApproveContent, loading: updateMutation.isPending, children: "Approve Content \u2192" }), _jsx(Text, { variant: "bodySm", as: "p", tone: "subdued", alignment: "center", children: "Advances to Shopify preview" }), _jsx(Divider, {}), _jsx(Button, { fullWidth: true, tone: "critical", icon: XSmallIcon, onClick: () => rejectMutation.mutate(), loading: rejectMutation.isPending, children: "Reject Draft" })] }) }), _jsx("div", { style: { marginTop: '16px' }, children: _jsx(Card, { children: _jsxs(BlockStack, { gap: "300", children: [_jsx(Text, { variant: "headingMd", as: "h2", children: "Product Info" }), _jsxs(BlockStack, { gap: "200", children: [_jsxs(InlineStack, { align: "space-between", children: [_jsx(Text, { variant: "bodySm", as: "span", tone: "subdued", children: "Shopify ID" }), _jsx(Text, { variant: "bodySm", as: "span", children: draft.shopify_product_id })] }), _jsxs(InlineStack, { align: "space-between", children: [_jsx(Text, { variant: "bodySm", as: "span", tone: "subdued", children: "Photos" }), _jsxs(Text, { variant: "bodySm", as: "span", children: [draftImages.length, " draft"] })] }), _jsxs(InlineStack, { align: "space-between", children: [_jsx(Text, { variant: "bodySm", as: "span", tone: "subdued", children: "Description" }), _jsx(Badge, { tone: draft.draft_description ? 'success' : 'critical', children: draft.draft_description ? 'Generated' : 'Missing' })] })] }), _jsx(Button, { fullWidth: true, icon: ExternalIcon, size: "slim", url: shopifyAdminUrl, target: "_blank", children: "View in Shopify" })] }) }) }), productId && (_jsx("div", { style: { marginTop: '16px' }, children: _jsx(Card, { children: _jsxs(BlockStack, { gap: "300", children: [_jsxs(InlineStack, { align: "space-between", blockAlign: "center", children: [_jsx(Text, { variant: "headingMd", as: "h2", children: "Notes" }), localNotes.trim() && _jsx(Badge, { tone: "attention", children: "Has Notes" })] }), _jsx(TextField, { label: "", labelHidden: true, value: localNotes, onChange: setLocalNotes, multiline: 3, placeholder: "Condition notes, blemishes, etc.", autoComplete: "off", onBlur: () => {
                                                                if (localNotes !== (notesData?.notes ?? '')) {
                                                                    saveNotesMutation.mutate({ productId, notes: localNotes });
                                                                }
                                                            } }), _jsx(Text, { variant: "bodySm", as: "p", tone: "subdued", children: "Auto-saves on blur." })] }) }) }))] }) })] })), wizardStep === 2 && (_jsxs(Layout, { children: [_jsxs(Layout.Section, { children: [shopifySuccess ? (_jsxs(BlockStack, { gap: "300", children: [_jsx(Banner, { tone: "success", children: _jsxs(BlockStack, { gap: "200", children: [_jsx(Text, { variant: "headingMd", as: "h2", children: "\u2705 Saved to Shopify!" }), _jsx(Text, { as: "p", children: "Title, description, and photos have been pushed to your Shopify product." })] }) }), publishedToShopify === false && (_jsx(Banner, { tone: "warning", children: _jsx(Text, { as: "p", children: "Content saved but product was not published on Shopify." }) }))] })) : (_jsx(Banner, { tone: "info", children: _jsx(Text, { as: "p", children: "Review the content below. This is exactly what will be pushed to Shopify when you click \"Save to Shopify\"." }) })), _jsx("div", { style: { marginTop: '16px' }, children: _jsx(Card, { children: _jsxs(BlockStack, { gap: "400", children: [_jsxs(InlineStack, { align: "space-between", blockAlign: "center", children: [_jsx(Text, { variant: "headingMd", as: "h2", children: "Photos to Publish" }), _jsx(Badge, { tone: draftImages.length > 0 ? 'success' : 'critical', children: `${draftImages.length} photo${draftImages.length !== 1 ? 's' : ''}` })] }), draftImages.length > 0 ? (_jsx(InlineGrid, { columns: { xs: 3, sm: 4, md: 5 }, gap: "200", children: draftImages.map((img, i) => (_jsx("div", { style: { position: 'relative' }, children: _jsx(Card, { padding: "200", children: _jsxs(BlockStack, { gap: "100", inlineAlign: "center", children: [_jsx(Thumbnail, { source: img, alt: `Photo ${i + 1}`, size: "large" }), i === 0 && (_jsx(Badge, { tone: "success", children: "Main" }))] }) }) }, i))) })) : (_jsx(Banner, { tone: "warning", children: _jsx(Text, { as: "p", children: "No photos to publish." }) }))] }) }) }), _jsx("div", { style: { marginTop: '16px' }, children: _jsx(Card, { children: _jsxs(BlockStack, { gap: "300", children: [_jsx(Text, { variant: "headingMd", as: "h2", children: "Title to Publish" }), _jsx(Card, { background: "bg-surface-secondary", padding: "300", children: _jsx(Text, { as: "p", fontWeight: "semibold", children: editTitle || draft.draft_title || '(no title)' }) })] }) }) }), _jsx("div", { style: { marginTop: '16px' }, children: _jsx(Card, { children: _jsxs(BlockStack, { gap: "300", children: [_jsxs(InlineStack, { align: "space-between", blockAlign: "center", children: [_jsx(Text, { variant: "headingMd", as: "h2", children: "Description to Publish" }), tags.length > 0 && _jsx(ConditionBadge, { tags: tags })] }), _jsx(Card, { background: "bg-surface-secondary", padding: "300", children: _jsx(Box, { children: _jsx("div", { style: { maxHeight: '500px', overflow: 'auto' }, dangerouslySetInnerHTML: { __html: editDescription || draft.draft_description || '<em>No description</em>' } }) }) })] }) }) })] }), _jsx(Layout.Section, { variant: "oneThird", children: _jsx("div", { style: { position: 'sticky', top: '16px' }, children: _jsx(Card, { children: _jsxs(BlockStack, { gap: "400", children: [_jsx(Text, { variant: "headingMd", as: "h2", children: "Step 2: Save to Shopify" }), tags.length > 0 && (_jsxs(BlockStack, { gap: "100", children: [_jsx(Text, { variant: "bodySm", as: "p", tone: "subdued", children: "Condition Grade" }), _jsx(ConditionBadge, { tags: tags })] })), _jsxs(BlockStack, { gap: "200", children: [_jsxs(InlineStack, { align: "space-between", children: [_jsx(Text, { variant: "bodySm", as: "span", tone: "subdued", children: "Photos" }), _jsxs(Text, { variant: "bodySm", as: "span", children: [draftImages.length, " to upload"] })] }), _jsxs(InlineStack, { align: "space-between", children: [_jsx(Text, { variant: "bodySm", as: "span", tone: "subdued", children: "Title" }), _jsx(Badge, { tone: "success", children: "Ready" })] }), _jsxs(InlineStack, { align: "space-between", children: [_jsx(Text, { variant: "bodySm", as: "span", tone: "subdued", children: "Description" }), _jsx(Badge, { tone: editDescription ? 'success' : 'warning', children: editDescription ? 'Ready' : 'Empty' })] })] }), _jsx(Divider, {}), !shopifySuccess ? (_jsxs(BlockStack, { gap: "300", children: [_jsx(Checkbox, { label: "Publish on Shopify", helpText: "Make this product visible in your store", checked: publishOnShopify, onChange: setPublishOnShopify }), _jsx(Button, { variant: "primary", tone: "success", size: "large", fullWidth: true, onClick: handleSaveToShopify, loading: approveMutation.isPending, icon: CheckIcon, children: "Save to Shopify" })] })) : (_jsx(Text, { variant: "bodyMd", as: "p", tone: "success", fontWeight: "semibold", children: "\u2705 Saved to Shopify \u2014 advancing to eBay\u2026" })), shopifySuccess && (_jsx(Button, { fullWidth: true, variant: "plain", url: shopifyAdminUrl, target: "_blank", icon: ExternalIcon, children: "View in Shopify" })), _jsx(Divider, {}), _jsx(Button, { fullWidth: true, icon: ArrowLeftIcon, onClick: () => setWizardStep(1), disabled: approveMutation.isPending, children: "\u2190 Back to Review" })] }) }) }) })] })), wizardStep === 3 && (_jsxs(Layout, { children: [_jsx(Layout.Section, { children: ebaySuccess ? (_jsxs(BlockStack, { gap: "400", children: [_jsx(Banner, { tone: "success", children: _jsxs(BlockStack, { gap: "300", children: [_jsx(Text, { variant: "headingMd", as: "h2", children: "\uD83C\uDF89 Listed on eBay!" }), _jsx(Text, { as: "p", children: "Your product is now live on eBay." }), _jsx(InlineStack, { gap: "200", children: _jsx(Badge, { tone: "success", children: `Listing #${ebaySuccess.listingId}` }) })] }) }), _jsxs(InlineStack, { gap: "200", children: [_jsx(Button, { variant: "primary", icon: ExternalIcon, url: ebaySuccess.ebayUrl, target: "_blank", children: "View on eBay" }), _jsx(Button, { onClick: handleFinish, children: nextId ? 'Next Draft →' : 'Back to Queue' })] })] })) : (_jsxs(BlockStack, { gap: "400", children: [_jsx(Banner, { tone: "info", children: _jsx(Text, { as: "p", children: "Review the eBay listing preview below. Click \"Publish to eBay\" to go live, or use \"Edit Listing Details\" for full control over price, category, and item specifics." }) }), ebayPreviewMutation.isPending && !ebayPreview ? (_jsx(Card, { children: _jsxs(BlockStack, { gap: "400", children: [_jsx(InlineStack, { align: "center", children: _jsx(Spinner, { size: "large" }) }), _jsx(Text, { alignment: "center", as: "p", tone: "subdued", children: "Loading eBay listing data\u2026" })] }) })) : ebayPreview ? (_jsxs(BlockStack, { gap: "400", children: [_jsx(EbayCompactPreview, { preview: ebayPreview }), tags.length > 0 && (_jsx(Card, { children: _jsxs(BlockStack, { gap: "300", children: [_jsx(Text, { variant: "headingMd", as: "h2", children: "Condition Details" }), _jsxs(InlineStack, { gap: "300", blockAlign: "center", children: [_jsx(ConditionBadge, { tags: tags }), ebayPreview.conditionDescription && (_jsxs(Text, { variant: "bodySm", as: "p", tone: "subdued", children: ["\"", ebayPreview.conditionDescription, "\""] }))] }), _jsxs(BlockStack, { gap: "100", children: [_jsx(Text, { variant: "bodySm", as: "span", tone: "subdued", children: "eBay Condition Grade" }), _jsx(Text, { variant: "bodySm", as: "span", fontWeight: "semibold", children: CONDITION_LABELS[ebayPreview.condition] || ebayPreview.condition })] })] }) }))] })) : ebayPreviewMutation.isError ? (_jsx(Banner, { tone: "warning", children: _jsxs(BlockStack, { gap: "200", children: [_jsx(Text, { as: "p", children: "Could not load eBay preview. You can still publish, or use the full prep page for more control." }), _jsx(Button, { icon: RefreshIcon, onClick: () => ebayPreviewMutation.mutate(), size: "slim", children: "Retry" })] }) })) : null] })) }), _jsx(Layout.Section, { variant: "oneThird", children: _jsx("div", { style: { position: 'sticky', top: '16px' }, children: !ebaySuccess ? (_jsx(Card, { children: _jsxs(BlockStack, { gap: "400", children: [_jsx(Text, { variant: "headingMd", as: "h2", children: "Step 3: List on eBay" }), tags.length > 0 && (_jsxs(BlockStack, { gap: "100", children: [_jsx(Text, { variant: "bodySm", as: "p", tone: "subdued", children: "Condition Grade" }), _jsx(ConditionBadge, { tags: tags })] })), ebayPreview && (_jsxs(BlockStack, { gap: "200", children: [_jsxs(InlineStack, { align: "space-between", children: [_jsx(Text, { variant: "bodySm", as: "span", tone: "subdued", children: "Price" }), _jsxs(Text, { variant: "bodySm", as: "span", fontWeight: "semibold", children: ["$", ebayPreview.price] })] }), _jsxs(InlineStack, { align: "space-between", children: [_jsx(Text, { variant: "bodySm", as: "span", tone: "subdued", children: "Condition" }), _jsx(Text, { variant: "bodySm", as: "span", children: CONDITION_LABELS[ebayPreview.condition] || ebayPreview.condition })] }), _jsxs(InlineStack, { align: "space-between", children: [_jsx(Text, { variant: "bodySm", as: "span", tone: "subdued", children: "Photos" }), _jsxs(Text, { variant: "bodySm", as: "span", children: [ebayPreview.imageUrls.length, " images"] })] }), _jsxs(InlineStack, { align: "space-between", children: [_jsx(Text, { variant: "bodySm", as: "span", tone: "subdued", children: "Category" }), _jsx(Text, { variant: "bodySm", as: "span", children: ebayPreview.categoryName || ebayPreview.categoryId })] })] })), _jsx(Divider, {}), ebayError && (_jsxs(Banner, { tone: "critical", onDismiss: () => setEbayError(null), children: [_jsx(Text, { variant: "bodySm", as: "p", fontWeight: "semibold", children: "eBay listing failed" }), _jsx(Text, { variant: "bodySm", as: "p", children: ebayError })] })), _jsx(Button, { variant: "primary", tone: "success", size: "large", fullWidth: true, onClick: () => { setEbayError(null); listOnEbayMutation.mutate(); }, loading: listOnEbayMutation.isPending, disabled: listOnEbayMutation.isPending, children: "\uD83D\uDECD\uFE0F Publish to eBay" }), _jsx(Button, { fullWidth: true, icon: EditIcon, url: `/review/${draftId}/ebay-prep`, disabled: listOnEbayMutation.isPending, children: "Edit Listing Details" }), _jsx(Divider, {}), _jsx(Button, { fullWidth: true, variant: "plain", onClick: handleSkipEbay, disabled: listOnEbayMutation.isPending, children: "Skip eBay \u2014 Finish" }), _jsx(Button, { fullWidth: true, icon: ArrowLeftIcon, onClick: () => setWizardStep(2), disabled: listOnEbayMutation.isPending, children: "\u2190 Back" })] }) })) : (_jsx(Card, { children: _jsxs(BlockStack, { gap: "300", children: [_jsxs(InlineStack, { align: "space-between", blockAlign: "center", children: [_jsx(Text, { variant: "headingMd", as: "h2", children: "eBay Listing" }), _jsx(Badge, { tone: "success", children: "Live" })] }), _jsx(Badge, { tone: "success", children: `Listing #${ebaySuccess.listingId}` }), _jsx(Button, { fullWidth: true, icon: ExternalIcon, url: ebaySuccess.ebayUrl, target: "_blank", children: "View on eBay" }), _jsx(Button, { fullWidth: true, variant: "primary", onClick: handleFinish, children: nextId ? 'Next Draft →' : 'Back to Queue' })] }) })) }) })] }))] }), _jsx(Modal, { open: Boolean(lightboxSrc), onClose: () => setLightboxSrc(null), title: "Photo preview", primaryAction: { content: 'Close', onAction: () => setLightboxSrc(null) }, children: _jsx(Modal.Section, { children: _jsx(InlineStack, { align: "center", children: lightboxSrc ? _jsx(Thumbnail, { source: lightboxSrc, alt: "Enlarged photo", size: "large" }) : null }) }) }), editingPhotoIndex !== null && draft && editingPhotoUrl && (_jsx(ProductPhotoEditor, { open: true, imageUrl: editingPhotoUrl, draftId: draftId, imageIndex: editingPhotoIndex, allDraftImages: draftImages.length > 0 ? draftImages : liveImages, onSave: () => {
                    queryClient.invalidateQueries({ queryKey: ['draft-detail', draftId] });
                    setEditingPhotoIndex(null);
                    setEditingPhotoUrl(null);
                    addNotification({ type: 'success', title: 'Photo updated', message: 'Edited photo saved', autoClose: 4000 });
                }, onClose: () => { setEditingPhotoIndex(null); setEditingPhotoUrl(null); }, productId: draft.shopify_product_id }))] }));
};
export default ReviewDetail;
