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
  onClose,
}) => {
  const [narrow, setNarrow] = useState(false);
  const preview = useListingDescriptionPreview(catalogId, { enabled: open });
  const html = preview.data?.html ?? null;
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
          <Banner tone="info">
            <Text as="p">
              This preview reflects the last saved draft (or the current listing
              when no draft has been saved). Nothing is sent to eBay.
            </Text>
          </Banner>
          {hasUnsavedChanges && (
            <Banner tone="warning">
              <Text as="p">
                You have unsaved changes — save the draft to see them in the preview.
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
                  background: 'var(--p-color-bg-surface-secondary, #f7f7f7)',
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
