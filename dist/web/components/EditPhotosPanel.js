import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState, useCallback } from 'react';
import { Badge, Banner, BlockStack, Box, Button, Card, Collapsible, Divider, InlineStack, ProgressBar, Spinner, Text, Thumbnail, } from '@shopify/polaris';
import { ChevronUp, ChevronDown, RefreshCw, RotateCcw } from 'lucide-react';
import PhotoControls from './PhotoControls';
const PLACEHOLDER_IMG = 'https://cdn.shopify.com/s/files/1/0533/2089/files/placeholder-images-image_large.png';
const EditPhotosPanel = ({ photos, selectedPhotoIds, isOpen, onToggle, onProcessSingle, onProcessSelected, onProcessAll, onRevertToOriginal, processing = false, }) => {
    const [params, setParams] = useState({
        background: '#FFFFFF',
        padding: 0.1,
        shadow: true,
    });
    const selectedPhotos = photos.filter(p => selectedPhotoIds.includes(p.id));
    const hasSelection = selectedPhotoIds.length > 0;
    const allPhotosCount = photos.length;
    // Calculate processing progress
    const processingCount = photos.filter(p => p.processing).length;
    const processedCount = photos.filter(p => p.processed).length;
    const errorCount = photos.filter(p => p.error).length;
    const handleApplyToSelected = useCallback(async () => {
        if (selectedPhotoIds.length === 0)
            return;
        await onProcessSelected(selectedPhotoIds, params);
    }, [selectedPhotoIds, params, onProcessSelected]);
    const handleApplyToAll = useCallback(async () => {
        await onProcessAll(params);
    }, [params, onProcessAll]);
    // Show progress when any photos are processing
    const showProgress = processingCount > 0;
    const progressValue = showProgress ?
        ((processedCount + errorCount) / (processedCount + errorCount + processingCount)) * 100 :
        100;
    return (_jsx(Card, { children: _jsxs(BlockStack, { gap: "400", children: [_jsxs(InlineStack, { align: "space-between", blockAlign: "center", children: [_jsxs(InlineStack, { gap: "200", blockAlign: "center", children: [_jsx(Text, { variant: "headingMd", as: "h2", children: "Edit Photos with PhotoRoom" }), hasSelection && (_jsx(Badge, { tone: "info", children: `${selectedPhotoIds.length} selected` }))] }), _jsxs(Button, { onClick: onToggle, icon: isOpen ? _jsx(ChevronUp, { size: 16 }) : _jsx(ChevronDown, { size: 16 }), variant: "plain", children: [isOpen ? 'Hide' : 'Show', " Editor"] })] }), _jsx(Collapsible, { id: "edit-photos-collapsible", open: isOpen, children: _jsxs(BlockStack, { gap: "400", children: [showProgress && (_jsx(Box, { padding: "200", background: "bg-surface-secondary", borderRadius: "200", children: _jsxs(BlockStack, { gap: "200", children: [_jsxs(InlineStack, { align: "space-between", blockAlign: "center", children: [_jsxs(Text, { variant: "bodySm", as: "span", children: ["Processing ", processingCount, " photo", processingCount !== 1 ? 's' : '', "..."] }), _jsxs(Text, { variant: "bodySm", tone: "subdued", as: "span", children: [processedCount + errorCount, " / ", processedCount + errorCount + processingCount] })] }), _jsx(ProgressBar, { progress: Math.round(progressValue) })] }) })), _jsx(PhotoControls, { selectedImageUrl: null, onReprocess: (_, params) => {
                                    // This shouldn't be called in bulk mode, but just in case
                                    setParams(params);
                                }, onReprocessAll: (params) => setParams(params), onParamsChange: (params) => setParams(params), reprocessing: false, reprocessingAll: processing, imageCount: allPhotosCount, hideActionButtons: true }), _jsx(InlineStack, { gap: "200", align: "space-between", children: _jsxs(BlockStack, { gap: "200", children: [_jsx(Text, { variant: "bodyMd", fontWeight: "semibold", as: "span", children: "Apply Processing:" }), _jsxs(InlineStack, { gap: "200", children: [_jsxs(Button, { variant: "primary", icon: _jsx(RefreshCw, { size: 16 }), onClick: handleApplyToAll, loading: processing, disabled: allPhotosCount === 0, children: ["Apply to All Photos (", allPhotosCount.toString(), ")"] }), _jsxs(Button, { variant: "secondary", icon: _jsx(RefreshCw, { size: 16 }), onClick: handleApplyToSelected, loading: processing, disabled: !hasSelection, children: ["Apply to Selected (", selectedPhotoIds.length.toString(), ")"] })] })] }) }), _jsx(Divider, {}), photos.length > 0 && (_jsxs(BlockStack, { gap: "300", children: [_jsxs(Text, { variant: "bodyMd", fontWeight: "semibold", as: "span", children: ["Preview (", hasSelection ? selectedPhotos.length : photos.length, " photo", (hasSelection ? selectedPhotos.length : photos.length) !== 1 ? 's' : '', "):"] }), _jsx("div", { style: {
                                            display: 'grid',
                                            gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))',
                                            gap: '16px',
                                            maxHeight: '400px',
                                            overflowY: 'auto',
                                        }, children: (hasSelection ? selectedPhotos : photos).map((photo) => (_jsx("div", { children: _jsx(Card, { padding: "200", children: _jsxs(BlockStack, { gap: "200", children: [_jsxs(InlineStack, { gap: "200", wrap: false, children: [_jsxs("div", { style: { flex: 1 }, children: [_jsx(Text, { variant: "bodySm", tone: "subdued", as: "p", children: "Before" }), _jsx(Thumbnail, { size: "small", source: photo.originalUrl || PLACEHOLDER_IMG, alt: "Before processing" })] }), _jsxs("div", { style: { flex: 1 }, children: [_jsx(Text, { variant: "bodySm", tone: "subdued", as: "p", children: "After" }), photo.processing ? (_jsx("div", { style: {
                                                                                width: '80px',
                                                                                height: '80px',
                                                                                display: 'flex',
                                                                                alignItems: 'center',
                                                                                justifyContent: 'center',
                                                                                background: '#f3f4f6',
                                                                                borderRadius: '6px',
                                                                            }, children: _jsx(Spinner, { accessibilityLabel: "Processing", size: "small" }) })) : photo.processedUrl ? (_jsx(Thumbnail, { size: "small", source: photo.processedUrl, alt: "After processing" })) : (_jsx("div", { style: {
                                                                                width: '80px',
                                                                                height: '80px',
                                                                                display: 'flex',
                                                                                alignItems: 'center',
                                                                                justifyContent: 'center',
                                                                                background: '#f3f4f6',
                                                                                borderRadius: '6px',
                                                                                color: '#9ca3af',
                                                                                fontSize: '12px',
                                                                                textAlign: 'center',
                                                                            }, children: "Not processed" }))] })] }), _jsxs(InlineStack, { align: "space-between", blockAlign: "center", children: [photo.processing ? (_jsx(Badge, { tone: "warning", children: "Processing..." })) : photo.error ? (_jsx(Badge, { tone: "critical", children: "Error" })) : photo.processed ? (_jsx(Badge, { tone: "success", children: "Processed" })) : (_jsx(Badge, { children: "Original" })), _jsx(InlineStack, { gap: "100", children: photo.processed && photo.processedUrl && onRevertToOriginal && (_jsx(Button, { size: "slim", variant: "plain", icon: _jsx(RotateCcw, { size: 14 }), onClick: () => onRevertToOriginal(photo.id), children: "Revert" })) })] }), photo.error && (_jsx(Text, { variant: "bodySm", tone: "critical", as: "p", children: photo.error }))] }) }) }, photo.id))) })] })), !hasSelection && allPhotosCount > 0 && (_jsx(Banner, { tone: "info", children: _jsxs("p", { children: [_jsx("strong", { children: "Bulk editing mode:" }), " Controls will apply to ALL ", allPhotosCount, " photos. To edit specific photos, select them in the gallery above."] }) })), hasSelection && (_jsx(Banner, { tone: "info", children: _jsxs("p", { children: [_jsx("strong", { children: "Selected photos mode:" }), " Controls will apply to the ", selectedPhotoIds.length, " selected photos. Use \"Apply to All\" to process every photo instead."] }) }))] }) })] }) }));
};
export default EditPhotosPanel;
