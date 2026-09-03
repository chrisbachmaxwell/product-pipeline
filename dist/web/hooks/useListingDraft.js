import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { isAllowlistedListingHtml } from '../listing-html';
import { apiClient } from './useApi';
const positiveDecimalId = (value) => /^[1-9]\d{0,31}$/u.test(value);
const safeMerchantKey = (value) => /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value);
// Plain text, or HTML restricted to the strict attribute-free allowlist
// (see src/web/listing-html.ts). The field stays a single string.
const safeDescription = (value) => value.length <= 20_000
    && value.trim().length > 0
    && value.trim() === value
    && isAllowlistedListingHtml(value)
    && !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(value);
export const isListingDraftSaveInput = (value) => {
    if (!record(value) || value.schemaVersion !== 1 || value.action !== 'save_local_draft'
        || typeof value.catalogId !== 'string'
        || !(value.expectedRevisionDigest === null || digest(value.expectedRevisionDigest))
        || !record(value.base) || !digest(value.base.sourceDigest) || !digest(value.base.ebayDigest)
        || Object.keys(value.base).length !== 2 || !record(value.draft)
        || Object.keys(value.draft).sort().join(',') !== [
            'category', 'condition', 'conditionDescription', 'description',
            'fulfillmentPolicyId', 'images', 'itemSpecifics', 'merchantLocation', 'paymentPolicyId',
            'returnPolicyId', 'title',
        ].sort().join(','))
        return false;
    const title = value.draft.title;
    const description = value.draft.description;
    if (!stringOrNull(title) || !stringOrNull(value.draft.category)
        || !stringOrNull(value.draft.condition) || !stringOrNull(value.draft.conditionDescription)
        || !stringOrNull(description) || !stringOrNull(value.draft.images)
        || !stringOrNull(value.draft.itemSpecifics)
        || !stringOrNull(value.draft.fulfillmentPolicyId)
        || !stringOrNull(value.draft.paymentPolicyId)
        || !stringOrNull(value.draft.returnPolicyId)
        || !stringOrNull(value.draft.merchantLocation))
        return false;
    if (title !== null && (title.trim() !== title || title.length === 0 || title.length > 80))
        return false;
    if (description !== null && !safeDescription(description))
        return false;
    for (const id of [value.draft.category, value.draft.condition,
        value.draft.fulfillmentPolicyId, value.draft.paymentPolicyId,
        value.draft.returnPolicyId]) {
        if (id !== null && !positiveDecimalId(id))
            return false;
    }
    if (value.draft.conditionDescription !== null
        && value.draft.conditionDescription !== ''
        && (value.draft.conditionDescription.trim() !== value.draft.conditionDescription
            || value.draft.conditionDescription.length > 1_000))
        return false;
    if (value.draft.merchantLocation !== null && !safeMerchantKey(value.draft.merchantLocation)) {
        return false;
    }
    if (value.draft.images !== null) {
        const images = parseDraftImages(value.draft.images);
        if (images.length === 0 || canonicalDraftImages(images) !== value.draft.images)
            return false;
    }
    if (value.draft.itemSpecifics !== null
        && canonicalDraftItemSpecifics(value.draft.itemSpecifics) !== value.draft.itemSpecifics) {
        return false;
    }
    return true;
};
export const canonicalDraftItemSpecifics = (serialized) => {
    let parsed;
    try {
        parsed = JSON.parse(serialized);
    }
    catch {
        return null;
    }
    if (!record(parsed))
        return null;
    const names = Object.keys(parsed);
    if (names.length === 0 || names.length > 50)
        return null;
    const canonicalNames = new Set();
    const result = {};
    for (const name of names.sort()) {
        const values = parsed[name];
        const foldedName = name.toLocaleLowerCase('en-US');
        if (name.length === 0 || name.length > 65 || name.trim() !== name
            || canonicalNames.has(foldedName) || !Array.isArray(values)
            || values.length === 0 || values.length > 30)
            return null;
        canonicalNames.add(foldedName);
        const seenValues = new Set();
        const checked = [];
        for (const entry of values) {
            if (typeof entry !== 'string' || entry.length === 0 || entry.length > 65
                || entry.trim() !== entry || seenValues.has(entry))
                return null;
            seenValues.add(entry);
            checked.push(entry);
        }
        result[name] = checked;
    }
    return JSON.stringify(result);
};
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const stringOrNull = (value) => value === null || typeof value === 'string';
const digest = (value) => typeof value === 'string' && /^sha256:[0-9a-f]{64}$/u.test(value);
const timestamp = (value) => typeof value === 'string' && !Number.isNaN(Date.parse(value));
const field = (value) => record(value)
    && stringOrNull(value.shopify) && stringOrNull(value.ebay) && stringOrNull(value.draft)
    && typeof value.editable === 'boolean';
export const isListingDraftResponse = (value, expectedCatalogId) => {
    if (!record(value) || value.schemaVersion !== 1 || value.mode !== 'local_draft_only'
        || typeof value.catalogId !== 'string'
        || (expectedCatalogId !== undefined && value.catalogId !== expectedCatalogId)
        || !record(value.identity) || typeof value.identity.shopifyProductGid !== 'string'
        || typeof value.identity.shopifyVariantGid !== 'string'
        || typeof value.identity.rawSku !== 'string'
        || value.identity.ebaySellerId !== 'usedcameragear'
        || value.identity.ebayMarketplaceId !== 'EBAY_US'
        || !['inventory_api', 'trading_api', 'unmanaged', 'unknown']
            .includes(String(value.identity.managementModel))
        || !stringOrNull(value.identity.ebayInventorySku)
        || !stringOrNull(value.identity.ebayOfferId) || !stringOrNull(value.identity.ebayListingId)
        || !record(value.base) || !timestamp(value.base.catalogObservedAtUtc)
        || !(value.base.detailObservedAtUtc === null || timestamp(value.base.detailObservedAtUtc))
        || !digest(value.base.sourceDigest) || !digest(value.base.ebayDigest)
        || !record(value.sections) || !record(value.sections.listing)
        || !record(value.sections.content) || !record(value.sections.delivery)
        || !field(value.sections.listing.title) || !field(value.sections.listing.category)
        || !field(value.sections.listing.condition)
        || !field(value.sections.listing.conditionDescription)
        || !field(value.sections.listing.price) || !field(value.sections.listing.quantity)
        || !field(value.sections.content.description) || !field(value.sections.content.images)
        || !field(value.sections.content.itemSpecifics) || !field(value.sections.content.identifiers)
        || !field(value.sections.delivery.fulfillmentPolicyId)
        || !field(value.sections.delivery.paymentPolicyId)
        || !field(value.sections.delivery.returnPolicyId)
        || !field(value.sections.delivery.merchantLocation)
        || !record(value.capabilities) || typeof value.capabilities.saveDraft !== 'boolean'
        || typeof value.capabilities.previewChanges !== 'boolean'
        || value.capabilities.apply !== false || value.capabilities.publish !== false
        || value.externalWritesPerformed !== 0)
        return false;
    const revision = value.revision;
    if (revision !== null && (!record(revision) || typeof revision.revisionId !== 'string'
        || !Number.isSafeInteger(revision.revisionNumber) || Number(revision.revisionNumber) < 1
        || !digest(revision.revisionDigest) || revision.state !== 'draft'
        || !timestamp(revision.createdAtUtc)))
        return false;
    const price = value.sections.listing.price;
    const quantity = value.sections.listing.quantity;
    const itemSpecifics = value.sections.content.itemSpecifics;
    const identifiers = value.sections.content.identifiers;
    if (price.editable || quantity.editable || !itemSpecifics.editable || identifiers.editable)
        return false;
    const draftDescription = value.sections.content.description.draft;
    if (draftDescription !== null && (draftDescription.length > 20_000
        || !isAllowlistedListingHtml(draftDescription)
        || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(draftDescription)))
        return false;
    if (value.capabilities.saveDraft && (value.identity.rawSku.trim() === ''
        || value.identity.shopifyProductGid === ''
        || value.identity.shopifyVariantGid === ''))
        return false;
    return true;
};
export const canonicalDraftImages = (value) => JSON.stringify(value);
const DRAFT_IMAGE_HOSTS = new Set([
    'cdn.shopify.com',
    'i.ebayimg.com',
    'thumbs.ebaystatic.com',
    'secureir.ebaystatic.com',
    'i.ebaystatic.com',
]);
export const verifiedDraftImageUrl = (value) => {
    try {
        const url = new URL(value);
        const allowedQueryKeys = url.hostname.toLowerCase() === 'cdn.shopify.com'
            ? new Set(['v', 'width', 'height', 'crop', 'format'])
            : new Set();
        const queryKeys = [...url.searchParams.keys()];
        return url.protocol === 'https:'
            && url.username === ''
            && url.password === ''
            && url.hash === ''
            && DRAFT_IMAGE_HOSTS.has(url.hostname.toLowerCase())
            && new Set(queryKeys).size === queryKeys.length
            && queryKeys.every((key) => allowedQueryKeys.has(key))
            && [...url.searchParams.values()].every((queryValue) => queryValue.length > 0 && queryValue.length <= 64
                && /^[a-zA-Z0-9._-]+$/u.test(queryValue))
            ? url.toString()
            : null;
    }
    catch {
        return null;
    }
};
export const parseDraftImages = (value) => {
    if (!value)
        return [];
    try {
        const parsed = JSON.parse(value);
        if (!Array.isArray(parsed) || parsed.length > 24
            || !parsed.every((item) => typeof item === 'string'))
            return [];
        const safe = [];
        for (const item of parsed) {
            try {
                const url = new URL(item);
                const verified = verifiedDraftImageUrl(url.toString());
                if (!verified || safe.includes(verified))
                    continue;
                safe.push(verified);
            }
            catch {
                continue;
            }
        }
        return safe;
    }
    catch {
        return [];
    }
};
export const effectiveDraftImages = (fieldValue) => parseDraftImages(fieldValue.draft ?? fieldValue.ebay ?? fieldValue.shopify);
export const draftFieldValue = (value) => value.draft ?? '';
export const inheritedFieldValue = (value) => value.ebay ?? value.shopify ?? '';
export const isListingDraftBoundToWorkspace = (draft, workspace) => {
    const shopify = workspace.catalog.shopify;
    if (!shopify || draft.catalogId !== workspace.catalog.id || shopify.sku.trim() === '')
        return false;
    const expectedModel = workspace.mapping.managementModel === 'inventory_offer'
        ? 'inventory_api'
        : workspace.mapping.managementModel === 'legacy_trading'
            ? 'trading_api'
            : 'unmanaged';
    const expectedInventorySku = workspace.mapping.managementModel === 'inventory_offer'
        ? workspace.mapping.inventorySku
        : null;
    return draft.identity.shopifyProductGid === shopify.productId
        && draft.identity.shopifyVariantGid === shopify.variantId
        && draft.identity.rawSku === shopify.sku
        && draft.identity.ebayInventorySku === expectedInventorySku
        && draft.identity.ebayOfferId === workspace.mapping.offerId
        && draft.identity.ebayListingId === workspace.mapping.listingId
        && draft.identity.managementModel === expectedModel;
};
export const useListingDraft = (catalogId) => useQuery({
    queryKey: ['listing-draft-v1', catalogId],
    queryFn: () => apiClient.get(`/listing-draft?id=${encodeURIComponent(catalogId ?? '')}`),
    enabled: Boolean(catalogId),
    staleTime: 0,
    refetchOnWindowFocus: true,
});
export const useSaveListingDraft = (catalogId) => {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async (input) => {
            if (!isListingDraftSaveInput(input))
                throw new Error('Draft input is invalid');
            const response = await apiClient.post('/listing-draft', input);
            if (!isListingDraftResponse(response, input.catalogId)) {
                throw new Error('Saved draft response is unavailable');
            }
            return response;
        },
        onSuccess: (response) => {
            queryClient.setQueryData(['listing-draft-v1', catalogId], response);
            void queryClient.invalidateQueries({ queryKey: ['listing-draft-v1', catalogId] });
        },
    });
};
