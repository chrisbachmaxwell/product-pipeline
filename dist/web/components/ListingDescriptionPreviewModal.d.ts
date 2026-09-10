import React from 'react';
interface Props {
    catalogId: string;
    open: boolean;
    hasUnsavedChanges: boolean;
    /** The editor's current (possibly unsaved) sanitized description HTML. */
    draftDescriptionHtml?: string | null;
    onClose: () => void;
}
/**
 * Displays the server-rendered branded eBay description inside a strictly
 * sandboxed iframe (sandbox="" — no scripts, no same-origin). Display-only.
 */
declare const ListingDescriptionPreviewModal: React.FC<Props>;
export default ListingDescriptionPreviewModal;
