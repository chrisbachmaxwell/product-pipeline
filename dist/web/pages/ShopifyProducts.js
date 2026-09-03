import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import React, { useMemo, useState, useCallback } from 'react';
import { Badge, Banner, Box, Button, Card, Divider, IndexTable, InlineStack, BlockStack, Layout, Page, Pagination, Spinner, Tabs, Text, TextField, Thumbnail, Icon, useIndexResourceState, } from '@shopify/polaris';
import { SearchIcon, ExternalSmallIcon, EditIcon, } from '@shopify/polaris-icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router-dom';
import { apiClient, useListings, useProductNotes, useSaveProductNotes, useTimCondition, useTagProductCondition, useRunPipeline } from '../hooks/useApi';
import { useAppStore } from '../store';
import PhotoControls from '../components/PhotoControls';
import ActivePhotosGallery from '../components/ActivePhotosGallery';
import EditPhotosPanel from '../components/EditPhotosPanel';
import ProductPhotoEditor from '../components/ProductPhotoEditor';
import TemplateManager from '../components/TemplateManager';
import InlineDraftApproval from '../components/InlineDraftApproval';
/* ── Simple markdown → HTML for AI description preview ── */
function mdInline(text) {
    return text
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .replace(/\*(.+?)\*/g, '<em>$1</em>')
        .replace(/`(.+?)`/g, '<code>$1</code>');
}
function markdownToHtml(md) {
    const cleaned = md
        .replace(/^\*\*Title line:\*\*\s*/gm, '')
        .replace(/^Title line:\s*/gm, '')
        .replace(/^\*\*Intro:\*\*\s*/gm, '')
        .replace(/^Intro:\s*/gm, '');
    const lines = cleaned.split('\n');
    const html = [];
    let inList = false;
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) {
            if (inList) {
                html.push('</ul>');
                inList = false;
            }
            continue;
        }
        if (trimmed.startsWith('### ')) {
            if (inList) {
                html.push('</ul>');
                inList = false;
            }
            html.push(`<h3>${mdInline(trimmed.slice(4))}</h3>`);
            continue;
        }
        if (trimmed.startsWith('## ')) {
            if (inList) {
                html.push('</ul>');
                inList = false;
            }
            html.push(`<h2>${mdInline(trimmed.slice(3))}</h2>`);
            continue;
        }
        if (trimmed.startsWith('# ')) {
            if (inList) {
                html.push('</ul>');
                inList = false;
            }
            html.push(`<h1>${mdInline(trimmed.slice(2))}</h1>`);
            continue;
        }
        const bullet = trimmed.match(/^[-*✔✅☑●•►▸]\s*(.+)/);
        if (bullet) {
            if (!inList) {
                html.push('<ul>');
                inList = true;
            }
            html.push(`<li>${mdInline(bullet[1])}</li>`);
            continue;
        }
        if (inList) {
            html.push('</ul>');
            inList = false;
        }
        html.push(`<p>${mdInline(trimmed)}</p>`);
    }
    if (inList)
        html.push('</ul>');
    return html.join('\n');
}
/* ────────────────────────── helpers ────────────────────────── */
const PLACEHOLDER_IMG = 'https://cdn.shopify.com/s/files/1/0533/2089/files/placeholder-images-image_large.png';
const formatMoney = (value) => {
    if (value === null || value === undefined || value === '')
        return '-';
    const numberValue = typeof value === 'string' ? Number(value) : value;
    if (Number.isNaN(numberValue))
        return '-';
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(numberValue);
};
const formatTimestamp = (value) => {
    if (!value)
        return '-';
    const ms = typeof value === 'number' ? (value > 1_000_000_000_000 ? value : value * 1000) : Date.parse(value);
    if (Number.isNaN(ms))
        return '-';
    return new Date(ms).toLocaleString();
};
const getShopifyStatusBadge = (status) => {
    const normalized = (status || '').toLowerCase();
    if (normalized === 'active')
        return _jsx(Badge, { tone: "success", children: "Active" });
    if (normalized === 'draft')
        return _jsx(Badge, { children: "Draft" });
    if (normalized === 'archived')
        return _jsx(Badge, { tone: "warning", children: "Archived" });
    return _jsx(Badge, { children: status || 'unknown' });
};
const getEbayBadge = (status) => {
    if (status === 'listed')
        return _jsx(Badge, { tone: "success", children: "Listed" });
    if (status === 'draft')
        return _jsx(Badge, { tone: "info", children: "Draft" });
    return _jsx(Text, { as: "span", tone: "subdued", children: "-" });
};
const StatusDot = ({ done, label }) => (_jsxs(InlineStack, { gap: "100", blockAlign: "center", wrap: false, children: [_jsx("span", { style: {
                display: 'inline-block',
                width: 8,
                height: 8,
                borderRadius: '50%',
                backgroundColor: done ? '#22c55e' : '#d1d5db',
            } }), label && _jsx(Text, { as: "span", tone: done ? undefined : 'subdued', variant: "bodySm", children: label })] }));
/* ──────────────────── Lightbox Component ──────────────────── */
const Lightbox = ({ src, alt, onClose }) => (_jsx("div", { onClick: onClose, style: {
        position: 'fixed',
        inset: 0,
        zIndex: 999999,
        background: 'rgba(0,0,0,0.85)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        cursor: 'zoom-out',
    }, children: _jsx("img", { src: src, alt: alt, style: { maxWidth: '90vw', maxHeight: '90vh', borderRadius: '8px', objectFit: 'contain' } }) }));
/* ──────────────────── ShopifyProductDetail ──────────────────── */
export const ShopifyProductDetail = () => {
    const { id } = useParams();
    const navigate = useNavigate();
    const queryClient = useQueryClient();
    const { addNotification } = useAppStore();
    const [galleryViewMode, setGalleryViewMode] = useState('side-by-side');
    const [selectedImageUrl, setSelectedImageUrl] = useState(null);
    const [previewUrl, setPreviewUrl] = useState(null);
    const [showPhotoControls, setShowPhotoControls] = useState(false);
    const [showEditHtml, setShowEditHtml] = useState(false);
    const [selectedPhotoIds, setSelectedPhotoIds] = useState([]);
    const [editPanelOpen, setEditPanelOpen] = useState(false);
    const [processingPhotos, setProcessingPhotos] = useState(new Set());
    const [showReviewModal, setShowReviewModal] = useState(false);
    const [pipelineResult, setPipelineResult] = useState(null);
    const [editingPhoto, setEditingPhoto] = useState(null);
    const [drivePipelineResult, setDrivePipelineResult] = useState(null);
    const drivePipelineMutation = useRunPipeline(id);
    React.useEffect(() => {
        if (drivePipelineMutation.data) {
            setDrivePipelineResult(drivePipelineMutation.data);
        }
    }, [drivePipelineMutation.data]);
    const { data: timData, isLoading: timLoading } = useTimCondition(id);
    const tagMutation = useTagProductCondition(id);
    const { data: notesData } = useProductNotes(id);
    const saveNotesMutation = useSaveProductNotes();
    const [localNotes, setLocalNotes] = useState('');
    const [notesInitialized, setNotesInitialized] = useState(false);
    React.useEffect(() => {
        if (notesData?.notes !== undefined && !notesInitialized) {
            setLocalNotes(notesData.notes);
            setNotesInitialized(true);
        }
    }, [notesData, notesInitialized]);
    React.useEffect(() => {
        setNotesInitialized(false);
    }, [id]);
    const { data: productInfo, isLoading: productLoading } = useQuery({
        queryKey: ['product-info', id],
        queryFn: () => apiClient.get(`/test/product-info/${id}`),
        enabled: Boolean(id),
    });
    const { data: pipelineStatus } = useQuery({
        queryKey: ['product-pipeline-status', id],
        queryFn: () => apiClient.get(`/products/${id}/pipeline-status`),
        enabled: Boolean(id),
        retry: 1,
    });
    const { data: pipelineJobs } = useQuery({
        queryKey: ['pipeline-jobs', id],
        queryFn: () => apiClient.get(`/pipeline/jobs?productId=${id}&limit=1`),
        enabled: Boolean(id),
        refetchInterval: 10000,
    });
    const { data: activePhotosData, isLoading: activePhotosLoading } = useQuery({
        queryKey: ['active-photos', id],
        queryFn: async () => {
            const productData = await apiClient.get(`/test/product-info/${id}`);
            const images = productData?.product?.images || [];
            return images.map((img) => ({
                id: img.id,
                position: img.position,
                src: img.src,
                alt: img.alt,
            }));
        },
        enabled: Boolean(id),
        refetchInterval: 10000,
    });
    const activePhotos = activePhotosData ?? [];
    const { data: imageData, isLoading: imagesLoading } = useQuery({
        queryKey: ['product-images', id],
        queryFn: () => apiClient.get(`/products/${id}/images`),
        enabled: Boolean(id),
        refetchInterval: 15000,
    });
    const galleryImages = imageData?.images ?? [];
    const editablePhotos = activePhotos.map(photo => {
        const galleryMatch = galleryImages.find(img => img.originalUrl === photo.src);
        return {
            id: photo.id,
            originalUrl: photo.src,
            alt: photo.alt,
            processing: processingPhotos.has(photo.id),
            processed: !!galleryMatch?.processedUrl,
            processedUrl: galleryMatch?.processedUrl,
        };
    });
    const { data: listingResponse } = useListings({ limit: 50, offset: 0, search: id });
    const listing = useMemo(() => {
        const normalized = (listingResponse?.data ?? []).map((item) => ({
            shopifyProductId: String(item.shopifyProductId ?? item.shopify_product_id ?? item.shopifyProductID ?? item.id ?? ''),
            ebayListingId: item.ebayListingId ?? item.ebay_listing_id ?? item.ebayItemId ?? null,
            status: item.status ?? 'inactive',
        }));
        return normalized.find((item) => item.shopifyProductId === id) ?? normalized[0] ?? null;
    }, [listingResponse, id]);
    const product = productInfo?.product;
    const variant = product?.variant ?? product?.variants?.[0];
    const images = product?.images ?? [];
    const pipelineJob = pipelineJobs?.jobs?.[0];
    const pipelineSteps = pipelineJob?.steps ?? [];
    const aiDescription = pipelineStatus?.status?.ai_description ?? null;
    const runPipelineMutation = useMutation({
        mutationFn: () => apiClient.post(`/auto-list/${id}`),
        onSuccess: async (result) => {
            if (result?.success || result?.ok) {
                setPipelineResult(result);
                addNotification({
                    type: 'success',
                    title: 'Pipeline completed!',
                    message: 'Review the results in the Review Queue.',
                    autoClose: 4000
                });
                try {
                    const draftData = await apiClient.get(`/drafts/product/${id}`);
                    if (draftData?.draft?.id) {
                        navigate(`/review/${draftData.draft.id}`);
                    }
                }
                catch { /* draft may not exist yet */ }
            }
            else {
                addNotification({
                    type: 'error',
                    title: 'Pipeline failed',
                    message: result?.error || 'AI processing did not return complete results. Try again.',
                });
            }
            queryClient.invalidateQueries({ queryKey: ['product-pipeline-status', id] });
            queryClient.invalidateQueries({ queryKey: ['pipeline-jobs', id] });
        },
        onError: (error) => {
            addNotification({
                type: 'error',
                title: 'Pipeline failed to start',
                message: error instanceof Error ? error.message : 'Unknown error',
            });
        },
    });
    const aiMutation = useMutation({
        mutationFn: () => apiClient.post(`/auto-list/${id}`),
        onSuccess: () => {
            addNotification({ type: 'success', title: 'AI description generated', autoClose: 4000 });
            queryClient.invalidateQueries({ queryKey: ['product-pipeline-status', id] });
        },
        onError: (error) => {
            addNotification({
                type: 'error',
                title: 'AI generation failed',
                message: error instanceof Error ? error.message : 'Unknown error',
            });
        },
    });
    const reprocessMutation = useMutation({
        mutationFn: ({ imageUrl, params }) => apiClient.post(`/products/${id}/images/reprocess`, {
            imageUrl,
            background: params.background,
            padding: params.padding,
            shadow: params.shadow,
        }),
        onSuccess: (data) => {
            setPreviewUrl(data?.processedUrl ?? null);
            queryClient.invalidateQueries({ queryKey: ['product-images', id] });
            addNotification({ type: 'success', title: 'Image reprocessed successfully', autoClose: 4000 });
        },
        onError: (error) => {
            addNotification({
                type: 'error',
                title: 'Reprocessing failed',
                message: error instanceof Error ? error.message : 'Unknown error',
            });
        },
    });
    const reprocessAllMutation = useMutation({
        mutationFn: (params) => apiClient.post(`/products/${id}/images/reprocess-all`, {
            background: params.background,
            padding: params.padding,
            shadow: params.shadow,
        }),
        onSuccess: (data) => {
            queryClient.invalidateQueries({ queryKey: ['product-images', id] });
            addNotification({
                type: 'success',
                title: 'All images reprocessed',
                message: `${data?.succeeded ?? 0} succeeded, ${data?.failed ?? 0} failed`,
                autoClose: 4000,
            });
        },
        onError: (error) => {
            addNotification({
                type: 'error',
                title: 'Bulk reprocessing failed',
                message: error instanceof Error ? error.message : 'Unknown error',
            });
        },
    });
    const handleReprocess = useCallback((imageUrl, params) => {
        setPreviewUrl(null);
        reprocessMutation.mutate({ imageUrl, params });
    }, [reprocessMutation]);
    const handleReprocessAll = useCallback((params) => {
        reprocessAllMutation.mutate(params);
    }, [reprocessAllMutation]);
    const handleSelectImage = useCallback((img) => {
        setSelectedImageUrl((prev) => (prev === img.originalUrl ? null : img.originalUrl));
        setPreviewUrl(null);
    }, []);
    const statusBadge = product?.status ? getShopifyStatusBadge(product.status) : null;
    const handleImageEditClick = useCallback((imageUrl) => {
        setSelectedImageUrl(imageUrl);
        setShowPhotoControls(true);
    }, []);
    const deleteSingleImageMutation = useMutation({
        mutationFn: (imageId) => apiClient.delete(`/products/${id}/images/${imageId}`),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['active-photos', id] });
            queryClient.invalidateQueries({ queryKey: ['product-images', id] });
            addNotification({ type: 'success', title: 'Image deleted', autoClose: 3000 });
        },
        onError: (error) => {
            addNotification({
                type: 'error',
                title: 'Delete failed',
                message: error instanceof Error ? error.message : 'Unknown error',
            });
        },
    });
    const deleteBulkImagesMutation = useMutation({
        mutationFn: (imageIds) => apiClient.delete(`/products/${id}/images`, { imageIds }),
        onSuccess: (data) => {
            queryClient.invalidateQueries({ queryKey: ['active-photos', id] });
            queryClient.invalidateQueries({ queryKey: ['product-images', id] });
            setSelectedPhotoIds([]);
            const succeeded = data?.succeeded || 0;
            const failed = data?.failed || 0;
            addNotification({
                type: 'success',
                title: `Deleted ${succeeded} image${succeeded !== 1 ? 's' : ''}${failed > 0 ? `, ${failed} failed` : ''}`,
                autoClose: 4000
            });
        },
        onError: (error) => {
            addNotification({
                type: 'error',
                title: 'Bulk delete failed',
                message: error instanceof Error ? error.message : 'Unknown error',
            });
        },
    });
    const applyChangesMutation = useMutation({
        mutationFn: async (selections) => {
            const promises = [];
            if (selections.description && pipelineResult?.description) {
                promises.push(apiClient.post('/test/update-product', {
                    productId: id,
                    body_html: markdownToHtml(pipelineResult.description)
                }));
            }
            if (selections.photos && pipelineResult?.images) {
                console.log('Applying processed photos:', pipelineResult.images);
            }
            if (selections.ebayListing) {
                promises.push(apiClient.post('/ebay/create-draft', {
                    productId: id,
                    description: pipelineResult?.description,
                    categoryId: pipelineResult?.categoryId,
                    images: pipelineResult?.images,
                }));
            }
            await Promise.all(promises);
        },
        onSuccess: () => {
            addNotification({
                type: 'success',
                title: 'Changes applied successfully!',
                autoClose: 4000
            });
            queryClient.invalidateQueries({ queryKey: ['product-info', id] });
            queryClient.invalidateQueries({ queryKey: ['draft', id] });
        },
        onError: (error) => {
            addNotification({
                type: 'error',
                title: 'Failed to apply changes',
                message: error instanceof Error ? error.message : 'Unknown error',
            });
        },
    });
    const { data: existingDraft } = useQuery({
        queryKey: ['draft', id],
        queryFn: () => apiClient.get(`/drafts/product/${id}`),
    });
    const handleProcessSinglePhoto = useCallback(async (photoId, params) => {
        const photo = activePhotos.find(p => p.id === photoId);
        if (!photo)
            return;
        setProcessingPhotos(prev => new Set(prev).add(photoId));
        try {
            await apiClient.post(`/products/${id}/images/reprocess`, {
                imageUrl: photo.src,
                ...params,
            });
            queryClient.invalidateQueries({ queryKey: ['product-images', id] });
            addNotification({ type: 'success', title: 'Photo processed', autoClose: 3000 });
        }
        catch (error) {
            addNotification({
                type: 'error',
                title: 'Processing failed',
                message: error instanceof Error ? error.message : 'Unknown error',
            });
        }
        finally {
            setProcessingPhotos(prev => {
                const next = new Set(prev);
                next.delete(photoId);
                return next;
            });
        }
    }, [activePhotos, id, queryClient, addNotification]);
    const handleProcessSelectedPhotos = useCallback(async (photoIds, params) => {
        setProcessingPhotos(prev => new Set([...prev, ...photoIds]));
        let successCount = 0;
        let errorCount = 0;
        for (const photoId of photoIds) {
            const photo = activePhotos.find(p => p.id === photoId);
            if (!photo)
                continue;
            try {
                await apiClient.post(`/products/${id}/images/reprocess`, {
                    imageUrl: photo.src,
                    ...params,
                });
                successCount++;
            }
            catch (error) {
                errorCount++;
            }
        }
        setProcessingPhotos(prev => {
            const next = new Set(prev);
            photoIds.forEach(id => next.delete(id));
            return next;
        });
        queryClient.invalidateQueries({ queryKey: ['product-images', id] });
        if (successCount > 0 && errorCount === 0) {
            addNotification({ type: 'success', title: `Processed ${successCount} photo${successCount !== 1 ? 's' : ''}`, autoClose: 3000 });
        }
        else if (successCount > 0) {
            addNotification({ type: 'warning', title: `Processed ${successCount}, ${errorCount} failed`, autoClose: 4000 });
        }
        else {
            addNotification({ type: 'error', title: `Failed to process ${errorCount} photo${errorCount !== 1 ? 's' : ''}`, autoClose: 4000 });
        }
    }, [activePhotos, id, queryClient, addNotification]);
    const handleProcessAllPhotos = useCallback(async (params) => {
        try {
            const result = await reprocessAllMutation.mutateAsync(params);
            addNotification({
                type: 'success',
                title: 'All photos processed',
                message: `${result?.succeeded ?? 0} succeeded, ${result?.failed ?? 0} failed`,
                autoClose: 4000,
            });
        }
        catch (error) {
            // Error handling is already in the mutation
        }
    }, [reprocessAllMutation, addNotification]);
    const handleEditPhotos = useCallback((photoIds) => {
        setSelectedPhotoIds(photoIds);
        setEditPanelOpen(true);
    }, []);
    const handleDeleteSingle = useCallback((imageId) => {
        deleteSingleImageMutation.mutate(imageId);
    }, [deleteSingleImageMutation]);
    const handleDeleteBulk = useCallback((imageIds) => {
        deleteBulkImagesMutation.mutate(imageIds);
    }, [deleteBulkImagesMutation]);
    const getStepDisplayName = useCallback((step) => {
        const stepMap = {
            fetch_product: 'Fetch Product',
            generate_description: 'Generate Description',
            process_images: 'Process Images',
            create_ebay_listing: 'Save to Review',
        };
        return stepMap[step] || step.replace(/_/g, ' ').replace(/\b\w/g, (l) => l.toUpperCase());
    }, []);
    // ── Derived state for status badges ──
    const timConditionLabel = timData?.match?.condition
        ? timData.match.condition.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
        : null;
    const ebayStatusLabel = listing?.ebayListingId
        ? listing.ebayListingId.startsWith('draft-') ? 'eBay Draft' : 'Listed on eBay'
        : null;
    return (_jsxs(_Fragment, { children: [_jsxs(Page, { title: product?.title ?? 'Loading product…', subtitle: product ? `${variant?.sku || 'No SKU'} · ${formatMoney(variant?.price)}` : undefined, titleMetadata: product ? (_jsxs(InlineStack, { gap: "200", children: [statusBadge, timConditionLabel && (_jsx(Badge, { tone: "info", children: timConditionLabel })), ebayStatusLabel && (_jsx(Badge, { tone: ebayStatusLabel === 'Listed on eBay' ? 'success' : 'attention', children: ebayStatusLabel }))] })) : undefined, backAction: { content: 'Products', onAction: () => navigate('/listings') }, primaryAction: {
                    content: '🚀 Run Pipeline',
                    onAction: () => runPipelineMutation.mutate(),
                    loading: runPipelineMutation.isPending,
                }, secondaryActions: product
                    ? [
                        {
                            content: 'Shopify Admin',
                            icon: ExternalSmallIcon,
                            url: `https://admin.shopify.com/store/usedcameragear/products/${id}`,
                            external: true,
                        },
                        ...(product?.handle ? [{
                                content: 'Live Page',
                                icon: ExternalSmallIcon,
                                url: `https://usedcameragear.myshopify.com/products/${product.handle}`,
                                external: true,
                            }] : []),
                        ...(listing?.ebayListingId && !listing.ebayListingId.startsWith('draft-') ? [{
                                content: 'View on eBay',
                                icon: ExternalSmallIcon,
                                url: `https://www.ebay.com/itm/${listing.ebayListingId}`,
                                external: true,
                            }] : []),
                    ]
                    : undefined, children: [productLoading && (_jsx("div", { style: { padding: '4rem', textAlign: 'center' }, children: _jsx(Spinner, { accessibilityLabel: "Loading product", size: "large" }) })), product && (_jsxs("div", { children: [existingDraft && existingDraft?.draft?.id && (_jsx("div", { style: { marginBottom: '16px' }, children: _jsx(Banner, { title: "Draft ready for review", tone: "info", action: {
                                        content: 'Review Now',
                                        onAction: () => navigate(`/review/${existingDraft.draft.id}`),
                                    }, children: _jsx("p", { children: "Pipeline has completed for this product. Review and apply the changes." }) }) })), _jsx(InlineDraftApproval, { productId: id }), drivePipelineResult && (_jsx("div", { style: { marginBottom: '16px' }, children: _jsx(Banner, { title: drivePipelineResult.success ? 'Drive Pipeline Complete' : 'Drive Pipeline Issue', tone: drivePipelineResult.success ? 'success' : 'warning', onDismiss: () => setDrivePipelineResult(null), children: drivePipelineResult.success ? (_jsxs(BlockStack, { gap: "100", children: [_jsxs(Text, { as: "p", variant: "bodySm", children: ["Found ", drivePipelineResult.photos?.count, " photos in ", drivePipelineResult.photos?.presetName, "/", drivePipelineResult.photos?.folderName] }), drivePipelineResult.description?.generated && _jsx(Text, { as: "p", variant: "bodySm", children: "\u2705 AI description generated" }), drivePipelineResult.condition?.tagApplied && _jsxs(Text, { as: "p", variant: "bodySm", children: ["\u2705 ", drivePipelineResult.condition.tag] })] })) : (_jsx(Text, { as: "p", variant: "bodySm", children: drivePipelineResult.error })) }) })), _jsxs(Layout, { children: [_jsx(Layout.Section, { children: _jsxs(BlockStack, { gap: "400", children: [_jsx(Card, { children: _jsxs(BlockStack, { gap: "400", children: [_jsxs(InlineStack, { align: "space-between", blockAlign: "center", children: [_jsxs(InlineStack, { gap: "300", blockAlign: "center", children: [_jsx(Text, { variant: "headingMd", as: "h2", children: "Photos" }), activePhotos.length > 0 && (_jsx(Badge, { children: `${activePhotos.length} photo${activePhotos.length !== 1 ? 's' : ''}` }))] }), activePhotos.length > 0 && (_jsx(Button, { size: "slim", onClick: () => setEditPanelOpen(prev => !prev), children: editPanelOpen ? 'Close Editor' : 'Edit Photos' }))] }), activePhotos.length === 0 && !activePhotosLoading ? (_jsx(Box, { padding: "800", borderWidth: "025", borderStyle: "dashed", borderColor: "border", borderRadius: "300", background: "bg-surface-secondary", children: _jsxs(BlockStack, { gap: "300", align: "center", children: [_jsx("div", { style: { fontSize: '36px', opacity: 0.4 }, children: "\uD83D\uDCF7" }), _jsx(Text, { variant: "headingSm", as: "h3", tone: "subdued", children: "No photos yet" }), _jsx(Text, { variant: "bodySm", as: "p", tone: "subdued", children: "Run the pipeline to search Google Drive for photos, or upload them in Shopify Admin." }), _jsx("div", { style: { marginTop: '8px' }, children: _jsx(Button, { size: "slim", onClick: () => drivePipelineMutation.mutate(), loading: drivePipelineMutation.isPending, children: "\uD83D\uDCF8 Search Drive for Photos" }) })] }) })) : (_jsx(ActivePhotosGallery, { photos: activePhotos, loading: activePhotosLoading, onDeleteSingle: handleDeleteSingle, onDeleteBulk: handleDeleteBulk, onEditPhotos: handleEditPhotos, onSelectionChange: setSelectedPhotoIds, onEditPhoto: (photo, index) => setEditingPhoto({ photo, index }) }))] }) }), _jsx(EditPhotosPanel, { photos: editablePhotos, selectedPhotoIds: selectedPhotoIds, isOpen: editPanelOpen, onToggle: () => setEditPanelOpen(prev => !prev), onProcessSingle: handleProcessSinglePhoto, onProcessSelected: handleProcessSelectedPhotos, onProcessAll: handleProcessAllPhotos, processing: reprocessAllMutation.isPending || processingPhotos.size > 0 }), aiDescription && (_jsx(Card, { children: _jsx("div", { style: {
                                                            padding: '16px',
                                                            background: 'linear-gradient(135deg, #f0f9ff 0%, #e0f2fe 100%)',
                                                            borderRadius: '12px',
                                                            border: '2px solid #0ea5e9',
                                                            margin: '-16px',
                                                        }, children: _jsxs(BlockStack, { gap: "300", children: [_jsxs(InlineStack, { align: "space-between", blockAlign: "center", children: [_jsxs(InlineStack, { gap: "200", blockAlign: "center", children: [_jsx(Text, { variant: "headingSm", as: "h3", children: "\uD83E\uDD16 AI Generated Description" }), _jsx(Badge, { tone: "info", children: "Ready to Apply" })] }), _jsxs(InlineStack, { gap: "200", children: [_jsx(Button, { variant: "primary", size: "slim", onClick: async () => {
                                                                                        try {
                                                                                            await apiClient.post(`/products/${id}/apply-ai-description`);
                                                                                            addNotification({
                                                                                                type: 'success',
                                                                                                title: 'Description updated',
                                                                                                message: 'AI description has been applied to your product',
                                                                                                autoClose: 4000
                                                                                            });
                                                                                            queryClient.invalidateQueries({ queryKey: ['product-info', id] });
                                                                                        }
                                                                                        catch (error) {
                                                                                            addNotification({
                                                                                                type: 'error',
                                                                                                title: 'Update failed',
                                                                                                message: error instanceof Error ? error.message : 'Failed to update product description',
                                                                                            });
                                                                                        }
                                                                                    }, children: "Apply Description" }), _jsx(Button, { size: "slim", onClick: () => {
                                                                                        queryClient.setQueryData(['product-pipeline-status', id], (old) => ({
                                                                                            ...old,
                                                                                            status: { ...old?.status, ai_description: null }
                                                                                        }));
                                                                                    }, children: "Dismiss" })] })] }), _jsx("div", { style: {
                                                                        maxHeight: '300px',
                                                                        overflow: 'auto',
                                                                        padding: '16px',
                                                                        background: '#ffffff',
                                                                        borderRadius: '8px',
                                                                        border: '1px solid #bae6fd',
                                                                        fontSize: '14px',
                                                                        lineHeight: '1.7',
                                                                        color: '#1a1a1a',
                                                                    }, dangerouslySetInnerHTML: { __html: markdownToHtml(aiDescription) } })] }) }) })), _jsx(Card, { children: _jsxs(BlockStack, { gap: "400", children: [_jsxs(InlineStack, { align: "space-between", blockAlign: "center", children: [_jsx(Text, { variant: "headingMd", as: "h2", children: "Description" }), _jsx(Button, { icon: EditIcon, onClick: () => aiMutation.mutate(), loading: aiMutation.isPending, size: "slim", children: "Regenerate with AI" })] }), product.body_html ? (_jsxs(_Fragment, { children: [_jsx("div", { style: {
                                                                            maxHeight: '400px',
                                                                            overflow: 'auto',
                                                                            padding: '20px',
                                                                            background: '#f9fafb',
                                                                            borderRadius: '8px',
                                                                            border: '1px solid #e3e5e7',
                                                                            fontSize: '14px',
                                                                            lineHeight: '1.7',
                                                                            color: '#1a1a1a',
                                                                        }, dangerouslySetInnerHTML: { __html: product.body_html } }), _jsxs("details", { children: [_jsx("summary", { style: {
                                                                                    padding: '8px 12px',
                                                                                    background: '#f8f9fa',
                                                                                    borderRadius: '6px',
                                                                                    border: '1px solid #e5e7eb',
                                                                                    cursor: 'pointer',
                                                                                    fontFamily: 'SF Mono, Monaco, monospace',
                                                                                    fontSize: '13px',
                                                                                    userSelect: 'none',
                                                                                    color: '#6b7280',
                                                                                }, children: "View HTML source" }), _jsx("div", { style: {
                                                                                    marginTop: '8px',
                                                                                    maxHeight: '200px',
                                                                                    overflow: 'auto',
                                                                                    padding: '16px',
                                                                                    background: '#1e1e1e',
                                                                                    color: '#d4d4d4',
                                                                                    borderRadius: '8px',
                                                                                    fontFamily: 'SF Mono, Monaco, Consolas, monospace',
                                                                                    fontSize: '12px',
                                                                                    lineHeight: '1.5'
                                                                                }, children: _jsx("pre", { style: { margin: 0, whiteSpace: 'pre-wrap' }, children: product.body_html }) })] })] })) : (_jsxs("div", { style: { textAlign: 'center', padding: '40px 20px' }, children: [_jsx("div", { style: { fontSize: '32px', opacity: 0.3, marginBottom: '12px' }, children: "\uD83D\uDCDD" }), _jsx(Text, { variant: "headingSm", as: "h3", tone: "subdued", children: "No description yet" }), _jsx(Text, { variant: "bodySm", tone: "subdued", as: "p", children: "Run the pipeline or click \"Regenerate with AI\" to create a description." })] }))] }) }), _jsx(Card, { children: _jsxs(BlockStack, { gap: "300", children: [_jsxs(InlineStack, { align: "space-between", blockAlign: "center", children: [_jsxs(InlineStack, { gap: "200", blockAlign: "center", children: [_jsx(Text, { variant: "headingMd", as: "h2", children: "Notes" }), localNotes.trim() && _jsx(Badge, { tone: "attention", children: "Has Notes" })] }), _jsx(Button, { variant: "primary", size: "slim", onClick: () => {
                                                                            if (id)
                                                                                saveNotesMutation.mutate({ productId: id, notes: localNotes });
                                                                        }, loading: saveNotesMutation.isPending, disabled: !id || localNotes === (notesData?.notes ?? ''), children: "Save" })] }), _jsx(TextField, { label: "", labelHidden: true, value: localNotes, onChange: setLocalNotes, multiline: 3, placeholder: "Condition notes, blemishes, missing accessories\u2026 Included in AI descriptions.", autoComplete: "off", onBlur: () => {
                                                                    if (id && localNotes !== (notesData?.notes ?? '')) {
                                                                        saveNotesMutation.mutate({ productId: id, notes: localNotes });
                                                                    }
                                                                } })] }) }), _jsx(TemplateManager, { productId: id, onApplied: () => {
                                                        queryClient.invalidateQueries({ queryKey: ['product-images', id] });
                                                    } })] }) }), _jsx(Layout.Section, { variant: "oneThird", children: _jsxs(BlockStack, { gap: "400", children: [_jsx(Card, { children: _jsxs(BlockStack, { gap: "400", children: [_jsxs(InlineStack, { align: "space-between", blockAlign: "center", children: [_jsx(Text, { variant: "headingMd", as: "h2", children: "Pipeline" }), pipelineJob?.status && (_jsx(Badge, { tone: pipelineJob.status === 'completed' ? 'success' :
                                                                            pipelineJob.status === 'failed' ? 'critical' :
                                                                                pipelineJob.status === 'running' ? 'attention' : 'info', children: pipelineJob.status }))] }), pipelineSteps.length === 0 ? (_jsxs("div", { style: { textAlign: 'center', padding: '16px 0' }, children: [_jsx("div", { style: { fontSize: '28px', opacity: 0.3, marginBottom: '8px' }, children: "\u26A1" }), _jsx(Text, { variant: "bodySm", tone: "subdued", as: "p", children: "No pipeline runs yet" })] })) : (_jsx(BlockStack, { gap: "0", children: pipelineSteps.map((step, index) => {
                                                                    const isLast = index === pipelineSteps.length - 1;
                                                                    const isDone = step.status === 'done';
                                                                    const isError = step.status === 'error';
                                                                    const isRunning = step.status === 'running';
                                                                    return (_jsx("div", { style: { padding: '2px 4px' }, children: _jsxs(InlineStack, { gap: "300", blockAlign: "start", children: [_jsxs("div", { style: { position: 'relative', marginTop: '2px' }, children: [_jsxs("div", { style: {
                                                                                                width: '16px',
                                                                                                height: '16px',
                                                                                                borderRadius: '50%',
                                                                                                border: `2px solid ${isDone ? '#22c55e' :
                                                                                                    isError ? '#ef4444' :
                                                                                                        isRunning ? '#f59e0b' : '#d1d5db'}`,
                                                                                                backgroundColor: isDone ? '#22c55e' : '#ffffff',
                                                                                                position: 'relative',
                                                                                                zIndex: 1
                                                                                            }, children: [isDone && (_jsx("svg", { viewBox: "0 0 12 12", style: { position: 'absolute', inset: '1px', fill: '#fff' }, children: _jsx("path", { d: "M10 3L4.5 8.5 2 6", stroke: "#fff", strokeWidth: "2", fill: "none", strokeLinecap: "round", strokeLinejoin: "round" }) })), isRunning && (_jsx("div", { style: {
                                                                                                        position: 'absolute',
                                                                                                        inset: '2px',
                                                                                                        borderRadius: '50%',
                                                                                                        backgroundColor: '#f59e0b',
                                                                                                        opacity: 0.7
                                                                                                    } }))] }), !isLast && (_jsx("div", { style: {
                                                                                                position: 'absolute',
                                                                                                top: '18px',
                                                                                                left: '50%',
                                                                                                transform: 'translateX(-50%)',
                                                                                                width: '2px',
                                                                                                height: '20px',
                                                                                                backgroundColor: isDone ? '#22c55e' : '#e5e7eb'
                                                                                            } }))] }), _jsxs("div", { style: { flex: 1, paddingBottom: isLast ? '0' : '12px' }, children: [_jsxs(InlineStack, { align: "space-between", blockAlign: "center", children: [_jsx(Text, { as: "span", variant: "bodySm", fontWeight: isDone ? 'medium' : 'regular', tone: isError ? 'critical' : undefined, children: getStepDisplayName(step.name) }), _jsx(Text, { as: "span", variant: "bodySm", tone: isDone ? 'success' : isError ? 'critical' : 'subdued', children: isDone ? '✓' : isError ? '✗' : isRunning ? '⋯' : '○' })] }), step.error && (_jsx(Text, { variant: "bodySm", tone: "critical", as: "p", children: step.error }))] })] }) }, step.name));
                                                                }) })), _jsx(Divider, {}), _jsx(Button, { fullWidth: true, onClick: () => drivePipelineMutation.mutate(), loading: drivePipelineMutation.isPending, size: "slim", children: "\uD83D\uDCF8 Search Drive for Photos" })] }) }), _jsx(Card, { children: _jsxs(BlockStack, { gap: "300", children: [_jsx(Text, { variant: "headingMd", as: "h2", children: "Details" }), _jsx(Divider, {}), _jsxs(BlockStack, { gap: "200", children: [_jsxs(InlineStack, { align: "space-between", children: [_jsx(Text, { variant: "bodySm", tone: "subdued", as: "span", children: "Price" }), _jsx(Text, { variant: "bodySm", fontWeight: "medium", as: "span", children: formatMoney(variant?.price ?? null) })] }), variant?.compare_at_price && (_jsxs(InlineStack, { align: "space-between", children: [_jsx(Text, { variant: "bodySm", tone: "subdued", as: "span", children: "Compare-at" }), _jsx(Text, { variant: "bodySm", as: "span", children: formatMoney(variant.compare_at_price) })] })), _jsxs(InlineStack, { align: "space-between", children: [_jsx(Text, { variant: "bodySm", tone: "subdued", as: "span", children: "SKU" }), _jsx("span", { style: { fontFamily: 'SF Mono, monospace', fontSize: '13px' }, children: variant?.sku ?? '—' })] }), variant?.barcode && (_jsxs(InlineStack, { align: "space-between", children: [_jsx(Text, { variant: "bodySm", tone: "subdued", as: "span", children: "Barcode" }), _jsx("span", { style: { fontFamily: 'SF Mono, monospace', fontSize: '13px' }, children: variant.barcode })] })), _jsxs(InlineStack, { align: "space-between", children: [_jsx(Text, { variant: "bodySm", tone: "subdued", as: "span", children: "Inventory" }), _jsx(Text, { variant: "bodySm", fontWeight: "medium", as: "span", children: variant?.inventory_quantity ?? '—' })] }), product.vendor && (_jsxs(InlineStack, { align: "space-between", children: [_jsx(Text, { variant: "bodySm", tone: "subdued", as: "span", children: "Vendor" }), _jsx(Text, { variant: "bodySm", as: "span", children: product.vendor })] })), product.product_type && (_jsxs(InlineStack, { align: "space-between", children: [_jsx(Text, { variant: "bodySm", tone: "subdued", as: "span", children: "Type" }), _jsx(Text, { variant: "bodySm", as: "span", children: product.product_type })] }))] }), product.tags && (_jsxs(_Fragment, { children: [_jsx(Divider, {}), _jsx(InlineStack, { gap: "100", wrap: true, children: (typeof product.tags === 'string' ? product.tags.split(',') : product.tags)
                                                                            .filter((t) => t.trim())
                                                                            .map((tag) => (_jsx(Badge, { children: tag.trim() }, tag.trim()))) })] }))] }) }), (timData?.match || timLoading) && (_jsx(Card, { children: _jsxs(BlockStack, { gap: "300", children: [_jsxs(InlineStack, { align: "space-between", blockAlign: "center", children: [_jsx(Text, { variant: "headingMd", as: "h2", children: "Condition" }), timConditionLabel && (_jsx(Badge, { tone: timData.match.condition === 'like_new_minus' || timData.match.condition === 'excellent_plus' ? 'success' :
                                                                            timData.match.condition === 'excellent' ? 'success' :
                                                                                timData.match.condition === 'poor' || timData.match.condition === 'ugly' ? 'warning' : 'info', children: timConditionLabel }))] }), timLoading ? (_jsx("div", { style: { padding: '8px', textAlign: 'center' }, children: _jsx(Spinner, { size: "small" }) })) : timData?.match ? (_jsxs(BlockStack, { gap: "200", children: [timData.match.conditionNotes && (_jsx(Text, { variant: "bodySm", as: "p", children: timData.match.conditionNotes })), timData.match.graderNotes && (_jsx(Text, { variant: "bodySm", tone: "subdued", as: "p", children: timData.match.graderNotes })), timData.match.serialNumber && (_jsxs(InlineStack, { align: "space-between", children: [_jsx(Text, { variant: "bodySm", tone: "subdued", as: "span", children: "Serial #" }), _jsx("span", { style: { fontFamily: 'SF Mono, monospace', fontSize: '13px' }, children: timData.match.serialNumber })] })), _jsx(Divider, {}), _jsxs(InlineStack, { align: "space-between", blockAlign: "center", children: [(() => {
                                                                                const tags = typeof product.tags === 'string' ? product.tags.split(',').map((t) => t.trim()) : (product.tags ?? []);
                                                                                const conditionTag = tags.find((t) => t.startsWith('condition-'));
                                                                                return conditionTag ? (_jsx(Badge, { tone: "success", children: conditionTag })) : (_jsx(Badge, { tone: "attention", children: "Not tagged" }));
                                                                            })(), timData.match.condition && (_jsx(Button, { size: "slim", onClick: () => tagMutation.mutate(), loading: tagMutation.isPending, children: (() => {
                                                                                    const tags = typeof product.tags === 'string' ? product.tags.split(',').map((t) => t.trim()) : (product.tags ?? []);
                                                                                    const conditionTag = tags.find((t) => t.startsWith('condition-'));
                                                                                    return conditionTag ? 'Update Tag' : 'Tag Product';
                                                                                })() }))] }), tagMutation.isSuccess && tagMutation.data && (_jsx(Banner, { tone: "success", onDismiss: () => tagMutation.reset(), children: tagMutation.data.newTag
                                                                            ? `Tagged: ${tagMutation.data.newTag}`
                                                                            : 'Tag applied successfully' })), tagMutation.isError && (_jsx(Banner, { tone: "critical", onDismiss: () => tagMutation.reset(), children: "Failed to apply tag" }))] })) : null] }) })), listing?.ebayListingId && (_jsx(Card, { children: _jsxs(BlockStack, { gap: "300", children: [_jsxs(InlineStack, { align: "space-between", blockAlign: "center", children: [_jsx(Text, { variant: "headingMd", as: "h2", children: "eBay" }), listing.ebayListingId.startsWith('draft-') ? (_jsx(Badge, { tone: "attention", children: "Draft" })) : (_jsx(Badge, { tone: listing.status === 'active' || listing.status === 'synced' ? 'success' : 'info', children: listing.status === 'synced' ? 'Live' : listing.status }))] }), _jsxs(InlineStack, { align: "space-between", children: [_jsx(Text, { variant: "bodySm", tone: "subdued", as: "span", children: "Item ID" }), _jsx("span", { style: { fontFamily: 'SF Mono, monospace', fontSize: '13px' }, children: listing.ebayListingId })] }), _jsxs(BlockStack, { gap: "200", children: [!listing.ebayListingId.startsWith('draft-') && (_jsx(Button, { fullWidth: true, size: "slim", url: `https://www.ebay.com/itm/${listing.ebayListingId}`, external: true, children: "View on eBay" })), _jsx(Button, { fullWidth: true, variant: "plain", size: "slim", onClick: () => navigate(`/ebay/listings/${listing.shopifyProductId}`), children: "Listing Details" })] })] }) }))] }) })] })] })), showPhotoControls && (_jsx("div", { style: { marginTop: '1rem' }, children: _jsx(PhotoControls, { selectedImageUrl: selectedImageUrl, onReprocess: handleReprocess, onReprocessAll: handleReprocessAll, reprocessing: reprocessMutation.isPending, reprocessingAll: reprocessAllMutation.isPending, previewUrl: previewUrl, imageCount: images.length }) })), _jsx("div", { style: { height: '2rem' } })] }), editingPhoto && (_jsx(ProductPhotoEditor, { open: true, imageUrl: editingPhoto.photo.src, imageIndex: editingPhoto.index, productId: id, allDraftImages: activePhotos.map(p => p.src), onSave: () => {
                    queryClient.invalidateQueries({ queryKey: ['active-photos', id] });
                    queryClient.invalidateQueries({ queryKey: ['product-info', id] });
                    setEditingPhoto(null);
                    addNotification({ type: 'success', title: 'Photo updated', message: 'Edited photo saved to Shopify', autoClose: 4000 });
                }, onClose: () => setEditingPhoto(null), onCustomSave: async (blob) => {
                    // Convert blob to base64
                    const reader = new FileReader();
                    const base64 = await new Promise((resolve, reject) => {
                        reader.onload = () => {
                            const result = reader.result;
                            // Strip data:image/png;base64, prefix
                            resolve(result.split(',')[1]);
                        };
                        reader.onerror = reject;
                        reader.readAsDataURL(blob);
                    });
                    // Replace image on Shopify via API
                    const res = await fetch(`/api/products/${id}/images/${editingPhoto.photo.id}`, {
                        method: 'PUT',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            attachment: base64,
                            filename: `edited-${editingPhoto.photo.id}-${Date.now()}.png`,
                            position: editingPhoto.photo.position,
                        }),
                    });
                    if (!res.ok) {
                        const data = await res.json().catch(() => ({ error: 'Replace failed' }));
                        throw new Error(data.error || `Replace failed (${res.status})`);
                    }
                    // Trigger onSave to refresh
                    queryClient.invalidateQueries({ queryKey: ['active-photos', id] });
                    queryClient.invalidateQueries({ queryKey: ['product-info', id] });
                    setEditingPhoto(null);
                    addNotification({ type: 'success', title: 'Photo updated', message: 'Edited photo saved to Shopify', autoClose: 4000 });
                } }))] }));
};
/* ──────────────────── ShopifyProducts (list) ──────────────────── */
const TAB_FILTERS = [
    { id: 'all', content: 'All' },
    { id: 'draft', content: 'Draft' },
    { id: 'active', content: 'Active' },
    { id: 'needs_description', content: 'Needs Description' },
    { id: 'needs_images', content: 'Needs Images' },
    { id: 'listed', content: 'On eBay' },
];
const ShopifyProducts = () => {
    const navigate = useNavigate();
    const { addNotification } = useAppStore();
    const [searchValue, setSearchValue] = useState('');
    const [selectedTab, setSelectedTab] = useState(0);
    const [page, setPage] = useState(1);
    const pageSize = 50;
    const { data, isLoading, error } = useQuery({
        queryKey: ['products-overview'],
        queryFn: () => apiClient.get('/products/overview'),
        refetchInterval: 30000,
    });
    const products = useMemo(() => data?.products ?? [], [data?.products]);
    const tabCounts = useMemo(() => {
        const nonArchived = products.filter((p) => (p.shopifyStatus ?? '').toLowerCase() !== 'archived');
        return {
            all: nonArchived.length,
            draft: nonArchived.filter((p) => (p.shopifyStatus ?? '').toLowerCase() === 'draft').length,
            active: nonArchived.filter((p) => (p.shopifyStatus ?? '').toLowerCase() === 'active').length,
            needs_description: nonArchived.filter((p) => !p.hasAiDescription).length,
            needs_images: nonArchived.filter((p) => !p.hasProcessedImages).length,
            listed: nonArchived.filter((p) => p.ebayStatus === 'listed' || p.ebayStatus === 'draft').length,
        };
    }, [products]);
    const tabs = useMemo(() => TAB_FILTERS.map((tab) => ({
        ...tab,
        content: `${tab.content} (${tabCounts[tab.id]})`,
    })), [tabCounts]);
    const statusFilter = useMemo(() => {
        return TAB_FILTERS[selectedTab]?.id ?? 'all';
    }, [selectedTab]);
    const filtered = useMemo(() => {
        const query = searchValue.trim().toLowerCase();
        return products.filter((product) => {
            if ((product.shopifyStatus ?? '').toLowerCase() === 'archived')
                return false;
            const matchesQuery = !query || product.title.toLowerCase().includes(query) || product.sku.toLowerCase().includes(query);
            if (!matchesQuery)
                return false;
            const productStatus = (product.shopifyStatus ?? '').toLowerCase();
            switch (statusFilter) {
                case 'draft': return productStatus === 'draft';
                case 'active': return productStatus === 'active';
                case 'needs_description': return !product.hasAiDescription;
                case 'needs_images': return !product.hasProcessedImages;
                case 'listed': return product.ebayStatus === 'listed' || product.ebayStatus === 'draft';
                default: return true;
            }
        });
    }, [products, searchValue, statusFilter]);
    const sorted = useMemo(() => {
        const rank = { draft: 0, active: 1 };
        return [...filtered].sort((a, b) => {
            const ra = rank[(a.shopifyStatus ?? '').toLowerCase()] ?? 2;
            const rb = rank[(b.shopifyStatus ?? '').toLowerCase()] ?? 2;
            if (ra !== rb)
                return ra - rb;
            return a.title.localeCompare(b.title);
        });
    }, [filtered]);
    const totalPages = Math.max(1, Math.ceil(sorted.length / pageSize));
    const currentPage = Math.min(page, totalPages);
    const pageItems = sorted.slice((currentPage - 1) * pageSize, currentPage * pageSize);
    const { selectedResources, allResourcesSelected, handleSelectionChange } = useIndexResourceState(pageItems, { resourceIDResolver: (p) => p.shopifyProductId });
    const [bulkRunning, setBulkRunning] = useState(false);
    const [bulkProgress, setBulkProgress] = useState(null);
    const handleBulkRunPipeline = useCallback(async () => {
        const ids = selectedResources;
        if (ids.length === 0)
            return;
        setBulkRunning(true);
        setBulkProgress({ done: 0, total: ids.length });
        for (let i = 0; i < ids.length; i++) {
            const product = pageItems.find((p) => p.shopifyProductId === ids[i]);
            setBulkProgress({ done: i, total: ids.length, current: product?.title || ids[i] });
            try {
                await fetch(`/api/pipeline/trigger/${ids[i]}`, { method: 'POST' });
            }
            catch {
                // continue with next
            }
        }
        setBulkProgress({ done: ids.length, total: ids.length });
        setBulkRunning(false);
        setTimeout(() => setBulkProgress(null), 3000);
        handleSelectionChange('page', false);
    }, [selectedResources, pageItems, handleSelectionChange]);
    const bulkActions = [
        {
            content: bulkRunning
                ? `Running pipeline (${bulkProgress?.done ?? 0}/${bulkProgress?.total ?? 0})...`
                : `Run Pipeline (${selectedResources.length})`,
            onAction: handleBulkRunPipeline,
            disabled: bulkRunning,
        },
    ];
    const handleTabChange = useCallback((index) => {
        if (index >= 0 && index < TAB_FILTERS.length) {
            setSelectedTab(index);
            setPage(1);
        }
    }, []);
    const rowMarkup = pageItems.map((product, index) => (_jsxs(IndexTable.Row, { id: product.shopifyProductId, position: index, selected: selectedResources.includes(product.shopifyProductId), onClick: () => navigate(`/listings/${product.shopifyProductId}`), children: [_jsx(IndexTable.Cell, { children: _jsxs(InlineStack, { gap: "300", blockAlign: "center", wrap: false, children: [_jsx(Thumbnail, { size: "extraSmall", source: product.imageUrl || PLACEHOLDER_IMG, alt: product.title }), _jsxs(BlockStack, { gap: "050", children: [_jsxs(InlineStack, { gap: "200", blockAlign: "center", wrap: false, children: [_jsx(Text, { as: "span", variant: "bodyMd", fontWeight: "semibold", children: product.title }), getShopifyStatusBadge(product.shopifyStatus)] }), product.sku && (_jsx(Text, { as: "span", variant: "bodySm", tone: "subdued", children: product.sku }))] })] }) }), _jsx(IndexTable.Cell, { children: _jsx(Text, { as: "span", variant: "bodyMd", children: formatMoney(product.price) }) }), _jsx(IndexTable.Cell, { children: _jsx(StatusDot, { done: product.hasAiDescription }) }), _jsx(IndexTable.Cell, { children: _jsx(StatusDot, { done: product.hasProcessedImages }) }), _jsx(IndexTable.Cell, { children: getEbayBadge(product.ebayStatus) })] }, product.shopifyProductId)));
    const summary = data?.summary ?? {
        total: 0,
        withDescriptions: 0,
        withProcessedImages: 0,
        listedOnEbay: 0,
        draftOnEbay: 0,
    };
    return (_jsx(Page, { title: "Products", subtitle: `${summary.total.toLocaleString()} products · ${summary.withDescriptions} descriptions · ${summary.withProcessedImages} images · ${summary.listedOnEbay + summary.draftOnEbay} on eBay`, fullWidth: true, children: _jsxs(BlockStack, { gap: "0", children: [_jsxs(Card, { padding: "0", children: [_jsx(Tabs, { tabs: tabs, selected: selectedTab, onSelect: handleTabChange }), _jsx(Box, { padding: "300", children: _jsx(TextField, { label: "", placeholder: "Search products\u2026", value: searchValue, onChange: (value) => { setSearchValue(value); setPage(1); }, prefix: _jsx(Icon, { source: SearchIcon }), clearButton: true, onClearButtonClick: () => setSearchValue(''), autoComplete: "off" }) }), error && (_jsx(Box, { padding: "300", children: _jsx(Banner, { tone: "critical", title: "Unable to load products", children: _jsx("p", { children: error instanceof Error ? error.message : 'Something went wrong.' }) }) })), isLoading ? (_jsx(Box, { padding: "800", children: _jsx(InlineStack, { align: "center", children: _jsx(Spinner, { accessibilityLabel: "Loading products", size: "large" }) }) })) : (_jsx(IndexTable, { resourceName: { singular: 'product', plural: 'products' }, itemCount: pageItems.length, selectable: true, selectedItemsCount: allResourcesSelected ? 'All' : selectedResources.length, onSelectionChange: handleSelectionChange, bulkActions: bulkActions, headings: [
                                { title: 'Product' },
                                { title: 'Price' },
                                { title: 'AI Desc' },
                                { title: 'Images' },
                                { title: 'eBay' },
                            ], children: rowMarkup }))] }), _jsx(Box, { padding: "400", children: _jsxs(InlineStack, { align: "center", gap: "400", children: [_jsx(Text, { tone: "subdued", as: "p", children: sorted.length === 0
                                    ? 'No products match your filters'
                                    : `Showing ${(currentPage - 1) * pageSize + 1}-${Math.min(currentPage * pageSize, sorted.length)} of ${sorted.length}` }), _jsx(Pagination, { hasPrevious: currentPage > 1, onPrevious: () => setPage((prev) => Math.max(1, prev - 1)), hasNext: currentPage < totalPages, onNext: () => setPage((prev) => Math.min(totalPages, prev + 1)) })] }) })] }) }));
};
export default ShopifyProducts;
