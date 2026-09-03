import React from 'react';
interface ProductPhotoEditorProps {
    imageUrl: string;
    draftId?: number;
    imageIndex: number;
    allDraftImages: string[];
    onSave: (updatedImages: string[]) => void;
    onClose: () => void;
    open: boolean;
    onCustomSave?: (blob: Blob) => Promise<void>;
    productId?: string;
}
declare const ProductPhotoEditor: React.FC<ProductPhotoEditorProps>;
export default ProductPhotoEditor;
