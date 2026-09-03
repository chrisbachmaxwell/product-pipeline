import React from 'react';
import { type PhotoRoomParams } from './PhotoControls';
export interface EditablePhoto {
    id: number;
    originalUrl: string;
    alt: string | null;
    processing?: boolean;
    processed?: boolean;
    processedUrl?: string | null;
    error?: string | null;
}
interface EditPhotosPanelProps {
    photos: EditablePhoto[];
    selectedPhotoIds: number[];
    isOpen: boolean;
    onToggle: () => void;
    onProcessSingle: (photoId: number, params: PhotoRoomParams) => Promise<void>;
    onProcessSelected: (photoIds: number[], params: PhotoRoomParams) => Promise<void>;
    onProcessAll: (params: PhotoRoomParams) => Promise<void>;
    onRevertToOriginal?: (photoId: number) => Promise<void>;
    processing?: boolean;
}
declare const EditPhotosPanel: React.FC<EditPhotosPanelProps>;
export default EditPhotosPanel;
