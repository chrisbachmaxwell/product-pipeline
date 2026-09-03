import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useMemo, useState } from 'react';
import { Badge, Banner, BlockStack, Box, Button, Card, Divider, InlineGrid, InlineStack, Modal, Text, TextField, } from '@shopify/polaris';
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
const ReadOnlyCompare = ({ label, field }) => (_jsxs(BlockStack, { gap: "100", children: [_jsx(Text, { as: "p", variant: "bodySm", tone: "subdued", children: label }), _jsx(Text, { as: "p", fontWeight: "medium", children: field.ebay ?? field.shopify ?? '—' }), field.ebay !== null && field.shopify !== null && field.ebay !== field.shopify && (_jsxs(Text, { as: "p", variant: "bodySm", tone: "subdued", children: ["Shopify: ", field.shopify] })), _jsx(Text, { as: "p", variant: "bodySm", tone: "subdued", children: "Synced by Marketplace Connect \u2014 not editable here" })] }));
const ListingDraftEditor = ({ draft, saving, onCancel, onSave }) => {
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
    return (_jsx(Card, { children: _jsxs(BlockStack, { gap: "500", children: [_jsxs(InlineStack, { align: "space-between", blockAlign: "center", gap: "300", children: [_jsxs(BlockStack, { gap: "050", children: [_jsx(Text, { as: "h2", variant: "headingMd", children: "Local draft" }), _jsx(Text, { as: "p", variant: "bodySm", tone: "subdued", children: "Nothing is sent to Shopify or eBay." })] }), _jsx(Button, { onClick: onCancel, disabled: saving, children: "Close" })] }), saveError && (_jsx(Banner, { tone: "critical", children: _jsx(Text, { as: "p", children: "Draft was not saved. Reload this listing and try again." }) })), hasChanges && !draftInputValid && (_jsx(Banner, { tone: "critical", children: _jsx(Text, { as: "p", children: "Review the highlighted draft fields." }) })), metadataQuery.isError && (_jsx(Banner, { tone: "info", children: _jsx(Text, { as: "p", children: "Editor suggestions are unavailable right now \u2014 fields accept manual entry." }) })), _jsxs(BlockStack, { gap: "400", children: [_jsx(Text, { as: "h3", variant: "headingSm", children: "Listing" }), _jsx(DraftTextField, { label: _jsx(FieldLabel, { text: "Title", changed: changedFor('title', titleField) }), field: titleField, value: draftFieldValue({ ...titleField, draft: values.title }), error: titleError, showCharacterCount: true, extraHelp: `eBay titles allow up to ${TITLE_MAX_LENGTH} characters.`, onChange: (value) => set('title', value) }), _jsxs(InlineGrid, { columns: { xs: 1, md: 2 }, gap: "400", children: [_jsx(CategoryPicker, { label: _jsx(FieldLabel, { text: "Category", changed: changedFor('category', categoryField) }), value: values.category, categories: metadata.categories, currentSummary: currentLabel(categoryField), disabled: !categoryField.editable, error: categoryError, onChange: (next) => setValue('category', next) }), metadata.conditions.length > 0 ? (_jsx(ConditionSelect, { label: _jsx(FieldLabel, { text: "Condition", changed: changedFor('condition', conditionField) }), value: values.condition, conditions: metadata.conditions, currentSummary: conditionCurrentSummary, disabled: !conditionField.editable, error: conditionError, onChange: (next) => setValue('condition', next) })) : (_jsx(DraftTextField, { label: _jsx(FieldLabel, { text: "Condition", changed: changedFor('condition', conditionField) }), field: conditionField, value: draftFieldValue({ ...conditionField, draft: values.condition }), error: conditionError, extraHelp: conditionNote, onChange: (value) => set('condition', value) }))] }), _jsx(DraftTextField, { label: (_jsxs(InlineStack, { align: "space-between", blockAlign: "center", gap: "200", wrap: true, children: [_jsx(FieldLabel, { text: "Condition description", changed: changedFor('conditionDescription', conditionDescriptionField) }), _jsxs(InlineStack, { gap: "200", children: [_jsx(Button, { variant: "plain", onClick: () => setValue('conditionDescription', ''), disabled: !conditionDescriptionField.editable
                                                    || values.conditionDescription === '', children: "Omit optional field" }), _jsx(Button, { variant: "plain", onClick: () => setValue('conditionDescription', null), disabled: !conditionDescriptionField.editable
                                                    || values.conditionDescription === null, children: "Use current value" })] })] })), field: conditionDescriptionField, value: draftFieldValue({
                                ...conditionDescriptionField,
                                draft: values.conditionDescription,
                            }), error: values.conditionDescription !== null
                                && values.conditionDescription !== '' && (values.conditionDescription.trim() !== values.conditionDescription
                                || values.conditionDescription.length > 1_000) ? 'Use 1–1,000 characters with no leading or trailing spaces' : undefined, multiline: 2, extraHelp: "Optional. Use only to clarify physical condition; omit unrelated text.", onChange: (value) => setValue('conditionDescription', value) }), _jsxs(InlineGrid, { columns: { xs: 1, sm: 2 }, gap: "400", children: [_jsx(ReadOnlyCompare, { label: "Price", field: editBase.sections.listing.price }), _jsx(ReadOnlyCompare, { label: "Quantity", field: editBase.sections.listing.quantity })] })] }), _jsx(Divider, {}), _jsxs(BlockStack, { gap: "400", children: [_jsx(Text, { as: "h3", variant: "headingSm", children: "Content" }), _jsx(RichTextEditor, { label: (_jsxs(InlineStack, { align: "space-between", blockAlign: "center", gap: "200", wrap: true, children: [_jsx(FieldLabel, { text: "Description", changed: changedFor('description', descriptionField) }), _jsx(Button, { variant: "plain", onClick: resetDescription, disabled: !descriptionField.editable, children: "Use current value" })] })), value: descriptionHtml, disabled: !descriptionField.editable, error: descriptionError, helpText: currentLabel(descriptionField), maxLength: LISTING_DESCRIPTION_MAX_LENGTH, onChange: changeDescription }), _jsxs(BlockStack, { gap: "300", children: [_jsxs(InlineStack, { align: "space-between", blockAlign: "center", children: [_jsxs(InlineStack, { gap: "200", blockAlign: "center", children: [_jsx(Text, { as: "h4", variant: "headingSm", children: "Images" }), imagesChanged && _jsx(Badge, { tone: "attention", children: "Changed" })] }), _jsx(Button, { variant: "plain", onClick: () => { setImagesDirty(true); setImages((current) => [...current, '']); }, disabled: !editBase.sections.content.images.editable || images.length >= 24, children: "Add image" })] }), images.length === 0 ? (_jsx(Text, { as: "p", tone: "subdued", children: "Using current images." })) : images.map((image, index) => (_jsxs(InlineStack, { gap: "200", blockAlign: "end", wrap: false, children: [_jsx("div", { style: { flex: 1 }, children: _jsx(TextField, { label: `Image ${index + 1}`, value: image, onChange: (value) => {
                                                    setImagesDirty(true);
                                                    setImages((current) => current.map((item, itemIndex) => itemIndex === index ? value : item));
                                                }, autoComplete: "off", error: image.trim() && !verifiedDraftImageUrl(image)
                                                    ? 'Use an approved Shopify or eBay image URL' : undefined }) }), _jsx(Button, { onClick: () => {
                                                setImagesDirty(true);
                                                setImages((current) => current.filter((_, itemIndex) => itemIndex !== index));
                                            }, accessibilityLabel: `Remove image ${index + 1}`, children: "Remove" })] }, String(index))))] }), _jsx(DraftTextField, { label: (_jsx(FieldLabel, { text: "Item specifics", changed: changedFor('itemSpecifics', itemSpecificsField) })), field: itemSpecificsField, value: draftFieldValue({ ...itemSpecificsField, draft: values.itemSpecifics }), error: values.itemSpecifics !== null
                                && canonicalDraftItemSpecifics(values.itemSpecifics) !== values.itemSpecifics
                                ? 'Use canonical JSON with 1–50 aspect names and string-array values'
                                : undefined, multiline: 3, extraHelp: 'Required for a new eBay listing. Example: {"Brand":["Canon"],"Type":["Lens"]}', onChange: (value) => set('itemSpecifics', value) })] }), _jsx(Divider, {}), _jsxs(BlockStack, { gap: "400", children: [_jsx(Text, { as: "h3", variant: "headingSm", children: "Delivery" }), _jsxs(InlineGrid, { columns: { xs: 1, md: 2 }, gap: "400", children: [idField('fulfillmentPolicyId', 'Fulfillment policy', editBase.sections.delivery.fulfillmentPolicyId, metadata.policies.fulfillment, 'policy ID', POSITIVE_ID_PATTERN, 'Use a positive policy ID'), idField('paymentPolicyId', 'Payment policy', editBase.sections.delivery.paymentPolicyId, metadata.policies.payment, 'policy ID', POSITIVE_ID_PATTERN, 'Use a positive policy ID'), idField('returnPolicyId', 'Return policy', editBase.sections.delivery.returnPolicyId, metadata.policies.return, 'policy ID', POSITIVE_ID_PATTERN, 'Use a positive policy ID'), idField('merchantLocation', 'Merchant location', editBase.sections.delivery.merchantLocation, metadata.merchantLocations, 'location key', MERCHANT_KEY_PATTERN, 'Use a valid merchant location key')] })] }), _jsxs(InlineStack, { align: "end", gap: "300", children: [_jsx(Button, { onClick: () => setPreviewOpen(true), disabled: !hasChanges || invalidImage || !draftInputValid || saving, children: "Preview changes" }), _jsx(Button, { variant: "primary", onClick: () => { void submit(); }, loading: saving, disabled: !hasChanges || invalidImage || !draftInputValid, children: "Save draft" })] }), _jsx(Modal, { open: previewOpen, onClose: () => setPreviewOpen(false), title: "Draft changes", primaryAction: { content: 'Close', onAction: () => setPreviewOpen(false) }, children: _jsx(Modal.Section, { children: _jsxs(BlockStack, { gap: "300", children: [_jsx(Banner, { tone: "info", children: _jsx(Text, { as: "p", children: "Preview only. Nothing will be applied." }) }), changes.map((change) => (_jsx(Box, { background: "bg-surface-secondary", borderRadius: "200", padding: "300", children: _jsxs(BlockStack, { gap: "150", children: [_jsxs(InlineStack, { gap: "200", blockAlign: "center", children: [_jsx(Text, { as: "h3", variant: "headingSm", children: change.label }), _jsx(Badge, { tone: "attention", children: "Changed" })] }), _jsxs(InlineGrid, { columns: { xs: 1, sm: 2 }, gap: "200", children: [_jsxs(BlockStack, { gap: "050", children: [_jsx(Text, { as: "p", variant: "bodySm", tone: "subdued", children: "Before" }), _jsx(Text, { as: "p", tone: "subdued", textDecorationLine: "line-through", children: change.before })] }), _jsxs(BlockStack, { gap: "050", children: [_jsx(Text, { as: "p", variant: "bodySm", tone: "subdued", children: "After" }), _jsx(Text, { as: "p", fontWeight: "medium", children: change.after })] })] })] }) }, change.label)))] }) }) })] }) }));
};
export default ListingDraftEditor;
