import React, { useEffect, useMemo, useState } from 'react';
import {
  BlockStack,
  Combobox,
  Listbox,
  Select,
  Text,
  TextField,
} from '@shopify/polaris';
import type {
  ListingEditorCategory,
  ListingEditorCondition,
  ListingEditorIdUsage,
} from '../hooks/useListingEditorMetadata';
import {
  useEbayCategorySearch,
  type EbayCategorySearchResult,
} from '../hooks/useEbayCategorySearch';

/**
 * Presentation-only pickers for the local draft editor. Each one edits a
 * single draft override value (string, or null for "keep current") and never
 * talks to any API — the parent owns state and the save contract.
 */

const helpStack = (lines: React.ReactNode[]): React.ReactNode => (
  <BlockStack gap="050">
    {lines.map((line, index) => (
      <Text as="span" variant="bodySm" tone="subdued" key={String(index)}>{line}</Text>
    ))}
  </BlockStack>
);

// ── Condition ──────────────────────────────────────────────────────────────

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

export const conditionDisplayLabel = (
  id: string,
  conditions: ListingEditorCondition[],
): string => {
  const match = conditions.find((condition) => condition.id === id);
  return match ? `${match.label} (${match.id})` : id;
};

export const ConditionSelect: React.FC<ConditionSelectProps> = ({
  label, value, conditions, currentSummary, disabled, error, onChange,
}) => {
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
  return (
    <Select
      label={label}
      options={options}
      value={value ?? ''}
      disabled={disabled}
      error={error}
      onChange={(next) => onChange(next === '' ? null : next)}
      helpText={helpStack([
        currentSummary,
        'Condition is saved to the draft but is not yet dispatchable to eBay.',
      ])}
    />
  );
};

// ── Category ───────────────────────────────────────────────────────────────

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

const categoryName = (category: ListingEditorCategory): string =>
  category.name === null ? `Category ${category.id}` : `${category.name} (${category.id})`;

const categoryOptionLabel = (category: ListingEditorCategory): string =>
  `${categoryName(category)} — used on ${category.usageCount} `
  + `listing${category.usageCount === 1 ? '' : 's'}`;

export const categoryDisplayLabel = (
  id: string,
  categories: ListingEditorCategory[],
): string => {
  const match = categories.find((category) => category.id === id);
  return match ? categoryName(match) : id;
};

const searchResultLabel = (result: EbayCategorySearchResult): string =>
  `${result.name} (${result.id})`;

export const CategoryPicker: React.FC<CategoryPickerProps> = ({
  label, value, categories, currentSummary, disabled, error, onChange,
}) => {
  // Display labels for live-search results the merchant picked; keeps the
  // committed value rendering as "Name (id)" even though the id is not in
  // the used-category metadata.
  const [pickedLabels, setPickedLabels] = useState<Record<string, string>>({});
  const displayLabel = (id: string): string => {
    const fromMetadata = categories.find((category) => category.id === id);
    if (fromMetadata) return categoryName(fromMetadata);
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
    if (search.isError) setSearchEverFailed(true);
  }, [search.isError]);

  const matches = useMemo(() => {
    if (trimmed === '') return categories;
    const query = trimmed.toLowerCase();
    return categories.filter((category) =>
      category.id.includes(query)
      || (category.name ?? '').toLowerCase().includes(query)
      || categoryName(category).toLowerCase().includes(query));
  }, [categories, trimmed]);

  const shownMatches = matches.slice(0, 50);
  // Hide live results that already appear in the "Your categories" section.
  const searchResults = useMemo(() => {
    const shownIds = new Set(shownMatches.map((category) => category.id));
    return search.results.filter((result) => !shownIds.has(result.id));
  }, [search.results, shownMatches]);

  const changeText = (next: string) => {
    setText(next);
    const candidate = next.trim();
    if (candidate === '') {
      onChange(null);
      return;
    }
    // Free numeric entry: any category id can be set directly. In degraded
    // plain-text mode everything commits, exactly like the plain field.
    if (degraded || /^\d+$/u.test(candidate)) onChange(degraded ? next : candidate);
    // Anything else is a search query; the committed value is unchanged
    // until an option is picked.
  };

  const selectCategory = (id: string) => {
    onChange(id);
    const fromSearch = search.results.find((result) => result.id === id);
    if (fromSearch && !categories.some((category) => category.id === id)) {
      const picked = searchResultLabel(fromSearch);
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
    return (
      <TextField
        label={label}
        value={text}
        onChange={changeText}
        autoComplete="off"
        placeholder="Enter a numeric eBay category ID"
        disabled={disabled}
        error={error}
        helpText={helpText}
      />
    );
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

  const hasPopoverContent = shownMatches.length > 0 || showSearchSection || bothSectionsEmpty;

  return (
    <Combobox
      activator={(
        <Combobox.TextField
          label={label}
          value={text}
          onChange={changeText}
          autoComplete="off"
          placeholder="Search categories or enter a category ID"
          disabled={disabled}
          error={inlineError}
          helpText={helpText}
        />
      )}
    >
      {hasPopoverContent ? (
        <Listbox onSelect={selectCategory} accessibilityLabel="Categories">
          {shownMatches.length > 0 && (
            <Listbox.Section title={<Listbox.Header>Your categories</Listbox.Header>}>
              {shownMatches.map((category) => (
                <Listbox.Option
                  key={category.id}
                  value={category.id}
                  selected={category.id === value}
                >
                  {categoryOptionLabel(category)}
                </Listbox.Option>
              ))}
            </Listbox.Section>
          )}
          {showSearchSection && (
            <Listbox.Section
              divider={shownMatches.length > 0}
              title={<Listbox.Header>All eBay categories</Listbox.Header>}
            >
              {searchResults.map((result) => (
                <Listbox.Option
                  key={result.id}
                  value={result.id}
                  selected={result.id === value}
                  accessibilityLabel={`${searchResultLabel(result)} — ${result.path}`}
                >
                  <BlockStack gap="050">
                    <Text as="span">{searchResultLabel(result)}</Text>
                    {result.path !== '' && (
                      <Text as="span" variant="bodySm" tone="subdued">{result.path}</Text>
                    )}
                  </BlockStack>
                </Listbox.Option>
              ))}
              {search.isSearching && (
                <Listbox.Loading accessibilityLabel="Searching eBay categories" />
              )}
              {search.isError && !search.isSearching && (
                <Listbox.Option value="__ebay-category-search-error__" disabled>
                  <Text as="span" variant="bodySm" tone="subdued">
                    eBay category search is unavailable right now — your categories
                    and numeric ID entry still work.
                  </Text>
                </Listbox.Option>
              )}
            </Listbox.Section>
          )}
          {bothSectionsEmpty && (
            <Listbox.Option value="__ebay-category-no-matches__" disabled>
              <Text as="span" variant="bodySm" tone="subdued">No matches</Text>
            </Listbox.Option>
          )}
        </Listbox>
      ) : null}
    </Combobox>
  );
};

// ── Policies and merchant location ─────────────────────────────────────────

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

export const IdUsageSelect: React.FC<IdUsageSelectProps> = ({
  label, value, options, currentValue, idNoun, disabled, error, onChange,
}) => {
  const inList = value === null || options.some((option) => option.id === value);
  const [freeEntry, setFreeEntry] = useState(false);

  if (freeEntry) {
    return (
      <TextField
        label={label}
        labelAction={{ content: 'Choose from list', onAction: () => setFreeEntry(false) }}
        value={value ?? ''}
        onChange={(next) => onChange(next.trim() === '' ? null : next)}
        autoComplete="off"
        disabled={disabled}
        error={error}
        placeholder={currentValue ?? undefined}
        helpText={helpStack([
          currentValue ? `Current: ${currentValue}` : 'No current value',
          'Leave blank to keep the current value.',
        ])}
      />
    );
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

  return (
    <Select
      label={label}
      labelAction={{
        content: `Enter a different ${idNoun}`,
        onAction: () => setFreeEntry(true),
      }}
      options={selectOptions}
      value={value ?? ''}
      disabled={disabled}
      error={error}
      onChange={(next) => onChange(next === '' ? null : next)}
      helpText={helpStack([
        currentValue ? `Current: ${currentValue}` : 'No current value',
      ])}
    />
  );
};
