import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
/**
 * DraggablePhotoGrid
 *
 * A drag-and-drop sortable photo grid for eBay listing prep.
 * Built with @dnd-kit/core + @dnd-kit/sortable.
 *
 * • First photo is the hero / main eBay listing image (shown with MAIN badge).
 * • Photos can be reordered by dragging — touch and mouse both work.
 * • Each card has a × remove button that does NOT interfere with dragging.
 * • Exports `DraggablePhotoGrid` as default so other pages can reuse it.
 */
import { useState, useCallback } from 'react';
import BulkPhotoEditor from './BulkPhotoEditor';
import { DndContext, closestCenter, DragOverlay, PointerSensor, KeyboardSensor, useSensor, useSensors, } from '@dnd-kit/core';
import { arrayMove, SortableContext, sortableKeyboardCoordinates, rectSortingStrategy, useSortable, } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
// ── Stable per-photo item ID ───────────────────────────────────────────
// We append the original index so duplicate URLs get unique keys.
function makeId(url, index) {
    return `${index}::${url}`;
}
function urlFromId(id) {
    return id.slice(id.indexOf('::') + 2);
}
const SortablePhoto = ({ id, url, index, isOverlay = false, onRemove, onEdit, selected = false, onToggleSelect, }) => {
    const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging, } = useSortable({ id });
    const cardStyle = {
        borderRadius: '8px',
        overflow: 'hidden',
        border: `2px solid ${selected ? '#0064d3' : isDragging ? '#0064d3' : '#e3e5e7'}`,
        position: 'relative',
        background: selected ? '#e8f0fe' : '#f9fafb',
        opacity: isDragging && !isOverlay ? 0.4 : 1,
        transform: CSS.Transform.toString(transform),
        transition,
        boxShadow: isOverlay ? '0 8px 24px rgba(0,0,0,0.18)' : selected ? '0 0 0 2px #0064d3' : undefined,
        touchAction: 'none',
    };
    return (_jsxs("div", { ref: setNodeRef, style: cardStyle, ...attributes, children: [_jsx("div", { ref: setActivatorNodeRef, ...listeners, style: { cursor: isOverlay ? 'grabbing' : 'grab', display: 'block', userSelect: 'none' }, title: "Drag to reorder", children: _jsx("img", { src: url, alt: `Photo ${index + 1}`, draggable: false, style: {
                        width: '100%',
                        aspectRatio: '1',
                        objectFit: 'cover',
                        display: 'block',
                        pointerEvents: 'none', // prevent browser native image drag
                    }, onError: (e) => {
                        e.target.style.opacity = '0.3';
                    } }) }), index === 0 && (_jsx("div", { style: {
                    position: 'absolute',
                    top: '6px',
                    left: '6px',
                    background: '#0064d3',
                    color: '#fff',
                    fontSize: '10px',
                    fontWeight: 700,
                    padding: '2px 6px',
                    borderRadius: '4px',
                    pointerEvents: 'none',
                }, children: "MAIN" })), !isOverlay && onToggleSelect && (_jsx("button", { onClick: (e) => {
                    e.stopPropagation();
                    onToggleSelect();
                }, title: selected ? 'Deselect' : 'Select for bulk edit', style: {
                    position: 'absolute',
                    top: '6px',
                    right: '6px',
                    width: '22px',
                    height: '22px',
                    borderRadius: '4px',
                    border: `2px solid ${selected ? '#0064d3' : 'rgba(255,255,255,0.9)'}`,
                    background: selected ? '#0064d3' : 'rgba(0,0,0,0.3)',
                    color: '#fff',
                    fontSize: '14px',
                    lineHeight: 1,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    cursor: 'pointer',
                    padding: 0,
                    zIndex: 2,
                }, children: selected ? '✓' : '' })), !onToggleSelect && (_jsx("div", { style: {
                    position: 'absolute',
                    top: '6px',
                    right: '6px',
                    color: 'rgba(255,255,255,0.85)',
                    fontSize: '14px',
                    lineHeight: 1,
                    textShadow: '0 1px 3px rgba(0,0,0,0.7)',
                    pointerEvents: 'none',
                }, children: "\u283F" })), _jsxs("div", { style: {
                    position: 'absolute',
                    bottom: '28px',
                    left: '6px',
                    color: 'rgba(255,255,255,0.9)',
                    fontSize: '11px',
                    fontWeight: 600,
                    textShadow: '0 1px 2px rgba(0,0,0,0.8)',
                    pointerEvents: 'none',
                }, children: ["#", index + 1] }), !isOverlay && onEdit && (_jsx("button", { onClick: (e) => {
                    e.stopPropagation();
                    onEdit();
                }, title: "Edit photo", style: {
                    position: 'absolute',
                    bottom: '4px',
                    left: '4px',
                    background: 'rgba(0,100,211,0.85)',
                    border: 'none',
                    borderRadius: '4px',
                    color: '#fff',
                    width: '24px',
                    height: '24px',
                    cursor: 'pointer',
                    fontSize: '12px',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    lineHeight: 1,
                }, children: "\u270E" })), !isOverlay && (_jsx("button", { onClick: (e) => {
                    e.stopPropagation();
                    onRemove();
                }, title: "Remove photo", style: {
                    position: 'absolute',
                    bottom: '4px',
                    right: '4px',
                    background: 'rgba(200,0,0,0.80)',
                    border: 'none',
                    borderRadius: '4px',
                    color: '#fff',
                    width: '24px',
                    height: '24px',
                    cursor: 'pointer',
                    fontSize: '12px',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    lineHeight: 1,
                }, children: "\u2715" }))] }));
};
// ── Main export ────────────────────────────────────────────────────────
const DraggablePhotoGrid = ({ imageUrls, onChange, onEditPhoto, enableBulkEdit = false, draftId, }) => {
    const [activeId, setActiveId] = useState(null);
    const [selectedIndices, setSelectedIndices] = useState(new Set());
    const [bulkEditOpen, setBulkEditOpen] = useState(false);
    const toggleSelect = useCallback((index) => {
        setSelectedIndices((prev) => {
            const next = new Set(prev);
            if (next.has(index))
                next.delete(index);
            else
                next.add(index);
            return next;
        });
    }, []);
    const handleBulkSave = useCallback((updatedImages) => {
        onChange(updatedImages);
        setSelectedIndices(new Set());
        setBulkEditOpen(false);
    }, [onChange]);
    const handleBulkCancel = useCallback(() => {
        setBulkEditOpen(false);
    }, []);
    // Stable IDs — append original index so dupes get unique keys
    const items = imageUrls.map((url, i) => makeId(url, i));
    const sensors = useSensors(useSensor(PointerSensor, {
        // Small activation distance so clicks on the remove button still register
        activationConstraint: { distance: 6 },
    }), useSensor(KeyboardSensor, {
        coordinateGetter: sortableKeyboardCoordinates,
    }));
    const handleDragStart = useCallback((event) => {
        setActiveId(event.active.id);
    }, []);
    const handleDragEnd = useCallback((event) => {
        setActiveId(null);
        const { active, over } = event;
        if (!over || active.id === over.id)
            return;
        const oldIndex = items.indexOf(active.id);
        const newIndex = items.indexOf(over.id);
        if (oldIndex === -1 || newIndex === -1)
            return;
        onChange(arrayMove(imageUrls, oldIndex, newIndex));
    }, [items, imageUrls, onChange]);
    const handleDragCancel = useCallback(() => {
        setActiveId(null);
    }, []);
    const handleRemove = useCallback((index) => {
        onChange(imageUrls.filter((_, i) => i !== index));
    }, [imageUrls, onChange]);
    if (imageUrls.length === 0) {
        return (_jsx("div", { style: {
                border: '2px dashed #d1d5db',
                borderRadius: '8px',
                padding: '24px',
                textAlign: 'center',
                color: '#9ca3af',
                fontSize: '14px',
            }, children: "No photos available. eBay requires at least one image." }));
    }
    const activeIndex = activeId ? items.indexOf(activeId) : -1;
    const activeUrl = activeIndex >= 0 ? imageUrls[activeIndex] : null;
    const hasSelection = selectedIndices.size > 0;
    return (_jsxs("div", { children: [enableBulkEdit && imageUrls.length > 1 && (_jsxs("div", { style: { display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }, children: [_jsx("button", { onClick: () => {
                            if (selectedIndices.size === imageUrls.length) {
                                setSelectedIndices(new Set());
                            }
                            else {
                                setSelectedIndices(new Set(imageUrls.map((_, i) => i)));
                            }
                        }, style: {
                            background: 'none',
                            border: '1px solid #ccc',
                            borderRadius: '4px',
                            padding: '4px 10px',
                            fontSize: '12px',
                            cursor: 'pointer',
                            color: '#333',
                        }, children: selectedIndices.size === imageUrls.length ? 'Deselect All' : 'Select All' }), hasSelection && (_jsxs(_Fragment, { children: [_jsxs("span", { style: { fontSize: '12px', color: '#666' }, children: [selectedIndices.size, " selected"] }), _jsx("button", { onClick: () => setBulkEditOpen(true), style: {
                                    background: '#0064d3',
                                    color: '#fff',
                                    border: 'none',
                                    borderRadius: '6px',
                                    padding: '4px 14px',
                                    fontSize: '12px',
                                    fontWeight: 600,
                                    cursor: 'pointer',
                                }, children: "Edit Selected" }), _jsx("button", { onClick: () => setSelectedIndices(new Set()), style: {
                                    background: 'none',
                                    border: '1px solid #ccc',
                                    borderRadius: '4px',
                                    padding: '4px 10px',
                                    fontSize: '12px',
                                    cursor: 'pointer',
                                    color: '#666',
                                }, children: "Clear" })] }))] })), bulkEditOpen && hasSelection && (_jsx(BulkPhotoEditor, { selectedIndices: Array.from(selectedIndices).sort((a, b) => a - b), allImageUrls: imageUrls, draftId: draftId, onSave: handleBulkSave, onCancel: handleBulkCancel })), _jsxs(DndContext, { sensors: sensors, collisionDetection: closestCenter, onDragStart: handleDragStart, onDragEnd: handleDragEnd, onDragCancel: handleDragCancel, children: [_jsx(SortableContext, { items: items, strategy: rectSortingStrategy, children: _jsx("div", { style: {
                                display: 'grid',
                                gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))',
                                gap: '12px',
                            }, children: items.map((id, index) => (_jsx(SortablePhoto, { id: id, url: imageUrls[index], index: index, total: imageUrls.length, onRemove: () => handleRemove(index), onEdit: onEditPhoto ? () => onEditPhoto(index) : undefined, selected: selectedIndices.has(index), onToggleSelect: enableBulkEdit ? () => toggleSelect(index) : undefined }, id))) }) }), _jsx(DragOverlay, { adjustScale: false, children: activeUrl !== null ? (_jsx(SortablePhoto, { id: activeId, url: activeUrl, index: activeIndex, total: imageUrls.length, isOverlay: true, onRemove: () => { } })) : null })] })] }));
};
export default DraggablePhotoGrid;
