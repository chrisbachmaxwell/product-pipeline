import React, { useMemo, useState } from 'react';
import {
  Banner,
  BlockStack,
  Button,
  Card,
  Divider,
  InlineGrid,
  InlineStack,
  Modal,
  Text,
  TextField,
} from '@shopify/polaris';
import {
  canonicalDraftImages,
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
import { descriptionSummary } from '../operator-ui';

type EditableValues = ListingDraftSaveInput['draft'];

interface Props {
  draft: ListingDraftResponse;
  saving: boolean;
  onCancel: () => void;
  onSave: (input: ListingDraftSaveInput) => Promise<unknown>;
}

interface Change {
  label: string;
  before: string;
  after: string;
}

const nullIfBlank = (value: string): string | null => value.trim() ? value : null;

const currentLabel = (field: ListingDraftField): string => {
  const ebay = field.ebay ? descriptionSummary(field.ebay, 160) : '';
  const shopify = field.shopify ? descriptionSummary(field.shopify, 160) : '';
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

const DraftTextField: React.FC<{
  label: string;
  field: ListingDraftField;
  value: string;
  multiline?: number;
  error?: string;
  onChange: (value: string) => void;
}> = ({ label, field, value, multiline, error, onChange }) => (
  <TextField
    label={label}
    value={value}
    onChange={onChange}
    disabled={!field.editable}
    placeholder={descriptionSummary(inheritedFieldValue(field), 160) || 'Use current value'}
    helpText={currentLabel(field)}
    autoComplete="off"
    multiline={multiline}
    error={error}
  />
);

const ReadOnlyCompare: React.FC<{ label: string; field: ListingDraftField }> = ({ label, field }) => (
  <BlockStack gap="100">
    <Text as="p" variant="bodySm" tone="subdued">{label}</Text>
    <Text as="p" fontWeight="medium">{field.ebay ?? field.shopify ?? '—'}</Text>
    {field.ebay !== null && field.shopify !== null && field.ebay !== field.shopify && (
      <Text as="p" variant="bodySm" tone="subdued">Shopify: {field.shopify}</Text>
    )}
  </BlockStack>
);

const ListingDraftEditor: React.FC<Props> = ({ draft, saving, onCancel, onSave }) => {
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

  const set = (key: keyof EditableValues, value: string) => {
    setSaveError(false);
    setValues((current) => ({ ...current, [key]: nullIfBlank(value) }));
  };

  const normalizedImages = images.map((value) => value.trim()).filter(Boolean);
  const invalidImage = normalizedImages.some((value) => !verifiedDraftImageUrl(value));
  const effectiveImageList = normalizedImages.map((value) => verifiedDraftImageUrl(value) ?? value);
  const serializedImages = imagesDirty
    ? effectiveImageList.length > 0 ? canonicalDraftImages(effectiveImageList) : null
    : initial.images;

  const fields: Array<[keyof EditableValues, string, ListingDraftField]> = [
    ['title', 'Title', editBase.sections.listing.title],
    ['category', 'Category', editBase.sections.listing.category],
    ['condition', 'Condition', editBase.sections.listing.condition],
    ['conditionDescription', 'Condition description', editBase.sections.listing.conditionDescription],
    ['description', 'Description', editBase.sections.content.description],
    ['fulfillmentPolicyId', 'Fulfillment policy', editBase.sections.delivery.fulfillmentPolicyId],
    ['paymentPolicyId', 'Payment policy', editBase.sections.delivery.paymentPolicyId],
    ['returnPolicyId', 'Return policy', editBase.sections.delivery.returnPolicyId],
    ['merchantLocation', 'Merchant location', editBase.sections.delivery.merchantLocation],
  ];
  const changes: Change[] = fields.flatMap(([key, label, field]) => {
    if (!isSemanticScalarChange(field, initial[key], values[key])) return [];
    return [{
      label,
      before: descriptionSummary((initial[key] ?? inheritedFieldValue(field)) || 'Not set', 160),
      after: descriptionSummary(values[key] ?? 'Use current value', 160),
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

  return (
    <Card>
      <BlockStack gap="500">
        <InlineStack align="space-between" blockAlign="center" gap="300">
          <BlockStack gap="050">
            <Text as="h2" variant="headingMd">Local draft</Text>
            <Text as="p" variant="bodySm" tone="subdued">Nothing is sent to Shopify or eBay.</Text>
          </BlockStack>
          <Button onClick={onCancel} disabled={saving}>Close</Button>
        </InlineStack>

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

        <BlockStack gap="400">
          <Text as="h3" variant="headingSm">Listing</Text>
          <InlineGrid columns={{ xs: 1, md: 2 }} gap="400">
            <DraftTextField
              label="Title"
              field={editBase.sections.listing.title}
              value={draftFieldValue({ ...editBase.sections.listing.title, draft: values.title })}
              error={values.title !== null && (
                values.title.trim() !== values.title || values.title.length === 0 || values.title.length > 80
              ) ? 'Use 1–80 characters with no leading or trailing spaces' : undefined}
              onChange={(value) => set('title', value)}
            />
            <DraftTextField
              label="Category"
              field={editBase.sections.listing.category}
              value={draftFieldValue({ ...editBase.sections.listing.category, draft: values.category })}
              error={values.category !== null && !/^[1-9]\d{0,31}$/u.test(values.category)
                ? 'Use a positive eBay category ID' : undefined}
              onChange={(value) => set('category', value)}
            />
            <DraftTextField
              label="Condition"
              field={editBase.sections.listing.condition}
              value={draftFieldValue({ ...editBase.sections.listing.condition, draft: values.condition })}
              error={values.condition !== null && !/^[1-9]\d{0,31}$/u.test(values.condition)
                ? 'Use a positive eBay condition ID' : undefined}
              onChange={(value) => set('condition', value)}
            />
            <DraftTextField
              label="Condition description"
              field={editBase.sections.listing.conditionDescription}
              value={draftFieldValue({ ...editBase.sections.listing.conditionDescription, draft: values.conditionDescription })}
              error={values.conditionDescription !== null && (
                values.conditionDescription.trim().length === 0
                || values.conditionDescription.trim() !== values.conditionDescription
                || values.conditionDescription.length > 1_000
              ) ? 'Use 1–1,000 characters with no leading or trailing spaces' : undefined}
              onChange={(value) => set('conditionDescription', value)}
            />
          </InlineGrid>
          <InlineGrid columns={{ xs: 1, sm: 2 }} gap="400">
            <ReadOnlyCompare label="Price · Marketplace Connect" field={editBase.sections.listing.price} />
            <ReadOnlyCompare label="Quantity · Marketplace Connect" field={editBase.sections.listing.quantity} />
          </InlineGrid>
        </BlockStack>

        <Divider />

        <BlockStack gap="400">
          <Text as="h3" variant="headingSm">Content</Text>
          <DraftTextField
            label="Description"
            field={editBase.sections.content.description}
            value={draftFieldValue({ ...editBase.sections.content.description, draft: values.description })}
            error={values.description !== null && (
              values.description.trim().length === 0
              || values.description.trim() !== values.description
              || values.description.length > 20_000
              || /<\/?[a-z][^>]*>/iu.test(values.description)
            ) ? 'Use plain text with no leading or trailing spaces, up to 20,000 characters' : undefined}
            onChange={(value) => set('description', value)}
            multiline={6}
          />
          <BlockStack gap="300">
            <InlineStack align="space-between" blockAlign="center">
              <Text as="h4" variant="headingSm">Images</Text>
              <Button
                variant="plain"
                onClick={() => { setImagesDirty(true); setImages((current) => [...current, '']); }}
                disabled={!editBase.sections.content.images.editable || images.length >= 24}
              >
                Add image
              </Button>
            </InlineStack>
            {images.length === 0 ? (
              <Text as="p" tone="subdued">Using current images.</Text>
            ) : images.map((image, index) => (
              <InlineStack key={String(index)} gap="200" blockAlign="end" wrap={false}>
                <div style={{ flex: 1 }}>
                  <TextField
                    label={`Image ${index + 1}`}
                    value={image}
                    onChange={(value) => {
                      setImagesDirty(true);
                      setImages((current) => current.map((item, itemIndex) =>
                        itemIndex === index ? value : item));
                    }}
                    autoComplete="off"
                    error={image.trim() && !verifiedDraftImageUrl(image)
                      ? 'Use an approved Shopify or eBay image URL' : undefined}
                  />
                </div>
                <Button
                  onClick={() => {
                    setImagesDirty(true);
                    setImages((current) => current.filter((_, itemIndex) => itemIndex !== index));
                  }}
                  accessibilityLabel={`Remove image ${index + 1}`}
                >
                  Remove
                </Button>
              </InlineStack>
            ))}
          </BlockStack>
        </BlockStack>

        <Divider />

        <BlockStack gap="400">
          <Text as="h3" variant="headingSm">Delivery</Text>
          <InlineGrid columns={{ xs: 1, md: 2 }} gap="400">
            <DraftTextField
              label="Fulfillment policy"
              field={editBase.sections.delivery.fulfillmentPolicyId}
              value={draftFieldValue({ ...editBase.sections.delivery.fulfillmentPolicyId, draft: values.fulfillmentPolicyId })}
              error={values.fulfillmentPolicyId !== null
                && !/^[1-9]\d{0,31}$/u.test(values.fulfillmentPolicyId)
                ? 'Use a positive policy ID' : undefined}
              onChange={(value) => set('fulfillmentPolicyId', value)}
            />
            <DraftTextField
              label="Payment policy"
              field={editBase.sections.delivery.paymentPolicyId}
              value={draftFieldValue({ ...editBase.sections.delivery.paymentPolicyId, draft: values.paymentPolicyId })}
              error={values.paymentPolicyId !== null
                && !/^[1-9]\d{0,31}$/u.test(values.paymentPolicyId)
                ? 'Use a positive policy ID' : undefined}
              onChange={(value) => set('paymentPolicyId', value)}
            />
            <DraftTextField
              label="Return policy"
              field={editBase.sections.delivery.returnPolicyId}
              value={draftFieldValue({ ...editBase.sections.delivery.returnPolicyId, draft: values.returnPolicyId })}
              error={values.returnPolicyId !== null
                && !/^[1-9]\d{0,31}$/u.test(values.returnPolicyId)
                ? 'Use a positive policy ID' : undefined}
              onChange={(value) => set('returnPolicyId', value)}
            />
            <DraftTextField
              label="Merchant location"
              field={editBase.sections.delivery.merchantLocation}
              value={draftFieldValue({ ...editBase.sections.delivery.merchantLocation, draft: values.merchantLocation })}
              error={values.merchantLocation !== null
                && !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(values.merchantLocation)
                ? 'Use a valid merchant location key' : undefined}
              onChange={(value) => set('merchantLocation', value)}
            />
          </InlineGrid>
        </BlockStack>

        <InlineStack align="end" gap="300">
          <Button onClick={() => setPreviewOpen(true)}
            disabled={!hasChanges || invalidImage || !draftInputValid || saving}>
            Preview changes
          </Button>
          <Button variant="primary" onClick={() => { void submit(); }} loading={saving}
            disabled={!hasChanges || invalidImage || !draftInputValid}>
            Save draft
          </Button>
        </InlineStack>

        <Modal
          open={previewOpen}
          onClose={() => setPreviewOpen(false)}
          title="Draft changes"
          primaryAction={{ content: 'Close', onAction: () => setPreviewOpen(false) }}
        >
          <Modal.Section>
            <BlockStack gap="400">
              <Banner tone="info"><Text as="p">Preview only. Nothing will be applied.</Text></Banner>
              {changes.map((change) => (
                <BlockStack key={change.label} gap="100">
                  <Text as="h3" variant="headingSm">{change.label}</Text>
                  <Text as="p" tone="subdued">Current: {change.before}</Text>
                  <Text as="p">Draft: {change.after}</Text>
                </BlockStack>
              ))}
            </BlockStack>
          </Modal.Section>
        </Modal>
      </BlockStack>
    </Card>
  );
};

export default ListingDraftEditor;
