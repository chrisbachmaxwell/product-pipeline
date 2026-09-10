import React, { useEffect, useMemo, useState } from 'react';
import {
  Badge,
  Banner,
  BlockStack,
  Box,
  Button,
  Card,
  Divider,
  InlineGrid,
  InlineStack,
  Modal,
  Text,
  TextField,
  Thumbnail,
} from '@shopify/polaris';
import {
  canonicalDraftImages,
  canonicalDraftItemSpecifics,
  draftFieldValue,
  effectiveDraftImages,
  inheritedFieldValue,
  isListingDraftSaveInput,
  parseDraftImages,
  verifiedDraftImageUrl,
  type ListingDraftField,
  type ListingDraftResponse,
  type ListingDraftSaveInput,
} from '../hooks/useListingDraft';
import {
  emptyListingEditorMetadata,
  useListingEditorMetadata,
  type ListingEditorIdUsage,
} from '../hooks/useListingEditorMetadata';
import {
  isAllowlistedListingHtml,
  LISTING_DESCRIPTION_MAX_LENGTH,
  sanitizeListingHtml,
} from '../listing-html';
import { descriptionSummary } from '../operator-ui';
import {
  CategoryPicker,
  ConditionSelect,
  conditionDisplayLabel,
  IdUsageSelect,
} from './ListingFieldPickers';
import RichTextEditor from './RichTextEditor';

type EditableValues = ListingDraftSaveInput['draft'];

interface Props {
  draft: ListingDraftResponse;
  saving: boolean;
  onCancel: () => void;
  onSave: (input: ListingDraftSaveInput) => Promise<unknown>;
  /** Rendered above the editor (e.g. the Publish card). */
  statusCard?: React.ReactNode;
  /** Reports the live edit state so the page can keep previews truthful. */
  onDraftStateChange?: (state: { dirty: boolean; descriptionHtml: string | null }) => void;
}

interface Change {
  label: string;
  before: string;
  after: string;
}

const TITLE_MAX_LENGTH = 80;
const POSITIVE_ID_PATTERN = /^[1-9]\d{0,31}$/u;
const MERCHANT_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

const nullIfBlank = (value: string): string | null => value.trim() ? value : null;

const currentLabel = (field: ListingDraftField): string => {
  const ebay = field.ebay ? descriptionSummary(field.ebay, 120) : '';
  const shopify = field.shopify ? descriptionSummary(field.shopify, 120) : '';
  if (ebay && shopify && ebay !== shopify) return `eBay: ${ebay} · Shopify: ${shopify}`;
  if (ebay) return `eBay: ${ebay}`;
  if (shopify) return `Shopify: ${shopify}`;
  return 'No current value';
};

const initialValues = (draft: ListingDraftResponse): EditableValues => ({
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

export const buildListingDraftSaveInput = (
  draft: ListingDraftResponse,
  values: EditableValues,
  images: string | null,
): ListingDraftSaveInput => ({
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

export const isSemanticScalarChange = (
  field: ListingDraftField,
  initialDraft: string | null,
  nextDraft: string | null,
): boolean => {
  if (!field.editable || nextDraft === initialDraft) return false;
  if (initialDraft === null && nextDraft === (field.ebay ?? field.shopify)) return false;
  return true;
};

export const isSemanticImageChange = (
  field: ListingDraftField,
  imagesDirty: boolean,
  nextSerialized: string | null,
): boolean => {
  if (!field.editable || !imagesDirty) return false;
  const inherited = field.ebay ?? field.shopify;
  if (field.draft === null && nextSerialized === inherited) return false;
  return nextSerialized !== field.draft;
};

const FieldLabel: React.FC<{ text: string; changed: boolean }> = ({ text, changed }) => (
  <InlineStack gap="200" blockAlign="center">
    <Text as="span">{text}</Text>
    {changed && <Badge tone="attention">Changed</Badge>}
  </InlineStack>
);

const DraftTextField: React.FC<{
  label: React.ReactNode;
  field: ListingDraftField;
  value: string;
  multiline?: number;
  error?: string;
  showCharacterCount?: boolean;
  extraHelp?: string;
  onChange: (value: string) => void;
}> = ({ label, field, value, multiline, error, showCharacterCount, extraHelp, onChange }) => (
  <TextField
    label={label}
    value={value}
    onChange={onChange}
    disabled={!field.editable}
    placeholder={descriptionSummary(inheritedFieldValue(field), 120) || 'Use current value'}
    helpText={extraHelp ? (
      <BlockStack gap="050">
        <Text as="span" variant="bodySm" tone="subdued">{currentLabel(field)}</Text>
        <Text as="span" variant="bodySm" tone="subdued">{extraHelp}</Text>
      </BlockStack>
    ) : currentLabel(field)}
    autoComplete="off"
    multiline={multiline}
    error={error}
    showCharacterCount={showCharacterCount}
  />
);

/** Money and quantity may arrive as raw JSON strings; show them like money. */
const formatCompareValue = (raw: string | null): string => {
  if (raw === null) return '—';
  try {
    const parsed = JSON.parse(raw) as { amount?: string; currency?: string };
    if (parsed && typeof parsed.amount === 'string') {
      return `$${parsed.amount}${parsed.currency && parsed.currency !== 'USD' ? ` ${parsed.currency}` : ''}`;
    }
  } catch { /* plain string */ }
  return raw;
};

const ReadOnlyCompare: React.FC<{ label: string; field: ListingDraftField }> = ({ label, field }) => (
  <BlockStack gap="100">
    <Text as="p" variant="bodySm" tone="subdued">{label}</Text>
    <Text as="p" fontWeight="medium">{formatCompareValue(field.ebay ?? field.shopify)}</Text>
    {field.ebay !== null && field.shopify !== null && field.ebay !== field.shopify && (
      <Text as="p" variant="bodySm" tone="subdued">Shopify: {formatCompareValue(field.shopify)}</Text>
    )}
    <Text as="p" variant="bodySm" tone="subdued">
      Synced from Shopify automatically
    </Text>
  </BlockStack>
);

/**
 * Item specifics as plain Name / Value rows — operators should never
 * hand-author canonical JSON. Aspects with multiple values (rare) fall back
 * to a raw JSON textarea so nothing becomes uneditable.
 */
const SpecificsRows: React.FC<{
  label: string;
  changed: boolean;
  raw: string | null;
  editable: boolean;
  error?: string;
  onChange: (canonicalJson: string) => void;
}> = ({ label, changed, raw, editable, error, onChange }) => {
  const parsed = useMemo(() => {
    if (raw === null || raw.trim() === '') return { rows: [] as Array<{ name: string; value: string }>, multi: false };
    try {
      const object = JSON.parse(raw) as Record<string, unknown>;
      const rows: Array<{ name: string; value: string }> = [];
      let multi = false;
      for (const [name, value] of Object.entries(object)) {
        if (Array.isArray(value) && value.every((entry) => typeof entry === 'string')) {
          if (value.length > 1) multi = true;
          rows.push({ name, value: value.join(', ') });
        } else {
          multi = true;
        }
      }
      return { rows, multi };
    } catch {
      return { rows: [], multi: true };
    }
  }, [raw]);
  const [rows, setRows] = useState(parsed.rows);
  const emit = (next: Array<{ name: string; value: string }>) => {
    setRows(next);
    const object: Record<string, string[]> = {};
    for (const row of next) {
      if (row.name.trim()) object[row.name.trim()] = [row.value.trim()];
    }
    onChange(JSON.stringify(object));
  };
  if (parsed.multi) {
    // Preserve full fidelity for multi-value aspects.
    return (
      <TextField
        label={label}
        value={raw ?? ''}
        onChange={onChange}
        multiline={3}
        disabled={!editable}
        error={error}
        autoComplete="off"
        helpText="This listing uses multi-value specifics; edit the JSON directly."
      />
    );
  }
  return (
    <BlockStack gap="200">
      <InlineStack align="space-between" blockAlign="center">
        <InlineStack gap="200" blockAlign="center">
          <Text as="span" fontWeight="medium">{label}</Text>
          {changed && <Badge tone="attention">Changed</Badge>}
        </InlineStack>
        <Button
          variant="plain"
          disabled={!editable || rows.length >= 50}
          onClick={() => emit([...rows, { name: '', value: '' }])}
        >
          Add row
        </Button>
      </InlineStack>
      {error && <Text as="p" variant="bodySm" tone="critical">{error}</Text>}
      {rows.length === 0 && (
        <Text as="p" tone="subdued">
          Add details buyers filter by — Brand, Model, Type, Mount…
        </Text>
      )}
      {rows.map((row, index) => (
        <InlineStack key={String(index)} gap="200" blockAlign="center" wrap={false}>
          <div style={{ flex: 1 }}>
            <TextField
              label="Name"
              labelHidden
              placeholder="Name (e.g. Brand)"
              value={row.name}
              disabled={!editable}
              onChange={(value) => emit(rows.map((entry, entryIndex) =>
                entryIndex === index ? { ...entry, name: value } : entry))}
              autoComplete="off"
            />
          </div>
          <div style={{ flex: 2 }}>
            <TextField
              label="Value"
              labelHidden
              placeholder="Value (e.g. Canon)"
              value={row.value}
              disabled={!editable}
              onChange={(value) => emit(rows.map((entry, entryIndex) =>
                entryIndex === index ? { ...entry, value } : entry))}
              autoComplete="off"
            />
          </div>
          <Button
            variant="plain"
            tone="critical"
            disabled={!editable}
            onClick={() => emit(rows.filter((_, entryIndex) => entryIndex !== index))}
            accessibilityLabel={`Remove specific ${index + 1}`}
          >
            Remove
          </Button>
        </InlineStack>
      ))}
    </BlockStack>
  );
};

const ListingDraftEditor: React.FC<Props> = ({
  draft, saving, onCancel, onSave, statusCard, onDraftStateChange,
}) => {
  const [newImageUrl, setNewImageUrl] = useState('');
  const [editBase] = useState(draft);
  const initial = useMemo(() => initialValues(editBase), [editBase]);
  const [values, setValues] = useState<EditableValues>(initial);
  const inheritedImages = useMemo(() => parseDraftImages(
    editBase.sections.content.images.ebay ?? editBase.sections.content.images.shopify,
  ), [editBase]);
  const initialImages = useMemo(() => parseDraftImages(initial.images), [initial.images]);
  const [images, setImages] = useState<string[]>(() =>
    effectiveDraftImages(editBase.sections.content.images));
  const [imagesDirty, setImagesDirty] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [saveError, setSaveError] = useState(false);

  const metadataQuery = useListingEditorMetadata();
  const metadata = metadataQuery.data ?? emptyListingEditorMetadata();

  const setValue = (key: keyof EditableValues, value: string | null) => {
    setSaveError(false);
    setValues((current) => ({ ...current, [key]: value }));
  };
  const set = (key: keyof EditableValues, value: string) => setValue(key, nullIfBlank(value));

  const titleField = editBase.sections.listing.title;
  const categoryField = editBase.sections.listing.category;
  const conditionField = editBase.sections.listing.condition;
  const conditionDescriptionField = editBase.sections.listing.conditionDescription;
  const descriptionField = editBase.sections.content.description;
  const itemSpecificsField = editBase.sections.content.itemSpecifics;

  // The eBay-provided current description is untrusted HTML: it is sanitized
  // here, before it can ever enter the contentEditable surface.
  const currentDescriptionHtml = useMemo(
    () => sanitizeListingHtml(inheritedFieldValue(descriptionField)),
    [descriptionField],
  );
  const [descriptionHtml, setDescriptionHtml] = useState<string>(() =>
    initial.description === null
      ? currentDescriptionHtml
      : sanitizeListingHtml(initial.description));
  const changeDescription = (html: string) => {
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

  const fields: Array<[keyof EditableValues, string, ListingDraftField]> = [
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
  const changedFor = (key: keyof EditableValues, field: ListingDraftField): boolean =>
    isSemanticScalarChange(field, initial[key], values[key]);
  const changes: Change[] = fields.flatMap(([key, label, field]) => {
    if (!isSemanticScalarChange(field, initial[key], values[key])) return [];
    return [{
      label,
      before: descriptionSummary((initial[key] ?? inheritedFieldValue(field)) || 'Not set', 160),
      after: key === 'conditionDescription' && values[key] === ''
        ? 'Omit optional field'
        : descriptionSummary(values[key] ?? 'Use current value', 160),
    }];
  });
  const imagesChanged = isSemanticImageChange(
    editBase.sections.content.images,
    imagesDirty,
    serializedImages,
  );
  if (imagesChanged) {
    changes.push({
      label: 'Images',
      before: `${(initial.images === null ? inheritedImages : initialImages).length} images`,
      after: serializedImages === null ? 'Use current images' : `${normalizedImages.length} images`,
    });
  }
  const hasChanges = changes.length > 0;
  useEffect(() => {
    onDraftStateChange?.({ dirty: hasChanges, descriptionHtml });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasChanges, descriptionHtml]);
  const normalizedValues = fields.reduce<EditableValues>((result, [key, , field]) => ({
    ...result,
    [key]: isSemanticScalarChange(field, initial[key], values[key]) ? values[key] : initial[key],
  }), { ...values });
  const normalizedImagesForSave = imagesChanged ? serializedImages : initial.images;
  const saveInput = buildListingDraftSaveInput(
    editBase,
    normalizedValues,
    normalizedImagesForSave,
  );
  const draftInputValid = isListingDraftSaveInput(saveInput);

  const submit = async () => {
    setSaveError(false);
    try {
      await onSave(saveInput);
    } catch {
      setSaveError(true);
    }
  };

  const titleError = values.title !== null && (
    values.title.trim() !== values.title
    || values.title.length === 0
    || values.title.length > TITLE_MAX_LENGTH
  ) ? `Use 1–${TITLE_MAX_LENGTH} characters with no leading or trailing spaces` : undefined;
  const categoryError = values.category !== null && !POSITIVE_ID_PATTERN.test(values.category)
    ? 'Use a positive eBay category ID' : undefined;
  const conditionError = values.condition !== null && !POSITIVE_ID_PATTERN.test(values.condition)
    ? 'Use a positive eBay condition ID' : undefined;
  const descriptionError = values.description !== null && (
    values.description.trim().length === 0
    || values.description.trim() !== values.description
    || values.description.length > LISTING_DESCRIPTION_MAX_LENGTH
    || !isAllowlistedListingHtml(values.description)
  ) ? `Use simple formatting only, up to ${LISTING_DESCRIPTION_MAX_LENGTH.toLocaleString()} HTML characters`
    : undefined;

  const conditionCurrentSummary = conditionField.ebay
    ? `eBay: ${conditionDisplayLabel(conditionField.ebay, metadata.conditions)}`
    : conditionField.shopify
      ? `Shopify: ${conditionDisplayLabel(conditionField.shopify, metadata.conditions)}`
      : 'No current value';
  const conditionNote = 'Condition is saved to the draft but is not yet dispatchable to eBay.';

  const idField = (
    key: 'fulfillmentPolicyId' | 'paymentPolicyId' | 'returnPolicyId' | 'merchantLocation',
    labelText: string,
    field: ListingDraftField,
    options: ListingEditorIdUsage[],
    idNoun: string,
    pattern: RegExp,
    errorText: string,
  ) => {
    const value = values[key];
    const error = value !== null && !pattern.test(value) ? errorText : undefined;
    const label = <FieldLabel text={labelText} changed={changedFor(key, field)} />;
    return options.length > 0 ? (
      <IdUsageSelect
        label={label}
        value={value}
        options={options}
        currentValue={field.ebay ?? field.shopify}
        idNoun={idNoun}
        disabled={!field.editable}
        error={error}
        onChange={(next) => setValue(key, next)}
      />
    ) : (
      <DraftTextField
        label={label}
        field={field}
        value={draftFieldValue({ ...field, draft: value })}
        error={error}
        onChange={(next) => set(key, next)}
      />
    );
  };

  return (
    <BlockStack gap="400">
      {statusCard}
      <BlockStack gap="400">

        {saveError && (
          <Banner tone="critical">
            <Text as="p">Draft was not saved. Reload this listing and try again.</Text>
          </Banner>
        )}
        {hasChanges && !draftInputValid && (
          <Banner tone="critical">
            <Text as="p">Review the highlighted draft fields.</Text>
          </Banner>
        )}
        {metadataQuery.isError && (
          <Banner tone="info">
            <Text as="p">
              Editor suggestions are unavailable right now — fields accept manual entry.
            </Text>
          </Banner>
        )}

        <Card>
        <BlockStack gap="400">
          <Text as="h3" variant="headingMd">Listing</Text>
          <DraftTextField
            label={<FieldLabel text="Title" changed={changedFor('title', titleField)} />}
            field={titleField}
            value={draftFieldValue({ ...titleField, draft: values.title })}
            error={titleError}
            showCharacterCount
            extraHelp={`eBay titles allow up to ${TITLE_MAX_LENGTH} characters.`}
            onChange={(value) => set('title', value)}
          />
          <InlineGrid columns={{ xs: 1, md: 2 }} gap="400">
            {/* CategoryPicker searches the full eBay tree even without
                used-category metadata, and degrades to plain text entry
                itself when metadata is empty and live search fails. */}
            <CategoryPicker
              label={<FieldLabel text="Category" changed={changedFor('category', categoryField)} />}
              value={values.category}
              categories={metadata.categories}
              currentSummary={currentLabel(categoryField)}
              disabled={!categoryField.editable}
              error={categoryError}
              onChange={(next) => setValue('category', next)}
            />
            {metadata.conditions.length > 0 ? (
              <ConditionSelect
                label={<FieldLabel text="Condition" changed={changedFor('condition', conditionField)} />}
                value={values.condition}
                conditions={metadata.conditions}
                currentSummary={conditionCurrentSummary}
                disabled={!conditionField.editable}
                error={conditionError}
                onChange={(next) => setValue('condition', next)}
              />
            ) : (
              <DraftTextField
                label={<FieldLabel text="Condition" changed={changedFor('condition', conditionField)} />}
                field={conditionField}
                value={draftFieldValue({ ...conditionField, draft: values.condition })}
                error={conditionError}
                extraHelp={conditionNote}
                onChange={(value) => set('condition', value)}
              />
            )}
          </InlineGrid>
          <DraftTextField
            label={(
              <InlineStack align="space-between" blockAlign="center" gap="200" wrap>
                <FieldLabel
                  text="Condition description"
                  changed={changedFor('conditionDescription', conditionDescriptionField)}
                />
                <InlineStack gap="200">
                  <Button
                    variant="plain"
                    onClick={() => setValue('conditionDescription', '')}
                    disabled={!conditionDescriptionField.editable
                      || values.conditionDescription === ''}
                  >
                    Omit optional field
                  </Button>
                  <Button
                    variant="plain"
                    onClick={() => setValue('conditionDescription', null)}
                    disabled={!conditionDescriptionField.editable
                      || values.conditionDescription === null}
                  >
                    Use current value
                  </Button>
                </InlineStack>
              </InlineStack>
            )}
            field={conditionDescriptionField}
            value={draftFieldValue({
              ...conditionDescriptionField,
              draft: values.conditionDescription,
            })}
            error={values.conditionDescription !== null
              && values.conditionDescription !== '' && (
              values.conditionDescription.trim() !== values.conditionDescription
              || values.conditionDescription.length > 1_000
            ) ? 'Use 1–1,000 characters with no leading or trailing spaces' : undefined}
            multiline={2}
            extraHelp="Optional. Use only to clarify physical condition; omit unrelated text."
            onChange={(value) => setValue('conditionDescription', value)}
          />
          <InlineGrid columns={{ xs: 1, sm: 2 }} gap="400">
            <ReadOnlyCompare label="Price" field={editBase.sections.listing.price} />
            <ReadOnlyCompare label="Quantity" field={editBase.sections.listing.quantity} />
          </InlineGrid>
        </BlockStack>
        </Card>

        <Card>
        <BlockStack gap="400">
          <Text as="h3" variant="headingMd">Description &amp; photos</Text>
          <RichTextEditor
            label={(
              <InlineStack align="space-between" blockAlign="center" gap="200" wrap>
                <FieldLabel
                  text="Description"
                  changed={changedFor('description', descriptionField)}
                />
                <Button
                  variant="plain"
                  onClick={resetDescription}
                  disabled={!descriptionField.editable}
                >
                  Use current value
                </Button>
              </InlineStack>
            )}
            value={descriptionHtml}
            disabled={!descriptionField.editable}
            error={descriptionError}
            helpText={currentLabel(descriptionField)}
            maxLength={LISTING_DESCRIPTION_MAX_LENGTH}
            onChange={changeDescription}
          />
          <BlockStack gap="300">
            <InlineStack align="space-between" blockAlign="center">
              <InlineStack gap="200" blockAlign="center">
                <Text as="h4" variant="headingSm">Photos</Text>
                {imagesChanged && <Badge tone="attention">Changed</Badge>}
              </InlineStack>
              <Text as="span" variant="bodySm" tone="subdued">
                {images.filter((image) => image.trim() !== '').length} of 24
              </Text>
            </InlineStack>
            {images.length === 0 ? (
              <Text as="p" tone="subdued">Using the current photos.</Text>
            ) : (
              <InlineStack gap="300" wrap>
                {images.map((image, index) => {
                  const verified = verifiedDraftImageUrl(image);
                  return (
                    <BlockStack key={String(index)} gap="100" inlineAlign="center">
                      <Thumbnail
                        size="large"
                        source={verified ?? ''}
                        alt={verified ? `Photo ${index + 1}` : 'Invalid image URL'}
                      />
                      {image.trim() !== '' && !verified && (
                        <Text as="span" variant="bodySm" tone="critical">Invalid URL</Text>
                      )}
                      <Button
                        variant="plain"
                        tone="critical"
                        disabled={!editBase.sections.content.images.editable}
                        onClick={() => {
                          setImagesDirty(true);
                          setImages((current) =>
                            current.filter((_, itemIndex) => itemIndex !== index));
                        }}
                        accessibilityLabel={`Remove photo ${index + 1}`}
                      >
                        Remove
                      </Button>
                    </BlockStack>
                  );
                })}
              </InlineStack>
            )}
            {editBase.sections.content.images.editable && images.length < 24 && (
              <InlineStack gap="200" blockAlign="end" wrap={false}>
                <div style={{ flex: 1 }}>
                  <TextField
                    label="Add photo by URL"
                    labelHidden
                    placeholder="Paste a Shopify or eBay image URL"
                    value={newImageUrl}
                    onChange={setNewImageUrl}
                    autoComplete="off"
                    error={newImageUrl.trim() !== '' && !verifiedDraftImageUrl(newImageUrl.trim())
                      ? 'Use a Shopify or eBay image URL' : undefined}
                  />
                </div>
                <Button
                  onClick={() => {
                    if (!newImageUrl.trim()) return;
                    setImagesDirty(true);
                    setImages((current) => [...current, newImageUrl.trim()]);
                    setNewImageUrl('');
                  }}
                  disabled={!newImageUrl.trim() || !verifiedDraftImageUrl(newImageUrl.trim())}
                >
                  Add
                </Button>
              </InlineStack>
            )}
          </BlockStack>
          <SpecificsRows
            label="Item specifics"
            changed={changedFor('itemSpecifics', itemSpecificsField)}
            raw={values.itemSpecifics ?? itemSpecificsField.ebay ?? itemSpecificsField.shopify}
            editable={itemSpecificsField.editable}
            error={values.itemSpecifics !== null
              && canonicalDraftItemSpecifics(values.itemSpecifics) !== values.itemSpecifics
              ? 'Item specifics could not be read — fix the highlighted rows'
              : undefined}
            onChange={(next) => setValue('itemSpecifics', next)}
          />
        </BlockStack>
        </Card>

        <Card>
        <BlockStack gap="400">
          <Text as="h3" variant="headingMd">Delivery</Text>
          <InlineGrid columns={{ xs: 1, md: 2 }} gap="400">
            {idField(
              'fulfillmentPolicyId',
              'Fulfillment policy',
              editBase.sections.delivery.fulfillmentPolicyId,
              metadata.policies.fulfillment,
              'policy ID',
              POSITIVE_ID_PATTERN,
              'Use a positive policy ID',
            )}
            {idField(
              'paymentPolicyId',
              'Payment policy',
              editBase.sections.delivery.paymentPolicyId,
              metadata.policies.payment,
              'policy ID',
              POSITIVE_ID_PATTERN,
              'Use a positive policy ID',
            )}
            {idField(
              'returnPolicyId',
              'Return policy',
              editBase.sections.delivery.returnPolicyId,
              metadata.policies.return,
              'policy ID',
              POSITIVE_ID_PATTERN,
              'Use a positive policy ID',
            )}
            {idField(
              'merchantLocation',
              'Merchant location',
              editBase.sections.delivery.merchantLocation,
              metadata.merchantLocations,
              'location key',
              MERCHANT_KEY_PATTERN,
              'Use a valid merchant location key',
            )}
          </InlineGrid>
        </BlockStack>
        </Card>

        <InlineStack align="end" gap="300">
          <Button onClick={onCancel} disabled={saving}>Close</Button>
        </InlineStack>

        <Modal
          open={previewOpen}
          onClose={() => setPreviewOpen(false)}
          title="Draft changes"
          primaryAction={{ content: 'Close', onAction: () => setPreviewOpen(false) }}
        >
          <Modal.Section>
            <BlockStack gap="300">
              <Banner tone="info"><Text as="p">Preview only. Nothing will be applied.</Text></Banner>
              {changes.map((change) => (
                <Box
                  key={change.label}
                  background="bg-surface-secondary"
                  borderRadius="200"
                  padding="300"
                >
                  <BlockStack gap="150">
                    <InlineStack gap="200" blockAlign="center">
                      <Text as="h3" variant="headingSm">{change.label}</Text>
                      <Badge tone="attention">Changed</Badge>
                    </InlineStack>
                    <InlineGrid columns={{ xs: 1, sm: 2 }} gap="200">
                      <BlockStack gap="050">
                        <Text as="p" variant="bodySm" tone="subdued">Before</Text>
                        <Text as="p" tone="subdued" textDecorationLine="line-through">
                          {change.before}
                        </Text>
                      </BlockStack>
                      <BlockStack gap="050">
                        <Text as="p" variant="bodySm" tone="subdued">After</Text>
                        <Text as="p" fontWeight="medium">{change.after}</Text>
                      </BlockStack>
                    </InlineGrid>
                  </BlockStack>
                </Box>
              ))}
            </BlockStack>
          </Modal.Section>
        </Modal>
      </BlockStack>
    </BlockStack>
  );
};

export default ListingDraftEditor;
