/**
 * BulkPhotoEditor — fullscreen modal for batch resize/rotate with live preview.
 *
 * Uses a portal to render outside the normal DOM tree, ensuring proper
 * z-index and centering regardless of parent layout.
 */
import React from 'react';
interface BulkPhotoEditorProps {
    selectedIndices: number[];
    allImageUrls: string[];
    draftId?: number;
    onSave: (updatedImages: string[]) => void;
    onCancel: () => void;
}
declare const BulkPhotoEditor: React.FC<BulkPhotoEditorProps>;
export default BulkPhotoEditor;
