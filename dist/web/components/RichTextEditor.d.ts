import React from 'react';
/**
 * Hand-rolled, dependency-free rich text editor for the draft description.
 *
 * The contentEditable surface only ever receives HTML that has passed
 * `sanitizeListingHtml`, and every value read back out of it (or out of the
 * raw HTML source view) is sanitized again before it reaches the parent.
 * The parent therefore only ever sees allowlisted, attribute-free markup.
 */
interface Props {
    label: React.ReactNode;
    /** Sanitized HTML currently backing the editor. */
    value: string;
    disabled?: boolean;
    error?: string;
    helpText?: React.ReactNode;
    maxLength: number;
    onChange: (html: string) => void;
}
declare const RichTextEditor: React.FC<Props>;
export default RichTextEditor;
