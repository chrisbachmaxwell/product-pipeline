import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { MigrationStatusResponse } from './hooks/useApi';
import { durableMigrationStateView } from './migration-state';

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)));

function statusWithMigrationState(
  migrationState: NonNullable<MigrationStatusResponse['migrationState']>,
): MigrationStatusResponse {
  return {
    externalWritesAllowed: false,
    historicalBackfillAllowed: false,
    cutoverWatermarkUtc: null,
    migrationState,
  };
}

describe('durable migration-state browser projection', () => {
  it('treats missing, not-configured, and invalid local state as unavailable and non-authorizing', () => {
    expect(durableMigrationStateView(undefined)).toMatchObject({
      available: false,
      statusLabel: 'Unavailable',
      eligibleOrderCount: 0,
      canaryAuthorized: false,
      cutoverAuthorized: false,
    });

    const notConfigured = durableMigrationStateView(statusWithMigrationState({
      status: 'not-configured',
    }));
    expect(notConfigured).toMatchObject({
      available: false,
      statusLabel: 'Not configured',
      counts: {},
      eligibleOrderCount: 0,
    });

    const invalid = durableMigrationStateView(statusWithMigrationState({
      status: 'invalid',
      counts: { orderObservations: 99 },
      audit: { valid: true },
    }));
    expect(invalid).toMatchObject({
      available: false,
      statusLabel: 'Unavailable',
      counts: {},
      eligibleOrderCount: 0,
    });
  });

  it('labels only an exact inert, audit-valid projection as verified local state', () => {
    const response = statusWithMigrationState({
      status: 'verified',
      access: {
        writable: false,
        readOnly: true,
        externallyWired: false,
        externalWritesSupported: false,
        historicalBackfillAllowed: false,
      },
      counts: {
        externalIdentities: 2,
        orderObservations: 3,
        unsafe_key: 4,
        negative: -1,
        fractional: 1.5,
      },
      audit: { valid: true, recordCount: 1 },
      readiness: { canaryReady: false, cutoverReady: false, blockers: ['blocked'] },
    });

    expect(durableMigrationStateView(response)).toEqual({
      available: true,
      statusLabel: 'Verified local state',
      counts: { externalIdentities: 2, orderObservations: 3 },
      eligibleOrderCount: 0,
      canaryAuthorized: false,
      cutoverAuthorized: false,
      locallyVerified: true,
    });

    response.migrationState!.readiness!.canaryReady = true;
    expect(durableMigrationStateView(response)).toMatchObject({
      available: false,
      statusLabel: 'Unavailable',
      eligibleOrderCount: 0,
      canaryAuthorized: false,
    });
  });

  it('keeps one five-page operator surface without adding a commerce mutation', async () => {
    const pageFiles = [
      'pages/Dashboard.tsx',
      'pages/Listings.tsx',
      'pages/Orders.tsx',
      'pages/Issues.tsx',
      'pages/Settings.tsx',
    ] as const;
    const pages = await Promise.all(
      pageFiles.map((filename) => fs.readFile(path.join(webRoot, filename), 'utf8')),
    );
    const [component, app] = await Promise.all([
      fs.readFile(path.join(webRoot, 'components/DurableMigrationState.tsx'), 'utf8'),
      fs.readFile(path.join(webRoot, 'App.tsx'), 'utf8'),
    ]);

    for (const source of pages) {
      expect(source).not.toMatch(/useMutation|apiClient\.(?:post|put|delete)|\bfetch\s*\(/);
      expect(source).not.toMatch(/secondaryActions=/);
    }

    expect(component).toMatch(/not authoritative\s+Shopify, eBay, or Marketplace Connect truth/);
    expect(component).toMatch(/Eligible orders[\s\S]*<Badge tone="info">0<\/Badge>/);
    expect(component).toMatch(/Canary authorized[\s\S]*<Badge tone="critical">No<\/Badge>/);
    expect(component).toMatch(/Cutover authorized[\s\S]*<Badge tone="critical">No<\/Badge>/);
    expect(component).not.toMatch(/\bButton\b|onAction=|useMutation|apiClient|\bfetch\s*\(/);
    expect(component).not.toMatch(/ebaySellerId/);

    const routePaths = [...app.matchAll(/<Route path="([^"]+)"/g)].map((match) => match[1]);
    expect(routePaths).toEqual([
      '/',
      '/listings',
      '/listings/:id',
      '/orders',
      '/issues',
      '/reconciliation',
      '/settings',
      '*',
    ]);
  });
});
