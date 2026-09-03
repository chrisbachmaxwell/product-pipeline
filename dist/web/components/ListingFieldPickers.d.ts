import React from 'react';
import type { ListingEditorCategory, ListingEditorCondition, ListingEditorIdUsage } from '../hooks/useListingEditorMetadata';
interface ConditionSelectProps {
    label: React.ReactNode;
    /** Draft override value (eBay condition id) or null for "keep current". */
    value: string | null;
    conditions: ListingEditorCondition[];
    /** Caption describing the current eBay/Shopify value. */
    currentSummary: string;
    disabled?: boolean;
    error?: string;
    onChange: (value: string | null) => void;
}
export declare const conditionDisplayLabel: (id: string, conditions: ListingEditorCondition[]) => string;
export declare const ConditionSelect: React.FC<ConditionSelectProps>;
interface CategoryPickerProps {
    label: React.ReactNode;
    /** Draft override value (eBay category id) or null for "keep current". */
    value: string | null;
    categories: ListingEditorCategory[];
    /** Caption describing the current eBay/Shopify value. */
    currentSummary: string;
    disabled?: boolean;
    error?: string;
    onChange: (value: string | null) => void;
}
export declare const categoryDisplayLabel: (id: string, categories: ListingEditorCategory[]) => string;
export declare const CategoryPicker: React.FC<CategoryPickerProps>;
interface IdUsageSelectProps {
    label: React.ReactNode;
    /** Draft override value or null for "keep current". */
    value: string | null;
    options: ListingEditorIdUsage[];
    /** Current inherited (eBay, else Shopify) value, if any. */
    currentValue: string | null;
    /** Noun used in the free-entry toggle, e.g. "policy ID". */
    idNoun: string;
    disabled?: boolean;
    error?: string;
    onChange: (value: string | null) => void;
}
export declare const IdUsageSelect: React.FC<IdUsageSelectProps>;
export {};
