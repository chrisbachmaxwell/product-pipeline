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
import React from 'react';
export interface DraggablePhotoGridProps {
    /** Ordered list of image URLs */
    imageUrls: string[];
    /** Called with the new URL order after any reorder or removal */
    onChange: (urls: string[]) => void;
    /** Called when user clicks edit on a photo — receives the photo index */
    onEditPhoto?: (index: number) => void;
    /** Enable bulk selection + edit toolbar */
    enableBulkEdit?: boolean;
    /** Draft ID — needed for bulk save */
    draftId?: number;
}
declare const DraggablePhotoGrid: React.FC<DraggablePhotoGridProps>;
export default DraggablePhotoGrid;
