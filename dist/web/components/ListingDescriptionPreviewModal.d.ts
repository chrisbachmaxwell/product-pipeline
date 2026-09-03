import React from 'react';
interface Props {
    catalogId: string;
    open: boolean;
    hasUnsavedChanges: boolean;
    onClose: () => void;
}
/**
 * Displays the server-rendered branded eBay description inside a strictly
 * sandboxed iframe (sandbox="" — no scripts, no same-origin). Display-only.
 */
declare const ListingDescriptionPreviewModal: React.FC<Props>;
export default ListingDescriptionPreviewModal;
