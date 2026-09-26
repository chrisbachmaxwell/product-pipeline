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
type ConnectionState = { connected: boolean; source: string | null };
type ConnectionsResponse = { anthropic: ConnectionState; github: ConnectionState };

/**
 * Connect an API from the app (L79): paste the secret once, the server
 * verifies it live with the provider before saving it to the credential
 * vault. The secret never renders anywhere after submission.
 */
const ConnectionRow: React.FC<{
  label: string;
  endpoint: string;
  placeholder: string;
  instructions: React.ReactNode;
  state: ConnectionState | null;
  onChanged: (next: ConnectionsResponse) => void;
}> = ({ label, endpoint, placeholder, instructions, state, onChanged }) => {
  const [open, setOpen] = useState(false);
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const connect = async () => {
    setBusy(true);
    setError(null);
    try {
      const body = await apiClient.post<ConnectionsResponse>(endpoint, { apiKey: secret.trim() });
      onChanged(body);
      setSecret('');
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
      onChanged(await apiClient.delete<ConnectionsResponse>(endpoint));
    } catch { /* next poll corrects */ } finally {
      setBusy(false);
    }
  };
  return (
    <BlockStack gap="200">
      <Row label={label}>
        {state === null ? <Badge>Checking…</Badge>
          : state.connected
            ? (
              <InlineStack gap="200" blockAlign="center">
                <Badge tone="success">Connected</Badge>
                {state.source === 'stored' && (
                  <Button variant="plain" tone="critical" disabled={busy} onClick={() => { void disconnect(); }}>
                    Disconnect
                  </Button>
                )}
              </InlineStack>
            )
            : <Button onClick={() => setOpen(true)} disabled={busy}>Connect</Button>}
      </Row>
      {open && state !== null && !state.connected && (
        <BlockStack gap="200">
          <Text as="p" variant="bodySm" tone="subdued">{instructions}</Text>
          {error && <Banner tone="critical"><Text as="p">{error}</Text></Banner>}
          <InlineStack gap="200" blockAlign="end" wrap={false}>
            <div style={{ flexGrow: 1 }}>
              <TextField
                label={label}
                labelHidden
                type="password"
                autoComplete="off"
                placeholder={placeholder}
                value={secret}
                onChange={setSecret}
              />
            </div>
            <Button variant="primary" loading={busy} disabled={secret.trim().length < 12}
              onClick={() => { void connect(); }}>
              Verify & connect
            </Button>
            <Button disabled={busy} onClick={() => { setOpen(false); setError(null); setSecret(''); }}>
              Cancel
            </Button>
          </InlineStack>
        </BlockStack>
      )}
    </BlockStack>
  );
};

const ApiConnections: React.FC = () => {
  const [connections, setConnections] = useState<ConnectionsResponse | null>(null);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const body = await apiClient.get<ConnectionsResponse>('/connections');
        if (!cancelled) setConnections(body);
      } catch { /* leave null */ }
    })();
    return () => { cancelled = true; };
  }, []);
  return (
    <>
      <ConnectionRow
        label="Claude (AI incident diagnosis)"
        endpoint="/connections/anthropic"
        placeholder="sk-ant-…"
        state={connections?.anthropic ?? null}
        onChanged={setConnections}
        instructions={(
          <>
            1. Create a key at{' '}
            <Link url="https://console.anthropic.com/settings/keys" target="_blank">
              console.anthropic.com → API Keys
            </Link>
            {' '}(Default workspace is fine; name it productpipeline). 2. Paste it
            below — it is verified with Anthropic before being saved to this
            app’s credential vault, and is never shown again.
          </>
        )}
      />
      <ConnectionRow
        label="GitHub (incident fix proposals)"
        endpoint="/connections/github"
        placeholder="github_pat_…"
        state={connections?.github ?? null}
        onChanged={setConnections}
        instructions={(
          <>
            1. Create a fine-grained token at{' '}
            <Link url="https://github.com/settings/personal-access-tokens/new" target="_blank">
              github.com → Developer settings → Fine-grained tokens
            </Link>
            : Resource owner chrisbachmaxwell, Only select repositories →
            product-pipeline, Repository permissions → Issues: Read and write.
            2. Paste it below — verified against the repository before saving,
            never shown again.
          </>
        )}
      />
    </>
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
            <ApiConnections />
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
