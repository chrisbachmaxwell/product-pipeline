import React from 'react';
import { type ListingDraftField, type ListingDraftResponse, type ListingDraftSaveInput } from '../hooks/useListingDraft';
type EditableValues = ListingDraftSaveInput['draft'];
interface Props {
    draft: ListingDraftResponse;
    saving: boolean;
    onCancel: () => void;
    onSave: (input: ListingDraftSaveInput) => Promise<unknown>;
}
export declare const initialDraftValues: (draft: ListingDraftResponse) => EditableValues;
export declare const buildListingDraftSaveInput: (draft: ListingDraftResponse, values: EditableValues, images: string | null) => ListingDraftSaveInput;
export declare const isSemanticScalarChange: (field: ListingDraftField, initialDraft: string | null, nextDraft: string | null) => boolean;
export declare const isSemanticImageChange: (field: ListingDraftField, imagesDirty: boolean, nextSerialized: string | null) => boolean;
declare const ListingDraftEditor: React.FC<Props>;
export default ListingDraftEditor;
