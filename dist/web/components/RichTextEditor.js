import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useCallback, useEffect, useRef, useState } from 'react';
import { BlockStack, Button, ButtonGroup, InlineStack, Text, TextField, } from '@shopify/polaris';
import { safeListingLinkHref, sanitizeListingHtml } from '../listing-html';
const surfaceStyle = (disabled, invalid) => ({
    minHeight: '10rem',
    maxHeight: '24rem',
    overflowY: 'auto',
    padding: '0.75rem',
    border: invalid
        ? '2px solid var(--p-color-border-critical, #e51c00)'
        : '1px solid var(--p-color-border, #d5d5d5)',
    borderRadius: 'var(--p-border-radius-200, 8px)',
    background: disabled
        ? 'var(--p-color-bg-surface-disabled, #f2f2f2)'
        : 'var(--p-color-bg-surface, #ffffff)',
    outline: 'none',
});
const RichTextEditor = ({ label, value, disabled = false, error, helpText, maxLength, onChange, }) => {
    const surfaceRef = useRef(null);
    const lastEmittedRef = useRef(null);
    const [htmlMode, setHtmlMode] = useState(false);
    const [source, setSource] = useState('');
    useEffect(() => {
        if (htmlMode)
            return;
        const surface = surfaceRef.current;
        if (!surface || value === lastEmittedRef.current)
            return;
        // Sanitized upstream and sanitized again here before entering the DOM.
        surface.innerHTML = sanitizeListingHtml(value);
        lastEmittedRef.current = value;
    }, [value, htmlMode]);
    const emitFromSurface = useCallback(() => {
        const surface = surfaceRef.current;
        if (!surface)
            return;
        const html = sanitizeListingHtml(surface.innerHTML);
        lastEmittedRef.current = html;
        onChange(html);
    }, [onChange]);
    const exec = (command, argument) => {
        const surface = surfaceRef.current;
        if (!surface || disabled)
            return;
        surface.focus();
        try {
            document.execCommand('styleWithCSS', false, 'false');
        }
        catch {
            // Older engines only; formatting still works without it.
        }
        document.execCommand(command, false, argument);
        emitFromSurface();
    };
    const insertLink = () => {
        const raw = window.prompt('Link URL (must start with http:// or https://)');
        if (raw === null || raw.trim() === '')
            return;
        const href = safeListingLinkHref(raw.trim());
        if (href === null) {
            window.alert('Enter a full http:// or https:// URL.');
            return;
        }
        exec('createLink', href);
    };
    const clearFormatting = () => {
        const surface = surfaceRef.current;
        if (!surface || disabled)
            return;
        surface.focus();
        document.execCommand('removeFormat');
        document.execCommand('unlink');
        document.execCommand('formatBlock', false, 'p');
        emitFromSurface();
    };
    const enterHtmlMode = () => {
        const surface = surfaceRef.current;
        setSource(sanitizeListingHtml(surface ? surface.innerHTML : value));
        setHtmlMode(true);
    };
    const leaveHtmlMode = () => {
        const html = sanitizeListingHtml(source);
        lastEmittedRef.current = null; // force the surface to re-render from value
        onChange(html);
        setHtmlMode(false);
    };
    const changeSource = (next) => {
        setSource(next);
        const html = sanitizeListingHtml(next);
        lastEmittedRef.current = html;
        onChange(html);
    };
    const characterCount = value.length;
    const overLimit = characterCount > maxLength;
    return (_jsxs(BlockStack, { gap: "150", children: [label, _jsxs(InlineStack, { gap: "200", blockAlign: "center", wrap: true, children: [_jsxs(ButtonGroup, { variant: "segmented", children: [_jsx(Button, { size: "slim", disabled: disabled || htmlMode, accessibilityLabel: "Bold", onClick: () => exec('bold'), children: "B" }), _jsx(Button, { size: "slim", disabled: disabled || htmlMode, accessibilityLabel: "Italic", onClick: () => exec('italic'), children: "I" }), _jsx(Button, { size: "slim", disabled: disabled || htmlMode, accessibilityLabel: "Underline", onClick: () => exec('underline'), children: "U" })] }), _jsxs(ButtonGroup, { variant: "segmented", children: [_jsx(Button, { size: "slim", disabled: disabled || htmlMode, accessibilityLabel: "Bulleted list", onClick: () => exec('insertUnorderedList'), children: "\u2022 List" }), _jsx(Button, { size: "slim", disabled: disabled || htmlMode, accessibilityLabel: "Numbered list", onClick: () => exec('insertOrderedList'), children: "1. List" })] }), _jsxs(ButtonGroup, { variant: "segmented", children: [_jsx(Button, { size: "slim", disabled: disabled || htmlMode, accessibilityLabel: "Heading 2", onClick: () => exec('formatBlock', 'h2'), children: "H2" }), _jsx(Button, { size: "slim", disabled: disabled || htmlMode, accessibilityLabel: "Heading 3", onClick: () => exec('formatBlock', 'h3'), children: "H3" }), _jsx(Button, { size: "slim", disabled: disabled || htmlMode, accessibilityLabel: "Paragraph", onClick: () => exec('formatBlock', 'p'), children: "\u00B6" })] }), _jsxs(ButtonGroup, { variant: "segmented", children: [_jsx(Button, { size: "slim", disabled: disabled || htmlMode, accessibilityLabel: "Insert link", onClick: insertLink, children: "Link" }), _jsx(Button, { size: "slim", disabled: disabled || htmlMode, accessibilityLabel: "Clear formatting", onClick: clearFormatting, children: "Clear" })] }), _jsx(Button, { size: "slim", pressed: htmlMode, disabled: disabled, accessibilityLabel: "Toggle raw HTML source", onClick: htmlMode ? leaveHtmlMode : enterHtmlMode, children: "HTML" })] }), htmlMode ? (_jsx(TextField, { label: "Description HTML source", labelHidden: true, value: source, onChange: changeSource, multiline: 8, monospaced: true, autoComplete: "off", disabled: disabled, helpText: "Only simple formatting tags are kept; scripts, styles, images, and attributes are removed automatically." })) : (_jsx("div", { ref: surfaceRef, contentEditable: !disabled, suppressContentEditableWarning: true, role: "textbox", "aria-multiline": "true", "aria-label": "Description", onInput: emitFromSurface, onBlur: emitFromSurface, style: surfaceStyle(disabled, Boolean(error)) })), _jsxs(InlineStack, { align: "space-between", blockAlign: "center", gap: "200", wrap: true, children: [_jsxs(Text, { as: "span", variant: "bodySm", tone: overLimit ? 'critical' : 'subdued', children: [characterCount.toLocaleString(), " / ", maxLength.toLocaleString(), " HTML characters"] }), error && _jsx(Text, { as: "span", variant: "bodySm", tone: "critical", children: error })] }), helpText && _jsx(Text, { as: "span", variant: "bodySm", tone: "subdued", children: helpText })] }));
};
export default RichTextEditor;
