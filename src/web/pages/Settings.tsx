import React, { useEffect, useState } from 'react';
import {
  Badge,
  Banner,
  BlockStack,
  Button,
  Card,
  InlineStack,
  Link,
  Page,
  Text,
  TextField,
} from '@shopify/polaris';
import { apiClient, useMigrationStatus } from '../hooks/useApi';
import { useAuthoritativeListings } from '../hooks/useAuthoritativeListings';
import { isLiveCatalogResponse } from '../operator-ui';

const Row: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <InlineStack align="space-between" blockAlign="center">
    <Text as="span">{label}</Text>
    {children}
  </InlineStack>
);

/** Owner labels the server reports -> what the operator should read. */
const OWNER_LABEL: Record<string, { text: string; tone: 'success' | 'attention' }> = {
  'product-pipeline': { text: 'ProductPipeline', tone: 'success' },
  'marketplace-connect': { text: 'Marketplace Connect', tone: 'attention' },
  unverified: { text: 'Not yet transferred', tone: 'attention' },
};

const RESPONSIBILITY_LABEL: Record<string, string> = {
  orderImport: 'Order import',
  price: 'Prices',
  inventory: 'Inventory',
  listingCreate: 'New listings',
  listingRevise: 'Listing edits',
  listingEndRelist: 'Ending and relisting',
  fulfillment: 'Tracking numbers',
};


/**
 * Connect the AI diagnosis tier from the app (L79): paste the key once,
 * the server verifies it live with Anthropic before saving it to the
 * credential vault. The key never renders anywhere after submission.
 */
const AnthropicConnection: React.FC = () => {
  const [status, setStatus] = useState<{ connected: boolean; source: string | null } | null>(null);
  const [open, setOpen] = useState(false);
  const [apiKey, setApiKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const refresh = async () => {
    try {
      const body = await apiClient.get<{ anthropic: { connected: boolean; source: string | null } }>('/connections');
      setStatus(body.anthropic);
    } catch { /* leave last state */ }
  };
  useEffect(() => { void refresh(); }, []);
  const connect = async () => {
    setBusy(true);
    setError(null);
    try {
      const body = await apiClient.post<{ anthropic: { connected: boolean; source: string | null } }>(
        '/connections/anthropic', { apiKey: apiKey.trim() },
      );
      setStatus(body.anthropic);
      setApiKey('');
      setOpen(false);
    } catch (raised) {
      setError(raised instanceof Error
        ? raised.message.replace(/\s*\(CONNECTION_[A-Z_]+\)\s*$/, '')
        : 'Connection failed');
    } finally {
      setBusy(false);
    }
  };
  const disconnect = async () => {
    setBusy(true);
    try {
      const body = await apiClient.delete<{ anthropic: { connected: boolean; source: string | null } }>('/connections/anthropic');
      setStatus(body.anthropic);
    } catch { /* surface via refresh */ } finally {
      setBusy(false);
      void refresh();
    }
  };
  return (
    <BlockStack gap="200">
      <Row label="Claude (AI incident diagnosis)">
        {status === null ? <Badge>Checking…</Badge>
          : status.connected
            ? (
              <InlineStack gap="200" blockAlign="center">
                <Badge tone="success">Connected</Badge>
                {status.source === 'stored' && (
                  <Button variant="plain" tone="critical" disabled={busy} onClick={() => { void disconnect(); }}>
                    Disconnect
                  </Button>
                )}
              </InlineStack>
            )
            : <Button onClick={() => setOpen(true)} disabled={busy}>Connect</Button>}
      </Row>
      {open && status !== null && !status.connected && (
        <BlockStack gap="200">
          <Text as="p" variant="bodySm" tone="subdued">
            1. Create a key at{' '}
            <Link url="https://console.anthropic.com/settings/keys" target="_blank">
              console.anthropic.com → API Keys
            </Link>
            {' '}(name it productpipeline). 2. Paste it below — it is verified with
            Anthropic before being saved to this app’s credential vault, and is
            never shown again.
          </Text>
          {error && <Banner tone="critical"><Text as="p">{error}</Text></Banner>}
          <InlineStack gap="200" blockAlign="end" wrap={false}>
            <div style={{ flexGrow: 1 }}>
              <TextField
                label="Anthropic API key"
                labelHidden
                type="password"
                autoComplete="off"
                placeholder="sk-ant-…"
                value={apiKey}
                onChange={setApiKey}
              />
            </div>
            <Button variant="primary" loading={busy} disabled={apiKey.trim().length < 12}
              onClick={() => { void connect(); }}>
              Verify & connect
            </Button>
            <Button disabled={busy} onClick={() => { setOpen(false); setError(null); setApiKey(''); }}>
              Cancel
            </Button>
          </InlineStack>
        </BlockStack>
      )}
    </BlockStack>
  );
};

const Settings: React.FC = () => {
  const migration = useMigrationStatus();
  const listings = useAuthoritativeListings({ limit: 1, offset: 0 });
  const ebayCurrent = isLiveCatalogResponse(listings.data);
  const responsibilities = (migration.data?.responsibilities ?? [])
    .filter((entry) => entry.responsibility in RESPONSIBILITY_LABEL);

  return (
    <Page title="Settings" fullWidth>
      <BlockStack gap="400">
        <Card>
          <BlockStack gap="300">
            <Text as="h3" variant="headingMd">Connections</Text>
            <Row label="Shopify">
              <Badge tone="success">Connected</Badge>
            </Row>
            <Row label="eBay">
              {ebayCurrent
                ? <Badge tone="success">Connected</Badge>
                : <Badge tone="attention">Checking…</Badge>}
            </Row>
            <AnthropicConnection />
          </BlockStack>
        </Card>

        <Card>
          <BlockStack gap="300">
            <Text as="h3" variant="headingMd">What ProductPipeline runs</Text>
            {responsibilities.map((entry) => {
              const owner = OWNER_LABEL[entry.owner ?? ''] ?? OWNER_LABEL.unverified;
              return (
                <Row key={entry.responsibility} label={RESPONSIBILITY_LABEL[entry.responsibility]}>
                  <Badge tone={owner.tone}>{owner.text}</Badge>
                </Row>
              );
            })}
            <Text as="p" variant="bodySm" tone="subdued">
              Marketplace Connect was retired on September 8, 2026. Every change to eBay
              is recorded in a tamper-evident history.
            </Text>
          </BlockStack>
        </Card>

        <Card>
          <BlockStack gap="200">
            <InlineStack align="space-between" blockAlign="center">
              <Text as="h3" variant="headingMd">Old eBay orders</Text>
              <Badge tone="success">Protected</Badge>
            </InlineStack>
            <Text as="p" tone="subdued">
              Orders from before September 8, 2026 are never imported into Shopify.
              This protection is permanent and cannot be switched off.
            </Text>
          </BlockStack>
        </Card>
      </BlockStack>
    </Page>
  );
};

export default Settings;
