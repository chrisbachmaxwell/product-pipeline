import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useMemo, useState } from 'react';
import { Badge, Banner, BlockStack, Box, Button, Card, InlineGrid, InlineStack, Modal, Text, TextField, Thumbnail, } from '@shopify/polaris';
import { canonicalDraftImages, canonicalDraftItemSpecifics, draftFieldValue, effectiveDraftImages, inheritedFieldValue, isListingDraftSaveInput, parseDraftImages, verifiedDraftImageUrl, } from '../hooks/useListingDraft';
import { emptyListingEditorMetadata, useListingEditorMetadata, } from '../hooks/useListingEditorMetadata';
import { isAllowlistedListingHtml, LISTING_DESCRIPTION_MAX_LENGTH, sanitizeListingHtml, } from '../listing-html';
import { descriptionSummary } from '../operator-ui';
import { CategoryPicker, ConditionSelect, conditionDisplayLabel, IdUsageSelect, } from './ListingFieldPickers';
import RichTextEditor from './RichTextEditor';
const TITLE_MAX_LENGTH = 80;
const POSITIVE_ID_PATTERN = /^[1-9]\d{0,31}$/u;
const MERCHANT_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const nullIfBlank = (value) => value.trim() ? value : null;
const currentLabel = (field) => {
    const ebay = field.ebay ? descriptionSummary(field.ebay, 120) : '';
    const shopify = field.shopify ? descriptionSummary(field.shopify, 120) : '';
    if (ebay && shopify && ebay !== shopify)
        return `eBay: ${ebay} · Shopify: ${shopify}`;
    if (ebay)
        return `eBay: ${ebay}`;
    if (shopify)
        return `Shopify: ${shopify}`;
    return 'No current value';
};
const initialValues = (draft) => ({
    title: draft.sections.listing.title.draft,
    category: draft.sections.listing.category.draft,
    condition: draft.sections.listing.condition.draft,
    conditionDescription: draft.sections.listing.conditionDescription.draft,
    description: draft.sections.content.description.draft,
    images: draft.sections.content.images.draft,
    itemSpecifics: draft.sections.content.itemSpecifics.draft,
    fulfillmentPolicyId: draft.sections.delivery.fulfillmentPolicyId.draft,
    paymentPolicyId: draft.sections.delivery.paymentPolicyId.draft,
    returnPolicyId: draft.sections.delivery.returnPolicyId.draft,
    merchantLocation: draft.sections.delivery.merchantLocation.draft,
});
export const initialDraftValues = initialValues;
export const buildListingDraftSaveInput = (draft, values, images) => ({
    schemaVersion: 1,
    action: 'save_local_draft',
    catalogId: draft.catalogId,
    expectedRevisionDigest: draft.revision?.revisionDigest ?? null,
    base: {
        sourceDigest: draft.base.sourceDigest,
        ebayDigest: draft.base.ebayDigest,
    },
    draft: { ...values, images },
});
export const isSemanticScalarChange = (field, initialDraft, nextDraft) => {
    if (!field.editable || nextDraft === initialDraft)
        return false;
    if (initialDraft === null && nextDraft === (field.ebay ?? field.shopify))
        return false;
    return true;
};
export const isSemanticImageChange = (field, imagesDirty, nextSerialized) => {
    if (!field.editable || !imagesDirty)
        return false;
    const inherited = field.ebay ?? field.shopify;
    if (field.draft === null && nextSerialized === inherited)
        return false;
    return nextSerialized !== field.draft;
};
const FieldLabel = ({ text, changed }) => (_jsxs(InlineStack, { gap: "200", blockAlign: "center", children: [_jsx(Text, { as: "span", children: text }), changed && _jsx(Badge, { tone: "attention", children: "Changed" })] }));
const DraftTextField = ({ label, field, value, multiline, error, showCharacterCount, extraHelp, onChange }) => (_jsx(TextField, { label: label, value: value, onChange: onChange, disabled: !field.editable, placeholder: descriptionSummary(inheritedFieldValue(field), 120) || 'Use current value', helpText: extraHelp ? (_jsxs(BlockStack, { gap: "050", children: [_jsx(Text, { as: "span", variant: "bodySm", tone: "subdued", children: currentLabel(field) }), _jsx(Text, { as: "span", variant: "bodySm", tone: "subdued", children: extraHelp })] })) : currentLabel(field), autoComplete: "off", multiline: multiline, error: error, showCharacterCount: showCharacterCount }));
/** Money and quantity may arrive as raw JSON strings; show them like money. */
const formatCompareValue = (raw) => {
    if (raw === null)
        return '—';
    try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed.amount === 'string') {
            return `$${parsed.amount}${parsed.currency && parsed.currency !== 'USD' ? ` ${parsed.currency}` : ''}`;
        }
    }
    catch { /* plain string */ }
    return raw;
};
const ReadOnlyCompare = ({ label, field }) => (_jsxs(BlockStack, { gap: "100", children: [_jsx(Text, { as: "p", variant: "bodySm", tone: "subdued", children: label }), _jsx(Text, { as: "p", fontWeight: "medium", children: formatCompareValue(field.ebay ?? field.shopify) }), field.ebay !== null && field.shopify !== null && field.ebay !== field.shopify && (_jsxs(Text, { as: "p", variant: "bodySm", tone: "subdued", children: ["Shopify: ", formatCompareValue(field.shopify)] })), _jsx(Text, { as: "p", variant: "bodySm", tone: "subdued", children: "Synced from Shopify automatically" })] }));
/**
 * Item specifics as plain Name / Value rows — operators should never
 * hand-author canonical JSON. Aspects with multiple values (rare) fall back
 * to a raw JSON textarea so nothing becomes uneditable.
 */
const SpecificsRows = ({ label, changed, raw, editable, error, onChange }) => {
    const parsed = useMemo(() => {
        if (raw === null || raw.trim() === '')
            return { rows: [], multi: false };
        try {
            const object = JSON.parse(raw);
            const rows = [];
            let multi = false;
            for (const [name, value] of Object.entries(object)) {
                if (Array.isArray(value) && value.every((entry) => typeof entry === 'string')) {
                    if (value.length > 1)
                        multi = true;
                    rows.push({ name, value: value.join(', ') });
                }
                else {
                    multi = true;
                }
            }
            return { rows, multi };
        }
        catch {
            return { rows: [], multi: true };
        }
    }, [raw]);
    const [rows, setRows] = useState(parsed.rows);
    const emit = (next) => {
        setRows(next);
        const object = {};
        for (const row of next) {
            if (row.name.trim())
                object[row.name.trim()] = [row.value.trim()];
        }
        onChange(JSON.stringify(object));
    };
    if (parsed.multi) {
        // Preserve full fidelity for multi-value aspects.
        return (_jsx(TextField, { label: label, value: raw ?? '', onChange: onChange, multiline: 3, disabled: !editable, error: error, autoComplete: "off", helpText: "This listing uses multi-value specifics; edit the JSON directly." }));
    }
    return (_jsxs(BlockStack, { gap: "200", children: [_jsxs(InlineStack, { align: "space-between", blockAlign: "center", children: [_jsxs(InlineStack, { gap: "200", blockAlign: "center", children: [_jsx(Text, { as: "span", fontWeight: "medium", children: label }), changed && _jsx(Badge, { tone: "attention", children: "Changed" })] }), _jsx(Button, { variant: "plain", disabled: !editable || rows.length >= 50, onClick: () => emit([...rows, { name: '', value: '' }]), children: "Add row" })] }), error && _jsx(Text, { as: "p", variant: "bodySm", tone: "critical", children: error }), rows.length === 0 && (_jsx(Text, { as: "p", tone: "subdued", children: "Add details buyers filter by \u2014 Brand, Model, Type, Mount\u2026" })), rows.map((row, index) => (_jsxs(InlineStack, { gap: "200", blockAlign: "center", wrap: false, children: [_jsx("div", { style: { flex: 1 }, children: _jsx(TextField, { label: "Name", labelHidden: true, placeholder: "Name (e.g. Brand)", value: row.name, disabled: !editable, onChange: (value) => emit(rows.map((entry, entryIndex) => entryIndex === index ? { ...entry, name: value } : entry)), autoComplete: "off" }) }), _jsx("div", { style: { flex: 2 }, children: _jsx(TextField, { label: "Value", labelHidden: true, placeholder: "Value (e.g. Canon)", value: row.value, disabled: !editable, onChange: (value) => emit(rows.map((entry, entryIndex) => entryIndex === index ? { ...entry, value } : entry)), autoComplete: "off" }) }), _jsx(Button, { variant: "plain", tone: "critical", disabled: !editable, onClick: () => emit(rows.filter((_, entryIndex) => entryIndex !== index)), accessibilityLabel: `Remove specific ${index + 1}`, children: "Remove" })] }, String(index))))] }));
};
const ListingDraftEditor = ({ draft, saving, onCancel, onSave, statusCard }) => {
    const [newImageUrl, setNewImageUrl] = useState('');
    const [editBase] = useState(draft);
    const initial = useMemo(() => initialValues(editBase), [editBase]);
    const [values, setValues] = useState(initial);
    const inheritedImages = useMemo(() => parseDraftImages(editBase.sections.content.images.ebay ?? editBase.sections.content.images.shopify), [editBase]);
    const initialImages = useMemo(() => parseDraftImages(initial.images), [initial.images]);
    const [images, setImages] = useState(() => effectiveDraftImages(editBase.sections.content.images));
    const [imagesDirty, setImagesDirty] = useState(false);
    const [previewOpen, setPreviewOpen] = useState(false);
    const [saveError, setSaveError] = useState(false);
    const metadataQuery = useListingEditorMetadata();
    const metadata = metadataQuery.data ?? emptyListingEditorMetadata();
    const setValue = (key, value) => {
        setSaveError(false);
        setValues((current) => ({ ...current, [key]: value }));
    };
    const set = (key, value) => setValue(key, nullIfBlank(value));
    const titleField = editBase.sections.listing.title;
    const categoryField = editBase.sections.listing.category;
    const conditionField = editBase.sections.listing.condition;
    const conditionDescriptionField = editBase.sections.listing.conditionDescription;
    const descriptionField = editBase.sections.content.description;
    const itemSpecificsField = editBase.sections.content.itemSpecifics;
    // The eBay-provided current description is untrusted HTML: it is sanitized
    // here, before it can ever enter the contentEditable surface.
    const currentDescriptionHtml = useMemo(() => sanitizeListingHtml(inheritedFieldValue(descriptionField)), [descriptionField]);
    const [descriptionHtml, setDescriptionHtml] = useState(() => initial.description === null
        ? currentDescriptionHtml
        : sanitizeListingHtml(initial.description));
    const changeDescription = (html) => {
        setDescriptionHtml(html);
        setValue('description', html.trim() ? html : null);
    };
    const resetDescription = () => {
        setDescriptionHtml(currentDescriptionHtml);
        setValue('description', null);
    };
    const normalizedImages = images.map((value) => value.trim()).filter(Boolean);
    const invalidImage = normalizedImages.some((value) => !verifiedDraftImageUrl(value));
    const effectiveImageList = normalizedImages.map((value) => verifiedDraftImageUrl(value) ?? value);
    const serializedImages = imagesDirty
        ? effectiveImageList.length > 0 ? canonicalDraftImages(effectiveImageList) : null
        : initial.images;
    const fields = [
        ['title', 'Title', titleField],
        ['category', 'Category', categoryField],
        ['condition', 'Condition', conditionField],
        ['conditionDescription', 'Condition description', conditionDescriptionField],
        ['description', 'Description', descriptionField],
        ['itemSpecifics', 'Item specifics', itemSpecificsField],
        ['fulfillmentPolicyId', 'Fulfillment policy', editBase.sections.delivery.fulfillmentPolicyId],
        ['paymentPolicyId', 'Payment policy', editBase.sections.delivery.paymentPolicyId],
        ['returnPolicyId', 'Return policy', editBase.sections.delivery.returnPolicyId],
        ['merchantLocation', 'Merchant location', editBase.sections.delivery.merchantLocation],
    ];
    const changedFor = (key, field) => isSemanticScalarChange(field, initial[key], values[key]);
    const changes = fields.flatMap(([key, label, field]) => {
        if (!isSemanticScalarChange(field, initial[key], values[key]))
            return [];
        return [{
                label,
                before: descriptionSummary((initial[key] ?? inheritedFieldValue(field)) || 'Not set', 160),
                after: key === 'conditionDescription' && values[key] === ''
                    ? 'Omit optional field'
                    : descriptionSummary(values[key] ?? 'Use current value', 160),
            }];
    });
    const imagesChanged = isSemanticImageChange(editBase.sections.content.images, imagesDirty, serializedImages);
    if (imagesChanged) {
        changes.push({
            label: 'Images',
            before: `${(initial.images === null ? inheritedImages : initialImages).length} images`,
            after: serializedImages === null ? 'Use current images' : `${normalizedImages.length} images`,
        });
    }
    const hasChanges = changes.length > 0;
    const normalizedValues = fields.reduce((result, [key, , field]) => ({
        ...result,
        [key]: isSemanticScalarChange(field, initial[key], values[key]) ? values[key] : initial[key],
    }), { ...values });
    const normalizedImagesForSave = imagesChanged ? serializedImages : initial.images;
    const saveInput = buildListingDraftSaveInput(editBase, normalizedValues, normalizedImagesForSave);
    const draftInputValid = isListingDraftSaveInput(saveInput);
    const submit = async () => {
        setSaveError(false);
        try {
            await onSave(saveInput);
        }
        catch {
            setSaveError(true);
        }
    };
    const titleError = values.title !== null && (values.title.trim() !== values.title
        || values.title.length === 0
        || values.title.length > TITLE_MAX_LENGTH) ? `Use 1–${TITLE_MAX_LENGTH} characters with no leading or trailing spaces` : undefined;
    const categoryError = values.category !== null && !POSITIVE_ID_PATTERN.test(values.category)
        ? 'Use a positive eBay category ID' : undefined;
    const conditionError = values.condition !== null && !POSITIVE_ID_PATTERN.test(values.condition)
        ? 'Use a positive eBay condition ID' : undefined;
    const descriptionError = values.description !== null && (values.description.trim().length === 0
        || values.description.trim() !== values.description
        || values.description.length > LISTING_DESCRIPTION_MAX_LENGTH
        || !isAllowlistedListingHtml(values.description)) ? `Use simple formatting only, up to ${LISTING_DESCRIPTION_MAX_LENGTH.toLocaleString()} HTML characters`
        : undefined;
    const conditionCurrentSummary = conditionField.ebay
        ? `eBay: ${conditionDisplayLabel(conditionField.ebay, metadata.conditions)}`
        : conditionField.shopify
            ? `Shopify: ${conditionDisplayLabel(conditionField.shopify, metadata.conditions)}`
            : 'No current value';
    const conditionNote = 'Condition is saved to the draft but is not yet dispatchable to eBay.';
    const idField = (key, labelText, field, options, idNoun, pattern, errorText) => {
        const value = values[key];
        const error = value !== null && !pattern.test(value) ? errorText : undefined;
        const label = _jsx(FieldLabel, { text: labelText, changed: changedFor(key, field) });
        return options.length > 0 ? (_jsx(IdUsageSelect, { label: label, value: value, options: options, currentValue: field.ebay ?? field.shopify, idNoun: idNoun, disabled: !field.editable, error: error, onChange: (next) => setValue(key, next) })) : (_jsx(DraftTextField, { label: label, field: field, value: draftFieldValue({ ...field, draft: value }), error: error, onChange: (next) => set(key, next) }));
    };
    return (_jsxs(BlockStack, { gap: "400", children: [statusCard, _jsxs(BlockStack, { gap: "400", children: [saveError && (_jsx(Banner, { tone: "critical", children: _jsx(Text, { as: "p", children: "Draft was not saved. Reload this listing and try again." }) })), hasChanges && !draftInputValid && (_jsx(Banner, { tone: "critical", children: _jsx(Text, { as: "p", children: "Review the highlighted draft fields." }) })), metadataQuery.isError && (_jsx(Banner, { tone: "info", children: _jsx(Text, { as: "p", children: "Editor suggestions are unavailable right now \u2014 fields accept manual entry." }) })), _jsx(Card, { children: _jsxs(BlockStack, { gap: "400", children: [_jsx(Text, { as: "h3", variant: "headingMd", children: "Listing" }), _jsx(DraftTextField, { label: _jsx(FieldLabel, { text: "Title", changed: changedFor('title', titleField) }), field: titleField, value: draftFieldValue({ ...titleField, draft: values.title }), error: titleError, showCharacterCount: true, extraHelp: `eBay titles allow up to ${TITLE_MAX_LENGTH} characters.`, onChange: (value) => set('title', value) }), _jsxs(InlineGrid, { columns: { xs: 1, md: 2 }, gap: "400", children: [_jsx(CategoryPicker, { label: _jsx(FieldLabel, { text: "Category", changed: changedFor('category', categoryField) }), value: values.category, categories: metadata.categories, currentSummary: currentLabel(categoryField), disabled: !categoryField.editable, error: categoryError, onChange: (next) => setValue('category', next) }), metadata.conditions.length > 0 ? (_jsx(ConditionSelect, { label: _jsx(FieldLabel, { text: "Condition", changed: changedFor('condition', conditionField) }), value: values.condition, conditions: metadata.conditions, currentSummary: conditionCurrentSummary, disabled: !conditionField.editable, error: conditionError, onChange: (next) => setValue('condition', next) })) : (_jsx(DraftTextField, { label: _jsx(FieldLabel, { text: "Condition", changed: changedFor('condition', conditionField) }), field: conditionField, value: draftFieldValue({ ...conditionField, draft: values.condition }), error: conditionError, extraHelp: conditionNote, onChange: (value) => set('condition', value) }))] }), _jsx(DraftTextField, { label: (_jsxs(InlineStack, { align: "space-between", blockAlign: "center", gap: "200", wrap: true, children: [_jsx(FieldLabel, { text: "Condition description", changed: changedFor('conditionDescription', conditionDescriptionField) }), _jsxs(InlineStack, { gap: "200", children: [_jsx(Button, { variant: "plain", onClick: () => setValue('conditionDescription', ''), disabled: !conditionDescriptionField.editable
                                                            || values.conditionDescription === '', children: "Omit optional field" }), _jsx(Button, { variant: "plain", onClick: () => setValue('conditionDescription', null), disabled: !conditionDescriptionField.editable
                                                            || values.conditionDescription === null, children: "Use current value" })] })] })), field: conditionDescriptionField, value: draftFieldValue({
                                        ...conditionDescriptionField,
                                        draft: values.conditionDescription,
                                    }), error: values.conditionDescription !== null
                                        && values.conditionDescription !== '' && (values.conditionDescription.trim() !== values.conditionDescription
                                        || values.conditionDescription.length > 1_000) ? 'Use 1–1,000 characters with no leading or trailing spaces' : undefined, multiline: 2, extraHelp: "Optional. Use only to clarify physical condition; omit unrelated text.", onChange: (value) => setValue('conditionDescription', value) }), _jsxs(InlineGrid, { columns: { xs: 1, sm: 2 }, gap: "400", children: [_jsx(ReadOnlyCompare, { label: "Price", field: editBase.sections.listing.price }), _jsx(ReadOnlyCompare, { label: "Quantity", field: editBase.sections.listing.quantity })] })] }) }), _jsx(Card, { children: _jsxs(BlockStack, { gap: "400", children: [_jsx(Text, { as: "h3", variant: "headingMd", children: "Description & photos" }), _jsx(RichTextEditor, { label: (_jsxs(InlineStack, { align: "space-between", blockAlign: "center", gap: "200", wrap: true, children: [_jsx(FieldLabel, { text: "Description", changed: changedFor('description', descriptionField) }), _jsx(Button, { variant: "plain", onClick: resetDescription, disabled: !descriptionField.editable, children: "Use current value" })] })), value: descriptionHtml, disabled: !descriptionField.editable, error: descriptionError, helpText: currentLabel(descriptionField), maxLength: LISTING_DESCRIPTION_MAX_LENGTH, onChange: changeDescription }), _jsxs(BlockStack, { gap: "300", children: [_jsxs(InlineStack, { align: "space-between", blockAlign: "center", children: [_jsxs(InlineStack, { gap: "200", blockAlign: "center", children: [_jsx(Text, { as: "h4", variant: "headingSm", children: "Photos" }), imagesChanged && _jsx(Badge, { tone: "attention", children: "Changed" })] }), _jsxs(Text, { as: "span", variant: "bodySm", tone: "subdued", children: [images.filter((image) => image.trim() !== '').length, " of 24"] })] }), images.length === 0 ? (_jsx(Text, { as: "p", tone: "subdued", children: "Using the current photos." })) : (_jsx(InlineStack, { gap: "300", wrap: true, children: images.map((image, index) => {
                                                const verified = verifiedDraftImageUrl(image);
                                                return (_jsxs(BlockStack, { gap: "100", inlineAlign: "center", children: [_jsx(Thumbnail, { size: "large", source: verified ?? '', alt: verified ? `Photo ${index + 1}` : 'Invalid image URL' }), image.trim() !== '' && !verified && (_jsx(Text, { as: "span", variant: "bodySm", tone: "critical", children: "Invalid URL" })), _jsx(Button, { variant: "plain", tone: "critical", disabled: !editBase.sections.content.images.editable, onClick: () => {
                                                                setImagesDirty(true);
                                                                setImages((current) => current.filter((_, itemIndex) => itemIndex !== index));
                                                            }, accessibilityLabel: `Remove photo ${index + 1}`, children: "Remove" })] }, String(index)));
                                            }) })), editBase.sections.content.images.editable && images.length < 24 && (_jsxs(InlineStack, { gap: "200", blockAlign: "end", wrap: false, children: [_jsx("div", { style: { flex: 1 }, children: _jsx(TextField, { label: "Add photo by URL", labelHidden: true, placeholder: "Paste a Shopify or eBay image URL", value: newImageUrl, onChange: setNewImageUrl, autoComplete: "off", error: newImageUrl.trim() !== '' && !verifiedDraftImageUrl(newImageUrl.trim())
                                                            ? 'Use a Shopify or eBay image URL' : undefined }) }), _jsx(Button, { onClick: () => {
                                                        if (!newImageUrl.trim())
                                                            return;
                                                        setImagesDirty(true);
                                                        setImages((current) => [...current, newImageUrl.trim()]);
                                                        setNewImageUrl('');
                                                    }, disabled: !newImageUrl.trim() || !verifiedDraftImageUrl(newImageUrl.trim()), children: "Add" })] }))] }), _jsx(SpecificsRows, { label: "Item specifics", changed: changedFor('itemSpecifics', itemSpecificsField), raw: values.itemSpecifics ?? itemSpecificsField.ebay ?? itemSpecificsField.shopify, editable: itemSpecificsField.editable, error: values.itemSpecifics !== null
                                        && canonicalDraftItemSpecifics(values.itemSpecifics) !== values.itemSpecifics
                                        ? 'Item specifics could not be read — fix the highlighted rows'
                                        : undefined, onChange: (next) => setValue('itemSpecifics', next) })] }) }), _jsx(Card, { children: _jsxs(BlockStack, { gap: "400", children: [_jsx(Text, { as: "h3", variant: "headingMd", children: "Delivery" }), _jsxs(InlineGrid, { columns: { xs: 1, md: 2 }, gap: "400", children: [idField('fulfillmentPolicyId', 'Fulfillment policy', editBase.sections.delivery.fulfillmentPolicyId, metadata.policies.fulfillment, 'policy ID', POSITIVE_ID_PATTERN, 'Use a positive policy ID'), idField('paymentPolicyId', 'Payment policy', editBase.sections.delivery.paymentPolicyId, metadata.policies.payment, 'policy ID', POSITIVE_ID_PATTERN, 'Use a positive policy ID'), idField('returnPolicyId', 'Return policy', editBase.sections.delivery.returnPolicyId, metadata.policies.return, 'policy ID', POSITIVE_ID_PATTERN, 'Use a positive policy ID'), idField('merchantLocation', 'Merchant location', editBase.sections.delivery.merchantLocation, metadata.merchantLocations, 'location key', MERCHANT_KEY_PATTERN, 'Use a valid merchant location key')] })] }) }), _jsxs(InlineStack, { align: "end", gap: "300", children: [_jsx(Button, { onClick: onCancel, disabled: saving, children: "Close" }), _jsx(Button, { onClick: () => setPreviewOpen(true), disabled: !hasChanges || invalidImage || !draftInputValid || saving, children: "Preview changes" }), _jsx(Button, { variant: "primary", onClick: () => { void submit(); }, loading: saving, disabled: !hasChanges || invalidImage || !draftInputValid, children: "Save draft" })] }), _jsx(Modal, { open: previewOpen, onClose: () => setPreviewOpen(false), title: "Draft changes", primaryAction: { content: 'Close', onAction: () => setPreviewOpen(false) }, children: _jsx(Modal.Section, { children: _jsxs(BlockStack, { gap: "300", children: [_jsx(Banner, { tone: "info", children: _jsx(Text, { as: "p", children: "Preview only. Nothing will be applied." }) }), changes.map((change) => (_jsx(Box, { background: "bg-surface-secondary", borderRadius: "200", padding: "300", children: _jsxs(BlockStack, { gap: "150", children: [_jsxs(InlineStack, { gap: "200", blockAlign: "center", children: [_jsx(Text, { as: "h3", variant: "headingSm", children: change.label }), _jsx(Badge, { tone: "attention", children: "Changed" })] }), _jsxs(InlineGrid, { columns: { xs: 1, sm: 2 }, gap: "200", children: [_jsxs(BlockStack, { gap: "050", children: [_jsx(Text, { as: "p", variant: "bodySm", tone: "subdued", children: "Before" }), _jsx(Text, { as: "p", tone: "subdued", textDecorationLine: "line-through", children: change.before })] }), _jsxs(BlockStack, { gap: "050", children: [_jsx(Text, { as: "p", variant: "bodySm", tone: "subdued", children: "After" }), _jsx(Text, { as: "p", fontWeight: "medium", children: change.after })] })] })] }) }, change.label)))] }) }) })] })] }));
};
export default ListingDraftEditor;
