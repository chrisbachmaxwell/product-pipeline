import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useEffect, useMemo, useState } from 'react';
import { BlockStack, Combobox, Listbox, Select, Text, TextField, } from '@shopify/polaris';
import { useEbayCategorySearch, } from '../hooks/useEbayCategorySearch';
import { useEbayCategoryBrowse } from '../hooks/useEbayCategoryBrowse';
/**
 * Listbox option values are a single string, so drill-down navigation is
 * encoded with sentinels that a real numeric category id can never collide
 * with.
 */
const BROWSE_INTO_PREFIX = '__browse-into__';
const BROWSE_TO_PREFIX = '__browse-to__';
const BROWSE_ROOT = '__browse-root__';
/**
 * Presentation-only pickers for the local draft editor. Each one edits a
 * single draft override value (string, or null for "keep current") and never
 * talks to any API — the parent owns state and the save contract.
 */
const helpStack = (lines) => (_jsx(BlockStack, { gap: "050", children: lines.map((line, index) => (_jsx(Text, { as: "span", variant: "bodySm", tone: "subdued", children: line }, String(index)))) }));
export const conditionDisplayLabel = (id, conditions) => {
    const match = conditions.find((condition) => condition.id === id);
    return match ? `${match.label} (${match.id})` : id;
};
export const ConditionSelect = ({ label, value, conditions, currentSummary, disabled, error, onChange, }) => {
    const options = useMemo(() => [
        { label: 'Keep current value', value: '' },
        ...(value !== null && !conditions.some((condition) => condition.id === value)
            ? [{ label: `Current value (${value})`, value }]
            : []),
        ...conditions.map((condition) => ({
            label: `${condition.label} (${condition.id})`,
            value: condition.id,
        })),
    ], [conditions, value]);
    return (_jsx(Select, { label: label, options: options, value: value ?? '', disabled: disabled, error: error, onChange: (next) => onChange(next === '' ? null : next), helpText: helpStack([
            currentSummary,
            'Condition is saved to the draft but is not yet dispatchable to eBay.',
        ]) }));
};
const categoryName = (category) => category.name === null ? `Category ${category.id}` : `${category.name} (${category.id})`;
const categoryOptionLabel = (category) => `${categoryName(category)} — used on ${category.usageCount} `
    + `listing${category.usageCount === 1 ? '' : 's'}`;
export const categoryDisplayLabel = (id, categories) => {
    const match = categories.find((category) => category.id === id);
    return match ? categoryName(match) : id;
};
const searchResultLabel = (result) => `${result.name} (${result.id})`;
export const CategoryPicker = ({ label, value, categories, currentSummary, disabled, error, onChange, }) => {
    // Display labels for live-search results the merchant picked; keeps the
    // committed value rendering as "Name (id)" even though the id is not in
    // the used-category metadata.
    const [pickedLabels, setPickedLabels] = useState({});
    const displayLabel = (id) => {
        const fromMetadata = categories.find((category) => category.id === id);
        if (fromMetadata)
            return categoryName(fromMetadata);
        return pickedLabels[id] ?? id;
    };
    const [text, setText] = useState(() => (value === null ? '' : displayLabel(value)));
    const trimmed = text.trim();
    const numeric = /^\d+$/u.test(trimmed);
    const committedLabel = value === null ? null : displayLabel(value);
    const searching = trimmed !== '' && !numeric && text !== committedLabel;
    // Once the live search has failed and there is no used-category metadata
    // either, the combobox has nothing to offer: degrade to plain text entry
    // for the rest of this mount (free numeric entry keeps working there).
    const [searchEverFailed, setSearchEverFailed] = useState(false);
    const degraded = categories.length === 0 && searchEverFailed;
    const search = useEbayCategorySearch(degraded || disabled || !searching ? '' : trimmed);
    useEffect(() => {
        if (search.isError)
            setSearchEverFailed(true);
    }, [search.isError]);
    const matches = useMemo(() => {
        if (trimmed === '')
            return categories;
        const query = trimmed.toLowerCase();
        return categories.filter((category) => category.id.includes(query)
            || (category.name ?? '').toLowerCase().includes(query)
            || categoryName(category).toLowerCase().includes(query));
    }, [categories, trimmed]);
    // Top-down browsing. `get_category_suggestions` can only answer "what
    // matches this text", so browsing is a separate read; it is only enabled
    // while the merchant is NOT searching, which is exactly when the popover
    // would otherwise show nothing but the sparse "Your categories" list.
    const [browseParent, setBrowseParent] = useState(null);
    const browseEnabled = !degraded && !disabled && !searching;
    const browse = useEbayCategoryBrowse(browseParent, browseEnabled);
    const shownMatches = matches.slice(0, 50);
    // Hide live results that already appear in the "Your categories" section.
    const searchResults = useMemo(() => {
        const shownIds = new Set(shownMatches.map((category) => category.id));
        return search.results.filter((result) => !shownIds.has(result.id));
    }, [search.results, shownMatches]);
    const changeText = (next) => {
        setText(next);
        const candidate = next.trim();
        if (candidate === '') {
            onChange(null);
            return;
        }
        // Free numeric entry: any category id can be set directly. In degraded
        // plain-text mode everything commits, exactly like the plain field.
        if (degraded || /^\d+$/u.test(candidate))
            onChange(degraded ? next : candidate);
        // Anything else is a search query; the committed value is unchanged
        // until an option is picked.
    };
    const selectCategory = (id) => {
        // Navigation sentinels move the browse cursor and never commit a value.
        if (id === BROWSE_ROOT) {
            setBrowseParent(null);
            return;
        }
        if (id.startsWith(BROWSE_INTO_PREFIX)) {
            setBrowseParent(id.slice(BROWSE_INTO_PREFIX.length));
            return;
        }
        if (id.startsWith(BROWSE_TO_PREFIX)) {
            setBrowseParent(id.slice(BROWSE_TO_PREFIX.length) || null);
            return;
        }
        onChange(id);
        const fromSearch = search.results.find((result) => result.id === id);
        if (fromSearch && !categories.some((category) => category.id === id)) {
            const picked = searchResultLabel(fromSearch);
            setPickedLabels((current) => ({ ...current, [id]: picked }));
            setText(picked);
            return;
        }
        const fromBrowse = browse.level.children.find((child) => child.id === id);
        if (fromBrowse && !categories.some((category) => category.id === id)) {
            const picked = `${fromBrowse.name} (${id})`;
            setPickedLabels((current) => ({ ...current, [id]: picked }));
            setText(picked);
            return;
        }
        setText(displayLabel(id));
    };
    const helpText = helpStack([
        ...(value !== null ? [`Draft: ${committedLabel ?? value}`] : []),
        currentSummary,
    ]);
    if (degraded) {
        return (_jsx(TextField, { label: label, value: text, onChange: changeText, autoComplete: "off", placeholder: "Enter a numeric eBay category ID", disabled: disabled, error: error, helpText: helpText }));
    }
    const showSearchSection = searching
        && (searchResults.length > 0 || search.isSearching || search.isError);
    const bothSectionsEmpty = searching
        && shownMatches.length === 0
        && searchResults.length === 0
        && !search.isSearching;
    const inlineError = error
        ?? (bothSectionsEmpty
            ? 'No matching category — pick from the list or enter a numeric category ID (digits only)'
            : undefined);
    const showBrowseSection = browseEnabled
        && (browse.level.children.length > 0 || browse.isLoading || browse.isError);
    const crumbs = browse.level.breadcrumb;
    const backValue = crumbs.length <= 1
        ? BROWSE_ROOT
        : `${BROWSE_TO_PREFIX}${crumbs[crumbs.length - 2].id}`;
    const hasPopoverContent = shownMatches.length > 0
        || showSearchSection
        || showBrowseSection
        || bothSectionsEmpty;
    return (_jsx(Combobox, { activator: (_jsx(Combobox.TextField, { label: label, value: text, onChange: changeText, autoComplete: "off", placeholder: "Search categories or enter a category ID", disabled: disabled, error: inlineError, helpText: helpText })), children: hasPopoverContent ? (_jsxs(Listbox, { onSelect: selectCategory, accessibilityLabel: "Categories", children: [shownMatches.length > 0 && (_jsx(Listbox.Section, { title: _jsx(Listbox.Header, { children: "Your categories" }), children: shownMatches.map((category) => (_jsx(Listbox.Option, { value: category.id, selected: category.id === value, children: categoryOptionLabel(category) }, category.id))) })), showSearchSection && (_jsxs(Listbox.Section, { divider: shownMatches.length > 0, title: _jsx(Listbox.Header, { children: "All eBay categories" }), children: [searchResults.map((result) => (_jsx(Listbox.Option, { value: result.id, selected: result.id === value, accessibilityLabel: `${searchResultLabel(result)} — ${result.path}`, children: _jsxs(BlockStack, { gap: "050", children: [_jsx(Text, { as: "span", children: searchResultLabel(result) }), result.path !== '' && (_jsx(Text, { as: "span", variant: "bodySm", tone: "subdued", children: result.path }))] }) }, result.id))), search.isSearching && (_jsx(Listbox.Loading, { accessibilityLabel: "Searching eBay categories" })), search.isError && !search.isSearching && (_jsx(Listbox.Option, { value: "__ebay-category-search-error__", disabled: true, children: _jsx(Text, { as: "span", variant: "bodySm", tone: "subdued", children: "eBay category search is unavailable right now \u2014 your categories and numeric ID entry still work." }) }))] })), showBrowseSection && (_jsxs(Listbox.Section, { divider: shownMatches.length > 0 || showSearchSection, title: (_jsx(Listbox.Header, { children: crumbs.length === 0
                            ? 'Browse all categories'
                            : `Browse: ${crumbs.map((crumb) => crumb.name).join(' > ')}` })), children: [crumbs.length > 0 && (_jsx(Listbox.Option, { value: backValue, accessibilityLabel: "Back to the previous category level", children: _jsx(Text, { as: "span", tone: "subdued", children: "\u2190 Back" }) })), browse.level.children.map((child) => (_jsx(Listbox.Option, { value: child.leaf ? child.id : `${BROWSE_INTO_PREFIX}${child.id}`, selected: child.id === value, accessibilityLabel: child.leaf
                                ? `${child.name} (${child.id}), selectable category`
                                : `${child.name}, ${child.childCount} subcategories`, children: _jsxs(BlockStack, { gap: "050", children: [_jsx(Text, { as: "span", children: child.leaf ? `${child.name} (${child.id})` : child.name }), !child.leaf && (_jsx(Text, { as: "span", variant: "bodySm", tone: "subdued", children: `${child.childCount} subcategor${child.childCount === 1 ? 'y' : 'ies'} →` }))] }) }, child.id))), browse.isLoading && (_jsx(Listbox.Loading, { accessibilityLabel: "Loading eBay categories" })), browse.isError && !browse.isLoading && (_jsx(Listbox.Option, { value: "__ebay-category-browse-error__", disabled: true, children: _jsx(Text, { as: "span", variant: "bodySm", tone: "subdued", children: "Category browsing is unavailable right now \u2014 search and numeric ID entry still work." }) }))] })), bothSectionsEmpty && (_jsx(Listbox.Option, { value: "__ebay-category-no-matches__", disabled: true, children: _jsx(Text, { as: "span", variant: "bodySm", tone: "subdued", children: "No matches" }) }))] })) : null }));
};
export const IdUsageSelect = ({ label, value, options, currentValue, idNoun, disabled, error, onChange, }) => {
    const inList = value === null || options.some((option) => option.id === value);
    const [freeEntry, setFreeEntry] = useState(false);
    if (freeEntry) {
        return (_jsx(TextField, { label: label, labelAction: { content: 'Choose from list', onAction: () => setFreeEntry(false) }, value: value ?? '', onChange: (next) => onChange(next.trim() === '' ? null : next), autoComplete: "off", disabled: disabled, error: error, placeholder: currentValue ?? undefined, helpText: helpStack([
                currentValue ? `Current: ${currentValue}` : 'No current value',
                'Leave blank to keep the current value.',
            ]) }));
    }
    const selectOptions = [
        {
            label: currentValue ? `Keep current (${currentValue})` : 'Keep current (not set)',
            value: '',
        },
        ...(!inList && value !== null
            ? [{ label: `${value} — current draft value`, value }]
            : []),
        ...options.map((option) => ({
            label: `${option.id} — used on ${option.usageCount} `
                + `listing${option.usageCount === 1 ? '' : 's'}`,
            value: option.id,
        })),
    ];
    return (_jsx(Select, { label: label, labelAction: {
            content: `Enter a different ${idNoun}`,
            onAction: () => setFreeEntry(true),
        }, options: selectOptions, value: value ?? '', disabled: disabled, error: error, onChange: (next) => onChange(next === '' ? null : next), helpText: helpStack([
            currentValue ? `Current: ${currentValue}` : 'No current value',
        ]) }));
};
