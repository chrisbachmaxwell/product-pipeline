import React, { useState } from 'react';
import {
  Banner,
  BlockStack,
  Button,
  ButtonGroup,
  InlineStack,
  Modal,
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
  const serverHtml = preview.data?.html ?? null;
  // Two truths, in order of preference:
  // 1. Unsaved edits -> show what the operator is LOOKING AT (previewing the
  //    stale saved draft would be misleading).
  // 2. Server preview unavailable (its live Shopify read fails
  //    intermittently) -> STILL show the editor's current description
  //    rather than a dead-end warning. The operator hit exactly that wall
  //    live on 2026-09-10 ("Preview is unavailable right now" with a full
  //    description sitting in the editor behind the modal).
  // The branded frame (header, shipping/returns cards) is applied by the
  // template at publish; the body is theirs either way.
  const wrapDraft = (inner: string) =>
    `<body style="margin:24px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#1a1a1a;line-height:1.5;background:#ffffff">${inner}</body>`;
  const liveHtml = draftDescriptionHtml
    && (hasUnsavedChanges || (!preview.isLoading && serverHtml === null))
    ? wrapDraft(draftDescriptionHtml)
    : null;
  const html = liveHtml ?? serverHtml;
  const templateVersion = preview.data?.templateVersion ?? null;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="eBay description preview"
      size="large"
      primaryAction={{ content: 'Close', onAction: onClose }}
    >
      <Modal.Section>
        <BlockStack gap="400">
          {liveHtml ? (
            <Banner tone="info">
              <Text as="p">
                Showing your current edits. The branded frame — store header,
                shipping and returns cards — is added automatically when you
                publish. Nothing is sent to eBay from here.
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

          {preview.isLoading ? (
            <InlineStack align="center" blockAlign="center" gap="200">
              <Spinner accessibilityLabel="Loading description preview" size="large" />
            </InlineStack>
          ) : preview.isError || html === null ? (
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
                    height: '65vh',
                    minHeight: '360px',
                    border: '0',
                    display: 'block',
                    background: '#ffffff',
                  }}
                />
              </div>
            </BlockStack>
          )}
        </BlockStack>
      </Modal.Section>
    </Modal>
  );
};

export default ListingDescriptionPreviewModal;
