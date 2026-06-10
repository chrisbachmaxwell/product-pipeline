import React, { useState } from 'react';
import {
  Banner,
  Button,
  ButtonGroup,
  Card,
  BlockStack,
  InlineStack,
  Text,
  Badge,
  Divider,
  Box,
} from '@shopify/polaris';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '../hooks/useApi';
import { useAppStore } from '../store';

interface InlineDraftApprovalProps {
  productId: string;
}

interface Draft {
  id: number;
  shopify_product_id: string;
  draft_title: string | null;
  draft_description: string | null;
  draft_images_json: string | null;
  original_title: string | null;
  original_description: string | null;
  original_images_json: string | null;
  status: string;
  auto_publish: number;
  created_at: number;
  updated_at: number;
  reviewed_at: number | null;
  reviewed_by: string | null;
  draftImages: string[];
  originalImages: string[];
}

interface DraftResponse {
  draft: Draft | null;
  live: {
    title: string;
    description: string;
    images: string[];
    hasPhotos: boolean;
    hasDescription: boolean;
  };
}

const formatDate = (unix: number) => {
  return new Date(unix * 1000).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
};

const truncateHtml = (html: string, maxLen = 150) => {
  const text = html.replace(/<[^>]*>/g, '').replace(/&[^;]+;/g, ' ');
  return text.length > maxLen ? text.substring(0, maxLen) + '...' : text;
};

const InlineDraftApproval: React.FC<InlineDraftApprovalProps> = ({ productId }) => {
  const queryClient = useQueryClient();
  const { addNotification } = useAppStore();
  const [showPreview, setShowPreview] = useState(false);

  // Fetch pending draft for this product
  const { data: draftData, isLoading } = useQuery({
    queryKey: ['draft-by-product', productId],
    queryFn: () => apiClient.get<DraftResponse>(`/drafts/product/${productId}`),
    enabled: Boolean(productId),
    refetchInterval: 30000, // Check for new drafts periodically
  });

  // Approve mutation
  const approveMutation = useMutation({
    mutationFn: ({ draftId, photos, description }: { draftId: number; photos: boolean; description: boolean }) =>
      apiClient.post(`/drafts/${draftId}/approve`, { photos, description }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['draft-by-product', productId] });
      queryClient.invalidateQueries({ queryKey: ['product-info', productId] });
      queryClient.invalidateQueries({ queryKey: ['products-overview'] });
      addNotification({ 
        type: 'success', 
        title: 'Draft approved', 
        message: 'Changes have been applied to the live product',
        autoClose: 4000 
      });
    },
    onError: (error) => {
      addNotification({
        type: 'error',
        title: 'Approval failed',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    },
  });

  // Reject/dismiss mutation
  const rejectMutation = useMutation({
    mutationFn: (draftId: number) => apiClient.post(`/drafts/${draftId}/reject`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['draft-by-product', productId] });
      addNotification({ 
        type: 'success', 
        title: 'Draft dismissed', 
        autoClose: 3000 
      });
    },
    onError: (error) => {
      addNotification({
        type: 'error',
        title: 'Failed to dismiss draft',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    },
  });

  const handleApprove = (photos: boolean, description: boolean) => {
    if (draftData?.draft) {
      approveMutation.mutate({ 
        draftId: draftData.draft.id, 
        photos, 
        description 
      });
    }
  };

  const handleDismiss = () => {
    if (draftData?.draft) {
      rejectMutation.mutate(draftData.draft.id);
    }
  };

  // Don't render if no draft or loading
  if (isLoading || !draftData?.draft || draftData.draft.status !== 'pending') {
    return null;
  }

  const { draft, live } = draftData;
  const hasDescription = Boolean(draft.draft_description);
  const hasImages = draft.draftImages.length > 0;

  return (
    <Card>
      <Banner
        title="AI has generated a new description for this product"
        action={{
          content: showPreview ? 'Hide preview' : 'Show preview',
          onAction: () => setShowPreview(!showPreview),
        }}
        secondaryAction={{
          content: 'Dismiss',
          onAction: handleDismiss,
        }}
      >
        <BlockStack gap="300">
          <InlineStack gap="200" align="space-between">
            <Text as="p" variant="bodyMd">
              Ready for review • Created {formatDate(draft.created_at)}
            </Text>
            <Badge tone="attention">Pending Approval</Badge>
          </InlineStack>

          {/* Action buttons */}
          <ButtonGroup>
            <Button
              variant="primary"
              size="medium"
              onClick={() => handleApprove(hasImages, hasDescription)}
              loading={approveMutation.isPending}
              disabled={!hasDescription && !hasImages}
            >
              Approve All
            </Button>
            {hasDescription && (
              <Button
                onClick={() => handleApprove(false, true)}
                loading={approveMutation.isPending}
                size="medium"
              >
                Approve Description Only
              </Button>
            )}
            {hasImages && (
              <Button
                onClick={() => handleApprove(true, false)}
                loading={approveMutation.isPending}
                size="medium"
              >
                Approve Photos Only
              </Button>
            )}
          </ButtonGroup>

          {/* Preview/diff section */}
          {showPreview && (
            <Box padding="400" background="bg-surface-secondary">
              <BlockStack gap="300">
                {hasDescription && (
                  <>
                    <Text variant="headingSm" as="h4">Description Changes</Text>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
                      <Card>
                        <BlockStack gap="200">
                          <Text variant="bodySm" as="h5" tone="subdued">Current</Text>
                          <div style={{
                            fontSize: '13px',
                            lineHeight: 1.4,
                            maxHeight: '200px',
                            overflow: 'auto',
                          }}>
                            {live.description ? (
                              <div dangerouslySetInnerHTML={{ __html: truncateHtml(live.description, 300) }} />
                            ) : (
                              <Text as="p" tone="subdued"><em>No description</em></Text>
                            )}
                          </div>
                        </BlockStack>
                      </Card>
                      <Card>
                        <BlockStack gap="200">
                          <Text variant="bodySm" as="h5" tone="subdued">Proposed</Text>
                          <div style={{
                            fontSize: '13px',
                            lineHeight: 1.4,
                            maxHeight: '200px',
                            overflow: 'auto',
                          }}>
                            {draft.draft_description ? (
                              <div style={{ whiteSpace: 'pre-wrap' }}>
                                {truncateHtml(draft.draft_description, 300)}
                              </div>
                            ) : (
                              <Text as="p" tone="subdued"><em>No changes</em></Text>
                            )}
                          </div>
                        </BlockStack>
                      </Card>
                    </div>
                  </>
                )}

                {hasImages && (
                  <>
                    {hasDescription && <Divider />}
                    <Text variant="headingSm" as="h4">Image Changes</Text>
                    <InlineStack gap="200">
                      <Text as="p" variant="bodyMd">
                        <strong>{draft.draftImages.length}</strong> processed images ready
                      </Text>
                      {live.images.length > 0 && (
                        <Text as="p" variant="bodyMd" tone="subdued">
                          (replacing {live.images.length} current)
                        </Text>
                      )}
                    </InlineStack>
                  </>
                )}
              </BlockStack>
            </Box>
          )}
        </BlockStack>
      </Banner>
    </Card>
  );
};

export default InlineDraftApproval;