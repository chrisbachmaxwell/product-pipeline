import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useState, useCallback } from 'react';
import { Badge, BlockStack, Box, Button, Card, InlineStack, Spinner, Text, } from '@shopify/polaris';
import { X, ZoomIn, ChevronLeft, ChevronRight, Image as ImageIcon } from 'lucide-react';
const PLACEHOLDER_IMG = 'https://cdn.shopify.com/s/files/1/0533/2089/files/placeholder-images-image_large.png';
const statusConfig = {
    original: { tone: 'info', label: 'Original' },
    processing: { tone: 'warning', label: 'Processing…' },
    completed: { tone: 'success', label: 'Processed' },
    error: { tone: 'critical', label: 'Error' },
};
/* ── Lightbox ────────────────────────────────────────────────────────── */
const Lightbox = ({ images, currentIndex, onClose, onPrev, onNext, showProcessed }) => {
    const img = images[currentIndex];
    if (!img)
        return null;
    const src = showProcessed && img.processedUrl ? img.processedUrl : img.originalUrl;
    return (_jsxs("div", { style: {
            position: 'fixed',
            inset: 0,
            zIndex: 999999,
            backgroundColor: 'rgba(0,0,0,0.85)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
        }, onClick: onClose, children: [_jsx("button", { onClick: onClose, style: {
                    position: 'absolute',
                    top: 16,
                    right: 16,
                    background: 'rgba(255,255,255,0.1)',
                    border: 'none',
                    borderRadius: '50%',
                    padding: 8,
                    cursor: 'pointer',
                    color: '#fff',
                    zIndex: 10,
                }, children: _jsx(X, { size: 24 }) }), images.length > 1 && (_jsx("button", { onClick: (e) => {
                    e.stopPropagation();
                    onPrev();
                }, style: {
                    position: 'absolute',
                    left: 16,
                    top: '50%',
                    transform: 'translateY(-50%)',
                    background: 'rgba(255,255,255,0.1)',
                    border: 'none',
                    borderRadius: '50%',
                    padding: 12,
                    cursor: 'pointer',
                    color: '#fff',
                }, children: _jsx(ChevronLeft, { size: 28 }) })), _jsx("img", { src: src, alt: img.alt ?? 'Product image', style: {
                    maxWidth: '90vw',
                    maxHeight: '90vh',
                    objectFit: 'contain',
                    borderRadius: 8,
                }, onClick: (e) => e.stopPropagation() }), images.length > 1 && (_jsx("button", { onClick: (e) => {
                    e.stopPropagation();
                    onNext();
                }, style: {
                    position: 'absolute',
                    right: 16,
                    top: '50%',
                    transform: 'translateY(-50%)',
                    background: 'rgba(255,255,255,0.1)',
                    border: 'none',
                    borderRadius: '50%',
                    padding: 12,
                    cursor: 'pointer',
                    color: '#fff',
                }, children: _jsx(ChevronRight, { size: 28 }) })), _jsxs("div", { style: {
                    position: 'absolute',
                    bottom: 16,
                    left: '50%',
                    transform: 'translateX(-50%)',
                    color: '#fff',
                    fontSize: 14,
                    opacity: 0.7,
                }, children: [currentIndex + 1, " / ", images.length, showProcessed && img.processedUrl && ' (Processed)', (!showProcessed || !img.processedUrl) && ' (Original)'] })] }));
};
/* ── Image Thumbnail Card ────────────────────────────────────────────── */
const ImageCard = ({ image, viewMode, showProcessed, onToggle, onOpenLightbox, onSelect, isSelected, onEdit }) => {
    const status = statusConfig[image.processingStatus] ?? statusConfig.original;
    const [isHovered, setIsHovered] = useState(false);
    const imgStyle = {
        width: '100%',
        height: 160,
        objectFit: 'cover',
        borderRadius: 6,
        cursor: 'pointer',
        border: isSelected ? '2px solid #2563eb' : '2px solid transparent',
    };
    const ImageWithOverlay = ({ src, alt, onClick }) => (_jsxs("div", { style: { position: 'relative' }, onMouseEnter: () => setIsHovered(true), onMouseLeave: () => setIsHovered(false), children: [_jsx("img", { src: src || PLACEHOLDER_IMG, alt: alt, style: { ...imgStyle, height: 140 }, onClick: onClick }), isHovered && onEdit && (_jsx("div", { style: {
                    position: 'absolute',
                    inset: 0,
                    backgroundColor: 'rgba(0, 0, 0, 0.5)',
                    borderRadius: 6,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    cursor: 'pointer',
                }, onClick: (e) => {
                    e.stopPropagation();
                    onEdit(image.originalUrl);
                }, children: _jsx(Button, { size: "slim", variant: "primary", children: "Edit with PhotoRoom" }) }))] }));
    return (_jsx("div", { style: {
            width: viewMode === 'side-by-side' ? 320 : 180,
            flexShrink: 0,
        }, children: _jsx(Card, { padding: "200", children: _jsxs(BlockStack, { gap: "200", children: [_jsxs(InlineStack, { align: "space-between", blockAlign: "center", children: [_jsx(Badge, { tone: status.tone, children: status.label }), _jsx("button", { onClick: onOpenLightbox, style: {
                                    background: 'none',
                                    border: 'none',
                                    cursor: 'pointer',
                                    padding: 2,
                                    color: '#6b7280',
                                }, title: "View full size", children: _jsx(ZoomIn, { size: 16 }) })] }), viewMode === 'side-by-side' ? (_jsxs(InlineStack, { gap: "200", wrap: false, children: [_jsxs("div", { style: { flex: 1 }, children: [_jsx(Text, { variant: "bodySm", tone: "subdued", as: "p", children: "Original" }), _jsx(ImageWithOverlay, { src: image.originalUrl, alt: "Original", onClick: onSelect })] }), _jsxs("div", { style: { flex: 1 }, children: [_jsx(Text, { variant: "bodySm", tone: "subdued", as: "p", children: "Processed" }), image.processedUrl ? (_jsx(ImageWithOverlay, { src: image.processedUrl, alt: "Processed", onClick: onOpenLightbox })) : (_jsx("div", { style: {
                                            width: '100%',
                                            height: 140,
                                            borderRadius: 6,
                                            background: '#f3f4f6',
                                            display: 'flex',
                                            alignItems: 'center',
                                            justifyContent: 'center',
                                        }, children: _jsx(ImageIcon, { size: 24, color: "#9ca3af" }) }))] })] })) : (_jsxs("div", { children: [_jsx(ImageWithOverlay, { src: showProcessed && image.processedUrl
                                    ? image.processedUrl
                                    : image.originalUrl, alt: image.alt ?? 'Product image', onClick: onSelect }), image.processedUrl && (_jsx(Box, { paddingBlockStart: "100", children: _jsx(Button, { size: "micro", onClick: onToggle, variant: "plain", children: showProcessed ? 'Show original' : 'Show processed' }) }))] }))] }) }) }));
};
/* ── Main Gallery ────────────────────────────────────────────────────── */
const PhotoGallery = ({ images, loading, viewMode, onViewModeChange, onSelectImage, selectedImageUrl, onEditImage, }) => {
    const [lightboxIndex, setLightboxIndex] = useState(null);
    const [toggleStates, setToggleStates] = useState({});
    const handleToggle = useCallback((id) => {
        setToggleStates((prev) => ({ ...prev, [id]: !prev[id] }));
    }, []);
    const openLightbox = useCallback((index) => {
        setLightboxIndex(index);
    }, []);
    if (loading) {
        return (_jsx(Card, { children: _jsx(Box, { padding: "600", children: _jsx(InlineStack, { align: "center", children: _jsx(Spinner, { accessibilityLabel: "Loading images", size: "large" }) }) }) }));
    }
    if (images.length === 0) {
        return (_jsx(Card, { children: _jsx(Box, { padding: "400", children: _jsxs(BlockStack, { gap: "200", inlineAlign: "center", children: [_jsx(ImageIcon, { size: 48, color: "#9ca3af" }), _jsx(Text, { tone: "subdued", as: "p", alignment: "center", children: "No images found for this product." })] }) }) }));
    }
    const processedCount = images.filter((i) => i.processedUrl).length;
    return (_jsxs(_Fragment, { children: [_jsx(Card, { children: _jsxs(BlockStack, { gap: "400", children: [_jsxs(InlineStack, { align: "space-between", blockAlign: "center", children: [_jsxs(BlockStack, { gap: "050", children: [_jsx(Text, { variant: "headingMd", as: "h2", children: "Photo Gallery" }), _jsxs(Text, { variant: "bodySm", tone: "subdued", as: "p", children: [images.length, " image", images.length !== 1 ? 's' : '', " \u00B7 ", processedCount, " processed"] })] }), _jsxs(InlineStack, { gap: "200", children: [_jsx(Button, { size: "slim", variant: viewMode === 'side-by-side' ? 'primary' : 'secondary', onClick: () => onViewModeChange('side-by-side'), children: "Side by side" }), _jsx(Button, { size: "slim", variant: viewMode === 'toggle' ? 'primary' : 'secondary', onClick: () => onViewModeChange('toggle'), children: "Toggle" })] })] }), _jsx("div", { style: {
                                display: 'flex',
                                flexWrap: 'wrap',
                                gap: 12,
                            }, children: images.map((img, index) => (_jsx(ImageCard, { image: img, viewMode: viewMode, showProcessed: toggleStates[img.id] ?? true, onToggle: () => handleToggle(img.id), onOpenLightbox: () => openLightbox(index), onSelect: () => onSelectImage?.(img), isSelected: selectedImageUrl === img.originalUrl, onEdit: onEditImage }, img.id))) })] }) }), lightboxIndex !== null && (_jsx(Lightbox, { images: images, currentIndex: lightboxIndex, showProcessed: toggleStates[images[lightboxIndex]?.id] ?? true, onClose: () => setLightboxIndex(null), onPrev: () => setLightboxIndex((prev) => prev !== null ? (prev - 1 + images.length) % images.length : 0), onNext: () => setLightboxIndex((prev) => prev !== null ? (prev + 1) % images.length : 0) }))] }));
};
export default PhotoGallery;
