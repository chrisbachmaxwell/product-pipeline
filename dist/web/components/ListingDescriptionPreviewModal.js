import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState } from 'react';
import { Banner, BlockStack, Button, ButtonGroup, InlineStack, Modal, Spinner, Text, } from '@shopify/polaris';
import { useListingDescriptionPreview } from '../hooks/useListingDescriptionPreview';
/**
 * Displays the server-rendered branded eBay description inside a strictly
 * sandboxed iframe (sandbox="" — no scripts, no same-origin). Display-only.
 */
const ListingDescriptionPreviewModal = ({ catalogId, open, hasUnsavedChanges, draftDescriptionHtml, onClose, }) => {
    const [narrow, setNarrow] = useState(false);
    const preview = useListingDescriptionPreview(catalogId, { enabled: open });
    const serverHtml = preview.data?.html ?? null;
    // When the operator has unsaved edits, previewing the stale saved draft is
    // actively misleading — show what they are LOOKING AT instead. The branded
    // frame (header, shipping/returns cards) is applied by the template at
    // publish; the body is theirs.
    const liveHtml = hasUnsavedChanges && draftDescriptionHtml
        ? `<body style="margin:24px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#1a1a1a;line-height:1.5;background:#ffffff">${draftDescriptionHtml}</body>`
        : null;
    const html = liveHtml ?? serverHtml;
    const templateVersion = preview.data?.templateVersion ?? null;
    return (_jsx(Modal, { open: open, onClose: onClose, title: "eBay description preview", size: "large", primaryAction: { content: 'Close', onAction: onClose }, children: _jsx(Modal.Section, { children: _jsxs(BlockStack, { gap: "400", children: [liveHtml ? (_jsx(Banner, { tone: "info", children: _jsx(Text, { as: "p", children: "Showing your current edits. The branded frame \u2014 store header, shipping and returns cards \u2014 is added automatically when you publish. Nothing is sent to eBay from here." }) })) : (_jsx(Banner, { tone: "info", children: _jsx(Text, { as: "p", children: "This is how the description will look on eBay, using the last saved draft. Nothing is sent to eBay from here." }) })), preview.isLoading ? (_jsx(InlineStack, { align: "center", blockAlign: "center", gap: "200", children: _jsx(Spinner, { accessibilityLabel: "Loading description preview", size: "large" }) })) : preview.isError || html === null ? (_jsx(Banner, { tone: "warning", title: "Preview is unavailable right now", children: _jsx(Text, { as: "p", children: "Try again in a moment, or save the draft and reopen the preview." }) })) : (_jsxs(BlockStack, { gap: "300", children: [_jsxs(InlineStack, { align: "space-between", blockAlign: "center", gap: "300", wrap: true, children: [_jsxs(ButtonGroup, { variant: "segmented", children: [_jsx(Button, { pressed: !narrow, onClick: () => setNarrow(false), children: "Full width" }), _jsx(Button, { pressed: narrow, onClick: () => setNarrow(true), children: "Mobile (375px)" })] }), templateVersion && (_jsxs(Text, { as: "span", variant: "bodySm", tone: "subdued", children: ["Template ", templateVersion] }))] }), _jsx("div", { style: {
                                    display: 'flex',
                                    justifyContent: 'center',
                                    border: '1px solid var(--p-color-border, #e3e3e3)',
                                    borderRadius: '8px',
                                    background: '#ffffff',
                                    overflow: 'auto',
                                }, children: _jsx("iframe", { sandbox: "", srcDoc: html, title: "eBay description preview", style: {
                                        width: narrow ? '375px' : '100%',
                                        maxWidth: '100%',
                                        height: '65vh',
                                        minHeight: '360px',
                                        border: '0',
                                        display: 'block',
                                        background: '#ffffff',
                                    } }) })] }))] }) }) }));
};
export default ListingDescriptionPreviewModal;
