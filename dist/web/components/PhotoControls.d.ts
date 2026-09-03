import React from 'react';
export interface PhotoRoomParams {
    background: string;
    padding: number;
    shadow: boolean;
}
interface PhotoControlsProps {
    /** Currently selected image URL for single reprocess */
    selectedImageUrl: string | null;
    /** Callback when user clicks "Reprocess" (single image) */
    onReprocess: (imageUrl: string, params: PhotoRoomParams) => void;
    /** Callback when user clicks "Reprocess All" */
    onReprocessAll: (params: PhotoRoomParams) => void;
    /** Callback when parameters change (real-time updates) */
    onParamsChange?: (params: PhotoRoomParams) => void;
    /** Whether a single reprocess is in progress */
    reprocessing?: boolean;
    /** Whether a bulk reprocess is in progress */
    reprocessingAll?: boolean;
    /** Preview URL to show after processing */
    previewUrl?: string | null;
    /** Total image count for the "Reprocess All" button */
    imageCount?: number;
    /** Hide the action buttons (for use in EditPhotosPanel) */
    hideActionButtons?: boolean;
}
declare const PhotoControls: React.FC<PhotoControlsProps>;
export default PhotoControls;
