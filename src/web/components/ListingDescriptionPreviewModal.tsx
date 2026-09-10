import React, { useState } from 'react';
import {
  Banner,
  BlockStack,
  Button,
  ButtonGroup,
  Card,
  InlineStack,
  Spinner,
  Text,
} from '@shopify/polaris';
import { useListingDescriptionPreview } from '../hooks/useListingDescriptionPreview';

interface Props {
  catalogId: string;
  open: boolean;
  hasUnsavedChanges: boolean;
  /** The editor's current (possibly unsaved) sanitized description HTML. */
  draftDescriptionHtml?: string | null;
  onClose: () => void;
}

/**
 * Displays the server-rendered branded eBay description inside a strictly
 * sandboxed iframe (sandbox="" — no scripts, no same-origin). Display-only.
 *
 * Rendered as an IN-FLOW card, deliberately not a Modal: inside the Shopify
 * admin's embedded iframe the app document is as tall as its content and
 * never scrolls itself, so overlay surfaces (position:fixed backdrops and
 * centered dialogs) land in the wrong place and wash out the content the
 * operator is trying to read — exactly the "everything is greyed out" state
 * hit live on 2026-09-10. An in-flow card cannot exhibit any of that.
 */
const ListingDescriptionPreviewModal: React.FC<Props> = ({
  catalogId,
  open,
  hasUnsavedChanges,
  draftDescriptionHtml,
  onClose,
}) => {
  const [narrow, setNarrow] = useState(false);
  const preview = useListingDescriptionPreview(catalogId, { enabled: open });
  if (!open) return null;
  const serverHtml = preview.data?.html ?? null;
  // Two truths, in order of preference:
  // 1. Unsaved edits -> show what the operator is LOOKING AT (previewing the
  //    stale saved draft would be misleading).
  // 2. Server preview unavailable (its live Shopify read fails
  //    intermittently) -> STILL show the editor's current description
  //    rather than a dead-end warning.
  // The branded frame (header, gallery, tabs, shipping cards) is applied by
  // the template at publish; the body is theirs either way.
  const wrapDraft = (inner: string) =>
    `<body style="margin:24px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#1a1a1a;line-height:1.5;background:#ffffff">${inner}</body>`;
  const liveHtml = draftDescriptionHtml
    && (hasUnsavedChanges || (!preview.isLoading && serverHtml === null))
    ? wrapDraft(draftDescriptionHtml)
    : null;
  const html = liveHtml ?? serverHtml;
  const templateVersion = preview.data?.templateVersion ?? null;

  return (
    <Card>
      <BlockStack gap="400">
        <InlineStack align="space-between" blockAlign="center" gap="300">
          <Text as="h2" variant="headingMd">eBay description preview</Text>
          <Button variant="plain" onClick={onClose}>Close preview</Button>
        </InlineStack>
        {liveHtml ? (
          <Banner tone="info">
            <Text as="p">
              Showing your current edits. The branded frame — store header,
              photo gallery, shipping and returns tabs — is added
              automatically when you publish. Nothing is sent to eBay from
              here.
            </Text>
          </Banner>
        ) : (
          <Banner tone="info">
            <Text as="p">
              This is how the description will look on eBay, using the last
              saved draft. Nothing is sent to eBay from here.
            </Text>
          </Banner>
        )}

        {preview.isLoading && html === null ? (
          <InlineStack align="center" blockAlign="center" gap="200">
            <Spinner accessibilityLabel="Loading description preview" size="large" />
          </InlineStack>
        ) : html === null ? (
          <Banner tone="warning" title="Preview is unavailable right now">
            <Text as="p">Try again in a moment, or save the draft and reopen the preview.</Text>
          </Banner>
        ) : (
          <BlockStack gap="300">
            <InlineStack align="space-between" blockAlign="center" gap="300" wrap>
              <ButtonGroup variant="segmented">
                <Button pressed={!narrow} onClick={() => setNarrow(false)}>
                  Full width
                </Button>
                <Button pressed={narrow} onClick={() => setNarrow(true)}>
                  Mobile (375px)
                </Button>
              </ButtonGroup>
              {templateVersion && (
                <Text as="span" variant="bodySm" tone="subdued">
                  Template {templateVersion}
                </Text>
              )}
            </InlineStack>
            <div
              style={{
                display: 'flex',
                justifyContent: 'center',
                border: '1px solid var(--p-color-border, #e3e3e3)',
                borderRadius: '8px',
                background: '#ffffff',
                overflow: 'auto',
              }}
            >
              <iframe
                sandbox=""
                srcDoc={html}
                title="eBay description preview"
                style={{
                  width: narrow ? '375px' : '100%',
                  maxWidth: '100%',
                  height: '640px',
                  border: '0',
                  display: 'block',
                  background: '#ffffff',
                }}
              />
            </div>
          </BlockStack>
        )}
      </BlockStack>
    </Card>
  );
};

export default ListingDescriptionPreviewModal;
