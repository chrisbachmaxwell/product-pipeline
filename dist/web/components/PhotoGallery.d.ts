import React from 'react';
export interface GalleryImage {
    id: number;
    position: number;
    originalUrl: string;
    alt: string | null;
    processedUrl: string | null;
    processingStatus: 'original' | 'processing' | 'completed' | 'error';
    params: {
        background?: string;
        padding?: number;
        shadow?: boolean;
    } | null;
    processedAt: number | null;
}
interface PhotoGalleryProps {
    images: GalleryImage[];
    loading?: boolean;
    viewMode: 'side-by-side' | 'toggle';
    onViewModeChange: (mode: 'side-by-side' | 'toggle') => void;
    onSelectImage?: (image: GalleryImage) => void;
    selectedImageUrl?: string | null;
    onEditImage?: (imageUrl: string) => void;
}
declare const PhotoGallery: React.FC<PhotoGalleryProps>;
export default PhotoGallery;
