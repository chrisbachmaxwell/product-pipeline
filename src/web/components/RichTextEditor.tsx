import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  BlockStack,
  Button,
  ButtonGroup,
  InlineStack,
  Text,
  TextField,
} from '@shopify/polaris';
import { safeListingLinkHref, sanitizeListingHtml } from '../listing-html';

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

const surfaceStyle = (disabled: boolean, invalid: boolean): React.CSSProperties => ({
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

const RichTextEditor: React.FC<Props> = ({
  label,
  value,
  disabled = false,
  error,
  helpText,
  maxLength,
  onChange,
}) => {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const lastEmittedRef = useRef<string | null>(null);
  const [htmlMode, setHtmlMode] = useState(false);
  const [source, setSource] = useState('');

  useEffect(() => {
    if (htmlMode) return;
    const surface = surfaceRef.current;
    if (!surface || value === lastEmittedRef.current) return;
    // Sanitized upstream and sanitized again here before entering the DOM.
    surface.innerHTML = sanitizeListingHtml(value);
    lastEmittedRef.current = value;
  }, [value, htmlMode]);

  const emitFromSurface = useCallback(() => {
    const surface = surfaceRef.current;
    if (!surface) return;
    const html = sanitizeListingHtml(surface.innerHTML);
    lastEmittedRef.current = html;
    onChange(html);
  }, [onChange]);

  const exec = (command: string, argument?: string) => {
    const surface = surfaceRef.current;
    if (!surface || disabled) return;
    surface.focus();
    try {
      document.execCommand('styleWithCSS', false, 'false');
    } catch {
      // Older engines only; formatting still works without it.
    }
    document.execCommand(command, false, argument);
    emitFromSurface();
  };

  const insertLink = () => {
    const raw = window.prompt('Link URL (must start with http:// or https://)');
    if (raw === null || raw.trim() === '') return;
    const href = safeListingLinkHref(raw.trim());
    if (href === null) {
      window.alert('Enter a full http:// or https:// URL.');
      return;
    }
    exec('createLink', href);
  };

  const clearFormatting = () => {
    const surface = surfaceRef.current;
    if (!surface || disabled) return;
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

  const changeSource = (next: string) => {
    setSource(next);
    const html = sanitizeListingHtml(next);
    lastEmittedRef.current = html;
    onChange(html);
  };

  const characterCount = value.length;
  const overLimit = characterCount > maxLength;

  return (
    <BlockStack gap="150">
      {label}
      <InlineStack gap="200" blockAlign="center" wrap>
        <ButtonGroup variant="segmented">
          <Button size="slim" disabled={disabled || htmlMode} accessibilityLabel="Bold"
            onClick={() => exec('bold')}>B</Button>
          <Button size="slim" disabled={disabled || htmlMode} accessibilityLabel="Italic"
            onClick={() => exec('italic')}>I</Button>
          <Button size="slim" disabled={disabled || htmlMode} accessibilityLabel="Underline"
            onClick={() => exec('underline')}>U</Button>
        </ButtonGroup>
        <ButtonGroup variant="segmented">
          <Button size="slim" disabled={disabled || htmlMode} accessibilityLabel="Bulleted list"
            onClick={() => exec('insertUnorderedList')}>• List</Button>
          <Button size="slim" disabled={disabled || htmlMode} accessibilityLabel="Numbered list"
            onClick={() => exec('insertOrderedList')}>1. List</Button>
        </ButtonGroup>
        <ButtonGroup variant="segmented">
          <Button size="slim" disabled={disabled || htmlMode} accessibilityLabel="Heading 2"
            onClick={() => exec('formatBlock', 'h2')}>H2</Button>
          <Button size="slim" disabled={disabled || htmlMode} accessibilityLabel="Heading 3"
            onClick={() => exec('formatBlock', 'h3')}>H3</Button>
          <Button size="slim" disabled={disabled || htmlMode} accessibilityLabel="Paragraph"
            onClick={() => exec('formatBlock', 'p')}>¶</Button>
        </ButtonGroup>
        <ButtonGroup variant="segmented">
          <Button size="slim" disabled={disabled || htmlMode} accessibilityLabel="Insert link"
            onClick={insertLink}>Link</Button>
          <Button size="slim" disabled={disabled || htmlMode} accessibilityLabel="Clear formatting"
            onClick={clearFormatting}>Clear</Button>
        </ButtonGroup>
        <Button size="slim" pressed={htmlMode} disabled={disabled}
          accessibilityLabel="Toggle raw HTML source"
          onClick={htmlMode ? leaveHtmlMode : enterHtmlMode}>HTML</Button>
      </InlineStack>
      {htmlMode ? (
        <TextField
          label="Description HTML source"
          labelHidden
          value={source}
          onChange={changeSource}
          multiline={8}
          monospaced
          autoComplete="off"
          disabled={disabled}
          helpText="Only simple formatting tags are kept; scripts, styles, images, and attributes are removed automatically."
        />
      ) : (
        <div
          ref={surfaceRef}
          contentEditable={!disabled}
          suppressContentEditableWarning
          role="textbox"
          aria-multiline="true"
          aria-label="Description"
          onInput={emitFromSurface}
          onBlur={emitFromSurface}
          style={surfaceStyle(disabled, Boolean(error))}
        />
      )}
      <InlineStack align="space-between" blockAlign="center" gap="200" wrap>
        <Text as="span" variant="bodySm" tone={overLimit ? 'critical' : 'subdued'}>
          {characterCount.toLocaleString()} / {maxLength.toLocaleString()} HTML characters
        </Text>
        {error && <Text as="span" variant="bodySm" tone="critical">{error}</Text>}
      </InlineStack>
      {helpText && <Text as="span" variant="bodySm" tone="subdued">{helpText}</Text>}
    </BlockStack>
  );
};

export default RichTextEditor;
