import React from 'react';
export interface ActivePhoto {
    id: number;
    position: number;
    src: string;
    alt: string | null;
}
interface ActivePhotosGalleryProps {
    photos: ActivePhoto[];
    loading?: boolean;
    onDeleteSingle: (imageId: number) => void;
    onDeleteBulk: (imageIds: number[]) => void;
    onEditPhotos: (imageIds: number[]) => void;
    onSelectionChange?: (selectedIds: number[]) => void;
    onImageClick?: (photo: ActivePhoto, index: number) => void;
    onEditPhoto?: (photo: ActivePhoto, index: number) => void;
}
declare const ActivePhotosGallery: React.FC<ActivePhotosGalleryProps>;
export default ActivePhotosGallery;
