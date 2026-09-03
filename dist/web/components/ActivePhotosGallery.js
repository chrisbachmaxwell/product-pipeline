import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useState, useCallback } from 'react';
import { BlockStack, Box, Button, Card, Checkbox, InlineStack, Modal, Text, Thumbnail, ButtonGroup, } from '@shopify/polaris';
import { X, ZoomIn, Pencil } from 'lucide-react';
const PLACEHOLDER_IMG = 'https://cdn.shopify.com/s/files/1/0533/2089/files/placeholder-images-image_large.png';
const ActivePhotosGallery = ({ photos, loading = false, onDeleteSingle, onDeleteBulk, onEditPhotos, onSelectionChange, onImageClick, onEditPhoto, }) => {
    const [selectedIds, setSelectedIds] = useState(new Set());
    // Sync selection changes to parent
    const updateSelection = useCallback((newIds) => {
        setSelectedIds(newIds);
        onSelectionChange?.(Array.from(newIds));
    }, [onSelectionChange]);
    const [deleteModalActive, setDeleteModalActive] = useState(false);
    const [deletingIds, setDeletingIds] = useState([]);
    const [lightboxPhoto, setLightboxPhoto] = useState(null);
    const handleSelectAll = useCallback(() => {
        if (selectedIds.size === photos.length) {
            updateSelection(new Set());
        }
        else {
            updateSelection(new Set(photos.map(p => p.id)));
        }
    }, [photos, selectedIds.size, updateSelection]);
    const handleSelectPhoto = useCallback((photoId) => {
        const newSet = new Set(selectedIds);
        if (newSet.has(photoId)) {
            newSet.delete(photoId);
        }
        else {
            newSet.add(photoId);
        }
        updateSelection(newSet);
    }, [selectedIds, updateSelection]);
    const handleDeleteSingle = useCallback((imageId) => {
        setDeletingIds([imageId]);
        setDeleteModalActive(true);
    }, []);
    const handleDeleteSelected = useCallback(() => {
        setDeletingIds(Array.from(selectedIds));
        setDeleteModalActive(true);
    }, [selectedIds]);
    const confirmDelete = useCallback(() => {
        if (deletingIds.length === 1) {
            onDeleteSingle(deletingIds[0]);
        }
        else {
            onDeleteBulk(deletingIds);
        }
        setDeleteModalActive(false);
        updateSelection(new Set());
        setDeletingIds([]);
    }, [deletingIds, onDeleteSingle, onDeleteBulk]);
    const handleEditPhotos = useCallback(() => {
        if (selectedIds.size === 0) {
            // If nothing selected, edit all photos
            onEditPhotos(photos.map(p => p.id));
        }
        else {
            onEditPhotos(Array.from(selectedIds));
        }
    }, [selectedIds, photos, onEditPhotos]);
    const openLightbox = useCallback((photo, index) => {
        setLightboxPhoto({ photo, index });
        onImageClick?.(photo, index);
    }, [onImageClick]);
    const closeLightbox = useCallback(() => {
        setLightboxPhoto(null);
    }, []);
    const navigateLightbox = useCallback((direction) => {
        if (!lightboxPhoto)
            return;
        const currentIndex = lightboxPhoto.index;
        let newIndex;
        if (direction === 'prev') {
            newIndex = currentIndex === 0 ? photos.length - 1 : currentIndex - 1;
        }
        else {
            newIndex = currentIndex === photos.length - 1 ? 0 : currentIndex + 1;
        }
        setLightboxPhoto({ photo: photos[newIndex], index: newIndex });
    }, [lightboxPhoto, photos]);
    if (loading) {
        return (_jsx(Card, { children: _jsx(Box, { padding: "400", children: _jsx(InlineStack, { align: "center", children: _jsx(Text, { tone: "subdued", as: "p", children: "Loading photos..." }) }) }) }));
    }
    const allSelected = selectedIds.size === photos.length && photos.length > 0;
    const someSelected = selectedIds.size > 0;
    const selectAllChecked = allSelected ? true : someSelected ? 'indeterminate' : false;
    return (_jsxs(_Fragment, { children: [_jsx(Card, { children: _jsxs(BlockStack, { gap: "400", children: [_jsx(InlineStack, { align: "space-between", blockAlign: "center", children: _jsxs(BlockStack, { gap: "050", children: [_jsxs(InlineStack, { gap: "200", blockAlign: "center", children: [_jsxs(Text, { variant: "headingMd", as: "h2", children: ["Photos on Shopify (", photos.length, ")"] }), photos.length > 0 && (_jsx(Checkbox, { label: "Select All", checked: selectAllChecked, onChange: handleSelectAll }))] }), _jsx(Text, { variant: "bodySm", tone: "subdued", as: "p", children: "These are the images currently live on your Shopify product" })] }) }), someSelected && (_jsx(Box, { padding: "200", background: "bg-surface-secondary", borderRadius: "200", children: _jsxs(InlineStack, { align: "space-between", blockAlign: "center", children: [_jsxs(Text, { variant: "bodySm", as: "span", children: [selectedIds.size, " photo", selectedIds.size !== 1 ? 's' : '', " selected"] }), _jsxs(ButtonGroup, { children: [_jsx(Button, { size: "slim", tone: "critical", onClick: handleDeleteSelected, children: "Delete Selected" }), _jsx(Button, { size: "slim", variant: "primary", onClick: handleEditPhotos, children: "Edit with PhotoRoom" })] })] }) })), photos.length === 0 ? (_jsx(Box, { padding: "800", children: _jsxs(BlockStack, { gap: "200", inlineAlign: "center", children: [_jsx(Text, { tone: "subdued", as: "p", alignment: "center", children: "No photos found on this Shopify product." }), _jsx(Text, { tone: "subdued", as: "p", alignment: "center", variant: "bodySm", children: "Add photos in Shopify admin, then refresh this page." })] }) })) : (_jsx("div", { style: {
                                display: 'grid',
                                gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))',
                                gap: '12px',
                            }, children: photos.map((photo, index) => (_jsxs("div", { style: { position: 'relative' }, children: [_jsxs("div", { style: {
                                            border: selectedIds.has(photo.id) ? '2px solid #2563eb' : '2px solid transparent',
                                            borderRadius: '8px',
                                            overflow: 'hidden',
                                            position: 'relative',
                                        }, children: [_jsx("div", { onClick: () => openLightbox(photo, index), style: { cursor: 'pointer' }, children: _jsx(Thumbnail, { size: "large", source: photo.src || PLACEHOLDER_IMG, alt: photo.alt || `Product image ${photo.position}` }) }), _jsx("button", { onClick: (e) => {
                                                    e.stopPropagation();
                                                    handleDeleteSingle(photo.id);
                                                }, style: {
                                                    position: 'absolute',
                                                    top: '6px',
                                                    right: '6px',
                                                    background: 'rgba(0, 0, 0, 0.7)',
                                                    border: 'none',
                                                    borderRadius: '50%',
                                                    padding: '4px',
                                                    cursor: 'pointer',
                                                    color: 'white',
                                                    display: 'flex',
                                                    alignItems: 'center',
                                                    justifyContent: 'center',
                                                }, title: "Delete this photo", children: _jsx(X, { size: 16 }) }), _jsx("div", { style: {
                                                    position: 'absolute',
                                                    top: '6px',
                                                    left: '6px',
                                                }, children: _jsx(Checkbox, { label: "", checked: selectedIds.has(photo.id), onChange: () => handleSelectPhoto(photo.id) }) }), onEditPhoto && (_jsx("button", { onClick: (e) => {
                                                    e.stopPropagation();
                                                    onEditPhoto(photo, index);
                                                }, style: {
                                                    position: 'absolute',
                                                    bottom: '6px',
                                                    left: '6px',
                                                    background: 'rgba(0, 0, 0, 0.7)',
                                                    border: 'none',
                                                    borderRadius: '50%',
                                                    padding: '4px',
                                                    cursor: 'pointer',
                                                    color: 'white',
                                                    display: 'flex',
                                                    alignItems: 'center',
                                                    justifyContent: 'center',
                                                }, title: "Edit photo (rotate/scale/reposition)", children: _jsx(Pencil, { size: 16 }) })), _jsx("button", { onClick: (e) => {
                                                    e.stopPropagation();
                                                    openLightbox(photo, index);
                                                }, style: {
                                                    position: 'absolute',
                                                    bottom: '6px',
                                                    right: '6px',
                                                    background: 'rgba(0, 0, 0, 0.7)',
                                                    border: 'none',
                                                    borderRadius: '50%',
                                                    padding: '4px',
                                                    cursor: 'pointer',
                                                    color: 'white',
                                                    display: 'flex',
                                                    alignItems: 'center',
                                                    justifyContent: 'center',
                                                }, title: "View full size", children: _jsx(ZoomIn, { size: 16 }) })] }), _jsx(Box, { paddingBlockStart: "100", children: _jsxs(Text, { variant: "bodySm", tone: "subdued", as: "p", alignment: "center", children: ["Position ", photo.position] }) })] }, photo.id))) }))] }) }), _jsx(Modal, { open: deleteModalActive, onClose: () => setDeleteModalActive(false), title: `Delete ${deletingIds.length} photo${deletingIds.length !== 1 ? 's' : ''}?`, primaryAction: {
                    content: 'Delete',
                    destructive: true,
                    onAction: confirmDelete,
                }, secondaryActions: [
                    {
                        content: 'Cancel',
                        onAction: () => setDeleteModalActive(false),
                    },
                ], children: _jsx(Modal.Section, { children: _jsxs(Text, { as: "p", children: ["Delete ", deletingIds.length, " photo", deletingIds.length !== 1 ? 's' : '', " from Shopify? This action cannot be undone."] }) }) }), lightboxPhoto && (_jsxs("div", { style: {
                    position: 'fixed',
                    inset: 0,
                    zIndex: 999999,
                    backgroundColor: 'rgba(0,0,0,0.9)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                }, onClick: closeLightbox, children: [_jsx("button", { onClick: closeLightbox, style: {
                            position: 'absolute',
                            top: '16px',
                            right: '16px',
                            background: 'rgba(255,255,255,0.1)',
                            border: 'none',
                            borderRadius: '50%',
                            padding: '8px',
                            cursor: 'pointer',
                            color: '#fff',
                        }, children: _jsx(X, { size: 24 }) }), photos.length > 1 && (_jsx("button", { onClick: (e) => {
                            e.stopPropagation();
                            navigateLightbox('prev');
                        }, style: {
                            position: 'absolute',
                            left: '16px',
                            top: '50%',
                            transform: 'translateY(-50%)',
                            background: 'rgba(255,255,255,0.1)',
                            border: 'none',
                            borderRadius: '50%',
                            padding: '12px',
                            cursor: 'pointer',
                            color: '#fff',
                        }, children: "\u2190" })), _jsx("img", { src: lightboxPhoto.photo.src, alt: lightboxPhoto.photo.alt || 'Product image', style: {
                            maxWidth: '90vw',
                            maxHeight: '90vh',
                            objectFit: 'contain',
                            borderRadius: '8px',
                        }, onClick: (e) => e.stopPropagation() }), photos.length > 1 && (_jsx("button", { onClick: (e) => {
                            e.stopPropagation();
                            navigateLightbox('next');
                        }, style: {
                            position: 'absolute',
                            right: '16px',
                            top: '50%',
                            transform: 'translateY(-50%)',
                            background: 'rgba(255,255,255,0.1)',
                            border: 'none',
                            borderRadius: '50%',
                            padding: '12px',
                            cursor: 'pointer',
                            color: '#fff',
                        }, children: "\u2192" })), _jsxs("div", { style: {
                            position: 'absolute',
                            bottom: '16px',
                            left: '50%',
                            transform: 'translateX(-50%)',
                            color: '#fff',
                            fontSize: '14px',
                            opacity: 0.8,
                        }, children: [lightboxPhoto.index + 1, " / ", photos.length] })] }))] }));
};
export default ActivePhotosGallery;
