import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_RECONCILIATION_SNAPSHOT_BYTES,
  parseReconciliationSnapshot,
  ReconciliationSnapshotError,
  runSnapshotReconciliation,
  type ReconciliationSnapshot,
} from '../reconciliation.js';
import { validConfig, validReconciliationSnapshot } from './fixtures.js';

const temporaryDirectories: string[] = [];

async function tempRepo(snapshot = validReconciliationSnapshot()): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'product-pipeline-reconciliation-'));
  temporaryDirectories.push(root);
  await fs.mkdir(path.join(root, '.git'));
  await fs.mkdir(path.join(root, 'config'));
  await fs.mkdir(path.join(root, '.local/operator-reconciliation'), { recursive: true });
  await fs.writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'product-pipeline', type: 'module' }),
  );
  await fs.writeFile(path.join(root, 'config/operator.json'), JSON.stringify(validConfig()));
  await fs.writeFile(
    path.join(root, '.local/operator-reconciliation/snapshot.json'),
    JSON.stringify(snapshot),
  );
  return root;
}

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      fs.rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe('snapshot reconciliation', () => {
  it('compares consistent redacted snapshots without network or application database access', async () => {
    const root = await tempRepo();
    const snapshotPath = path.join(root, '.local/operator-reconciliation/snapshot.json');
    const before = await fs.readFile(snapshotPath, 'utf8');
    const databaseSentinel = path.join(root, 'application-database-must-not-exist.db');
    const previousDatabasePath = process.env.DATABASE_PATH;
    process.env.DATABASE_PATH = databaseSentinel;
    const fetchSpy = vi.fn(() => {
      throw new Error('network access is forbidden');
    });
    vi.stubGlobal('fetch', fetchSpy);

    const result = await (async () => {
      try {
        return await runSnapshotReconciliation({
          repoRoot: root,
          configPath: 'config/operator.json',
          snapshotPath: '.local/operator-reconciliation/snapshot.json',
          now: () => new Date('2026-08-11T16:01:00.000Z'),
          createRunId: () => 'reconcile-run',
        });
      } finally {
        if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
        else process.env.DATABASE_PATH = previousDatabasePath;
      }
    })();

    expect(result.status).toBe('consistent-with-supplied-snapshots');
    expect(result.discrepancies).toEqual([]);
    expect(result.guarantees).toEqual({
      liveProof: false,
      productionParity: false,
      externalNetworkAccess: false,
      externalWrites: 0,
      applicationDatabaseAccess: false,
      historicalBackfill: false,
      orderCreationEligible: false,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    await expect(fs.stat(databaseSentinel)).rejects.toThrow();
    expect(await fs.readFile(snapshotPath, 'utf8')).toBe(before);
  });

  it('assigns price and inventory observations to Marketplace Connect without suggesting writes', async () => {
    const base = validReconciliationSnapshot();
    const root = await tempRepo({
      ...base,
      ebay: {
        ...base.ebay,
        listings: [{ ...base.ebay.listings[0], priceMinor: 12000, availableQuantity: 0 }],
      },
    });

    const result = await runSnapshotReconciliation({
      repoRoot: root,
      configPath: 'config/operator.json',
      snapshotPath: '.local/operator-reconciliation/snapshot.json',
      now: () => new Date('2026-08-11T16:01:00.000Z'),
    });

    expect(result.status).toBe('exceptions-found');
    expect(result.discrepancies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'price.observed-difference',
          owner: 'marketplace-connect',
          responsibility: 'price',
        }),
        expect.objectContaining({
          code: 'inventory.observed-difference',
          owner: 'marketplace-connect',
          responsibility: 'inventory',
        }),
      ]),
    );
    expect(JSON.stringify(result)).not.toMatch(/desiredAction|apply|updateRemote/);
    expect(result.guarantees.externalWrites).toBe(0);
  });

  it('detects duplicate Shopify links for one eBay order as critical', async () => {
    const base = validReconciliationSnapshot();
    const root = await tempRepo({
      ...base,
      shopify: {
        ...base.shopify,
        orders: [
          ...base.shopify.orders,
          {
            ...base.shopify.orders[0],
            shopifyOrderGid: 'gid://shopify/Order/302',
          },
        ],
      },
    });

    const result = await runSnapshotReconciliation({
      repoRoot: root,
      configPath: 'config/operator.json',
      snapshotPath: '.local/operator-reconciliation/snapshot.json',
      now: () => new Date('2026-08-11T16:01:00.000Z'),
    });

    expect(result.discrepancies).toContainEqual(
      expect.objectContaining({
        code: 'order.duplicate-shopify-links',
        severity: 'critical',
        owner: 'marketplace-connect',
      }),
    );
  });

  it('treats an unlinked eBay order only as an incumbent-owned exception', async () => {
    const base = validReconciliationSnapshot();
    const root = await tempRepo({
      ...base,
      productPipeline: { ...base.productPipeline, orders: [] },
      shopify: { ...base.shopify, orders: [] },
    });

    const result = await runSnapshotReconciliation({
      repoRoot: root,
      configPath: 'config/operator.json',
      snapshotPath: '.local/operator-reconciliation/snapshot.json',
      now: () => new Date('2026-08-11T16:01:00.000Z'),
    });

    expect(result.discrepancies).toContainEqual(
      expect.objectContaining({
        code: 'order.no-shopify-link-observed',
        owner: 'marketplace-connect',
      }),
    );
    expect(result.guarantees.orderCreationEligible).toBe(false);
    expect(result.guarantees.historicalBackfill).toBe(false);
    expect(JSON.stringify(result)).not.toMatch(/"orderCreationEligible":true|"desiredAction"/i);
    expect(
      result.discrepancies.find((item) => item.code === 'order.no-shopify-link-observed')?.summary,
    ).toContain('never an import candidate');
  });

  it('denies identity mismatches and records only the configured identity', async () => {
    const base = validReconciliationSnapshot();
    const root = await tempRepo({
      ...base,
      identities: { ...base.identities, ebaySellerAccount: 'different-seller' },
    });

    await expect(
      runSnapshotReconciliation({
        repoRoot: root,
        configPath: 'config/operator.json',
        snapshotPath: '.local/operator-reconciliation/snapshot.json',
      }),
    ).rejects.toThrow(/identity does not match/);

    const auditText = await fs.readFile(
      path.join(root, '.local/operator-audit/operator-cli.jsonl'),
      'utf8',
    );
    expect(auditText).toContain('reconciliation.identity-mismatch');
    expect(auditText).not.toContain('different-seller');
  });

  it('rejects personal-data and secret-like fields without echoing their values', () => {
    const base = validReconciliationSnapshot();
    const privateValue = 'private-person-value';
    const withPrivateData = {
      ...base,
      ebay: {
        ...base.ebay,
        orders: [{ ...base.ebay.orders[0], buyerUsername: privateValue }],
      },
    };

    expect(() => parseReconciliationSnapshot(withPrivateData)).toThrow(
      ReconciliationSnapshotError,
    );
    try {
      parseReconciliationSnapshot(withPrivateData);
    } catch (error) {
      expect((error as Error).message).toContain('buyerUsername');
      expect((error as Error).message).not.toContain(privateValue);
    }
  });

  it('requires a regular snapshot beneath the fixed ignored directory', async () => {
    const root = await tempRepo();
    await fs.writeFile(
      path.join(root, 'outside.json'),
      JSON.stringify(validReconciliationSnapshot()),
    );

    await expect(
      runSnapshotReconciliation({
        repoRoot: root,
        configPath: 'config/operator.json',
        snapshotPath: 'outside.json',
      }),
    ).rejects.toThrow(/beneath \.local\/operator-reconciliation/);

    const outside = path.join(root, 'outside.json');
    const link = path.join(root, '.local/operator-reconciliation/link.json');
    await fs.symlink(outside, link);
    await expect(
      runSnapshotReconciliation({
        repoRoot: root,
        configPath: 'config/operator.json',
        snapshotPath: '.local/operator-reconciliation/link.json',
      }),
    ).rejects.toThrow(/regular, non-symlink/);
  });

  it('rejects an oversized snapshot before parsing it', async () => {
    const root = await tempRepo();
    await fs.writeFile(
      path.join(root, '.local/operator-reconciliation/oversized.json'),
      'x'.repeat(MAX_RECONCILIATION_SNAPSHOT_BYTES + 1),
    );

    await expect(
      runSnapshotReconciliation({
        repoRoot: root,
        configPath: 'config/operator.json',
        snapshotPath: '.local/operator-reconciliation/oversized.json',
      }),
    ).rejects.toThrow(/byte limit/);
  });

  it('records only digests and check IDs in the audit event', async () => {
    const root = await tempRepo();
    const result = await runSnapshotReconciliation({
      repoRoot: root,
      configPath: 'config/operator.json',
      snapshotPath: '.local/operator-reconciliation/snapshot.json',
      now: () => new Date('2026-08-11T16:01:00.000Z'),
      createRunId: () => 'audit-reconcile-run',
    });
    const auditText = await fs.readFile(
      path.join(root, '.local/operator-audit/operator-cli.jsonl'),
      'utf8',
    );

    expect(auditText).toContain(result.snapshot.digest.slice('sha256:'.length));
    expect(auditText).toContain(result.resultDigest.slice('sha256:'.length));
    expect(auditText).not.toContain('SAFE-SKU-001');
    expect(auditText).not.toContain('EBAY-ORDER-001');
    expect(auditText).not.toContain('LISTING-001');
  });

  it('blocks stale supplied evidence without turning it into live proof', async () => {
    const root = await tempRepo();
    const result = await runSnapshotReconciliation({
      repoRoot: root,
      configPath: 'config/operator.json',
      snapshotPath: '.local/operator-reconciliation/snapshot.json',
      now: () => new Date('2026-08-13T16:01:00.000Z'),
    });

    expect(result.discrepancies).toContainEqual(
      expect.objectContaining({ code: 'snapshot.stale' }),
    );
    expect(result.guarantees.liveProof).toBe(false);
    expect(result.guarantees.productionParity).toBe(false);
  });
});
