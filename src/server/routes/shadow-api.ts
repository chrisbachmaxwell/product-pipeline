import { Router, type Request, type Response } from 'express';
import { openShadowDatabase } from '../shadow-db.js';
import { migrationStatusHandler } from './migration.js';
import {
  readAuthoritativeListingsPage,
  type AuthoritativeListingStatus,
} from '../authoritative-listings-reader.js';

const router = Router();

export const SHADOW_API_GET_PATHS = Object.freeze([
  '/api/migration/status',
  '/api/authoritative-listings',
  '/api/listings',
  '/api/capabilities',
] as const);

export type LocalListingProjection = {
  id: number | string;
  shopify_product_id: string;
  ebay_listing_id: string;
  status: string | null;
  shopify_title: string | null;
  shopify_sku: string | null;
  shopify_price: number | null;
  original_price: number | null;
  updated_at: number | string;
};

/** Keep browser responses narrower than the legacy product_mappings record. */
export function projectLocalListing(row: Record<string, unknown>): LocalListingProjection {
  return {
    id: row.id as number | string,
    shopify_product_id: String(row.shopify_product_id ?? ''),
    ebay_listing_id: String(row.ebay_listing_id ?? ''),
    status: row.status == null ? null : String(row.status),
    shopify_title: row.shopify_title == null ? null : String(row.shopify_title),
    shopify_sku: row.shopify_sku == null ? null : String(row.shopify_sku),
    shopify_price: typeof row.shopify_price === 'number' ? row.shopify_price : null,
    original_price: typeof row.original_price === 'number' ? row.original_price : null,
    updated_at: row.updated_at as number | string,
  };
}

function boundedInteger(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const parsed = typeof value === 'string' ? Number.parseInt(value, 10) : Number.NaN;
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, minimum), maximum);
}

router.use((_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});

router.get('/api/migration/status', migrationStatusHandler);

/** GET /api/authoritative-listings — verified, deployable evidence snapshots only. */
router.get('/api/authoritative-listings', (req: Request, res: Response) => {
  const rawStatus = String(req.query.status ?? '').trim().toLowerCase();
  const allowedStatuses = new Set<AuthoritativeListingStatus>([
    'attention', 'ready', 'active', 'ended',
  ]);
  if (rawStatus && !allowedStatuses.has(rawStatus as AuthoritativeListingStatus)) {
    res.status(400).json({ error: 'Invalid listing status filter' });
    return;
  }

  try {
    const limit = boundedInteger(req.query.limit, 50, 1, 100);
    const offset = boundedInteger(req.query.offset, 0, 0, 1_000_000);
    const search = String(req.query.search ?? '').trim().slice(0, 200);
    res.json(readAuthoritativeListingsPage({
      limit,
      offset,
      search,
      status: rawStatus ? rawStatus as AuthoritativeListingStatus : undefined,
    }));
  } catch {
    res.status(503).json({ error: 'Verified listing evidence is unavailable' });
  }
});

/** GET /api/listings — projected local observations only; no platform reader. */
router.get('/api/listings', async (req: Request, res: Response) => {
  try {
    const db = openShadowDatabase();
    try {
      const limit = boundedInteger(req.query.limit, 50, 1, 200);
      const offset = boundedInteger(req.query.offset, 0, 0, 1_000_000);
      const search = String(req.query.search ?? '').trim().slice(0, 200);
      const statuses = String(req.query.status ?? '')
        .split(',')
        .map((status) => status.trim().toLowerCase())
        .filter((status) => /^[a-z0-9_-]{1,32}$/.test(status))
        .slice(0, 10);

      const conditions: string[] = [];
      const params: Array<string | number> = [];

      if (statuses.length > 0) {
        conditions.push(`status IN (${statuses.map(() => '?').join(',')})`);
        params.push(...statuses);
      }

      if (search) {
        conditions.push(
          '(shopify_title LIKE ? OR shopify_sku LIKE ? OR shopify_product_id LIKE ? OR ebay_listing_id LIKE ?)',
        );
        const pattern = `%${search}%`;
        params.push(pattern, pattern, pattern, pattern);
      }

      const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
      const total = (
        db.prepare(`SELECT COUNT(*) AS count FROM product_mappings ${where}`).get(...params) as
          | { count?: number }
          | undefined
      )?.count ?? 0;
      const rows = db.prepare(
        `SELECT
           id,
           shopify_product_id,
           ebay_listing_id,
           status,
           shopify_title,
           shopify_sku,
           shopify_price,
           original_price,
           updated_at
         FROM product_mappings
         ${where}
         ORDER BY id DESC
         LIMIT ? OFFSET ?`,
      ).all(...params, limit, offset) as Array<Record<string, unknown>>;

      res.json({
        data: rows.map(projectLocalListing),
        total,
        limit,
        offset,
        source: 'product-pipeline-local-ledger',
        authoritative: false,
        remoteReadPerformed: false,
      });
    } finally {
      db.close();
    }
  } catch {
    res.status(500).json({ error: 'Local listing observations are unavailable' });
  }
});

router.get('/api/capabilities', (_req: Request, res: Response) => {
  res.json({
    status: 'shadow-read-only',
    dataCapabilities: [
      {
        id: 'migration-status',
        method: 'GET',
        endpoint: '/api/migration/status',
        remoteRead: false,
      },
      {
        id: 'authoritative-listings',
        method: 'GET',
        endpoint: '/api/authoritative-listings',
        remoteRead: false,
        externalWrite: false,
        evidenceKind: 'verified_snapshot',
      },
      {
        id: 'local-listings',
        method: 'GET',
        endpoint: '/api/listings',
        remoteRead: false,
      },
    ],
    mutationCapabilities: [],
    mountedApiGetRoutes: [...SHADOW_API_GET_PATHS],
    legacyApiRoutesMounted: false,
    remoteReadersMounted: false,
    productionOperatorApiKeyAllowed: false,
  });
});

export default router;
