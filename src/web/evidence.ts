import type {
  MigrationEvidenceSourceProjection,
  MigrationResponsibilityEvidenceProjection,
  MigrationStatusResponse,
} from './hooks/useApi';

export const EVIDENCE_SOURCE_KEYS = [
  'productPipeline',
  'shopify',
  'ebay',
  'marketplaceConnect',
] as const;

export type EvidenceSourceKey = (typeof EVIDENCE_SOURCE_KEYS)[number];

const SOURCE_LABELS: Record<EvidenceSourceKey, string> = {
  productPipeline: 'ProductPipeline local ledger',
  shopify: 'Shopify',
  ebay: 'eBay',
  marketplaceConnect: 'Marketplace Connect',
};

export const RESPONSIBILITY_KEYS = [
  'orderImport',
  'price',
  'inventory',
  'listingLifecycle',
  'mapping',
  'fulfillment',
  'feedback',
] as const;

export type ResponsibilityKey = (typeof RESPONSIBILITY_KEYS)[number];

export const RESPONSIBILITY_LABELS: Record<ResponsibilityKey, string> = {
  orderImport: 'eBay → Shopify orders',
  price: 'Price sync',
  inventory: 'Inventory sync',
  listingLifecycle: 'Listing lifecycle',
  mapping: 'Listing mapping',
  fulfillment: 'Fulfillment',
  feedback: 'Buyer feedback',
};

export interface NormalizedEvidenceSource {
  key: EvidenceSourceKey;
  label: string;
  evidenceClass: string;
  status: string;
  completeness: string;
  freshness: string;
  capturedAt: string | null;
  asOfStart: string | null;
  asOfEnd: string | null;
  recordCount: number | null;
  counts: Record<string, number>;
  digest: string | null;
  limitations: string[];
  critical: boolean;
}

export interface NormalizedResponsibilityEvidence {
  responsibility: ResponsibilityKey;
  label: string;
  acceptedOwner: string;
  evidenceStatus: string;
  observedOwner: string | null;
  capturedAt: string | null;
  summary: string;
  critical: boolean;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const normalizeKey = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, '');

function sourceKeyFrom(value: unknown): EvidenceSourceKey | null {
  if (typeof value !== 'string') return null;
  const normalized = normalizeKey(value);
  if (normalized.includes('marketplaceconnect') || normalized.includes('codisto')) {
    return 'marketplaceConnect';
  }
  if (normalized === 'shopify' || normalized.startsWith('shopifyadmin')) return 'shopify';
  if (normalized === 'ebay' || normalized.startsWith('ebaysell')) return 'ebay';
  if (
    normalized.includes('productpipeline') ||
    normalized.includes('localledger') ||
    normalized === 'local'
  ) {
    return 'productPipeline';
  }
  return null;
}

function safeString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 240) return null;
  if (
    /(?:token|secret|password|credential|authorization|cookie|buyer|customer|email|phone|address|line.?item|raw.?json)/i.test(
      trimmed,
    ) ||
    /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(trimmed) ||
    /(?:Bearer\s+[A-Za-z0-9._~+/-]+=*|shpat_|shpca_|shppa_|sk-[A-Za-z0-9_-]{10,})/i.test(trimmed)
  ) {
    return null;
  }
  return trimmed;
}

function readString(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = safeString(record[key]);
    if (value) return value;
  }
  return null;
}

function stateFrom(value: unknown): string | null {
  if (typeof value === 'boolean') return value ? 'complete' : 'partial';
  const direct = safeString(value);
  if (direct) return direct.toLowerCase();
  if (!isRecord(value)) return null;
  const nested = readString(value, ['status', 'state']);
  if (nested) return nested.toLowerCase();
  if (typeof value.complete === 'boolean') return value.complete ? 'complete' : 'partial';
  return null;
}

function safeCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function safeCounts(value: unknown): Record<string, number> {
  if (!isRecord(value)) return {};
  const result: Record<string, number> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(key)) continue;
    if (/(?:buyer|customer|email|phone|address|credential|token|secret|password)/i.test(key)) {
      continue;
    }
    const count = safeCount(raw);
    if (count !== null) result[key] = count;
  }
  return result;
}

function safeDigest(value: unknown): string | null {
  return typeof value === 'string' && /^sha256:[a-f0-9]{64}$/i.test(value) ? value : null;
}

function safeOwner(value: unknown): string | null {
  const owner = safeString(value);
  if (!owner) return null;
  return ['marketplace-connect', 'product-pipeline', 'shopify', 'ebay', 'unverified', 'unknown']
    .includes(owner.toLowerCase())
    ? owner.toLowerCase()
    : null;
}

function evidenceCandidates(value: unknown): MigrationEvidenceSourceProjection[] {
  if (Array.isArray(value)) {
    return value.filter(isRecord) as MigrationEvidenceSourceProjection[];
  }
  if (!isRecord(value)) return [];
  if ('sources' in value) return evidenceCandidates(value.sources);

  const result: MigrationEvidenceSourceProjection[] = [];
  for (const [key, child] of Object.entries(value)) {
    if (!isRecord(child) || !sourceKeyFrom(key)) continue;
    result.push({ ...child, source: safeString(child.source) ?? key });
  }
  return result;
}

function normalizeSource(
  key: EvidenceSourceKey,
  value: MigrationEvidenceSourceProjection,
): NormalizedEvidenceSource {
  const raw = value as Record<string, unknown>;
  const coverage = isRecord(raw.coverage) ? raw.coverage : {};
  const provenance = isRecord(raw.provenance) ? raw.provenance : {};
  const status = (
    readString(raw, ['status', 'evidenceStatus']) ??
    readString(provenance, ['availability']) ??
    'unavailable'
  ).toLowerCase();
  const provenanceCompleteness =
    readString(provenance, ['availability']) === 'complete' && provenance.paginationComplete === true
      ? 'complete'
      : stateFrom(provenance.availability);
  const completeness =
    stateFrom(raw.completeness) ??
    stateFrom(coverage.status) ??
    stateFrom(coverage.complete) ??
    provenanceCompleteness ??
    'unavailable';
  const freshness = stateFrom(raw.freshness) ?? stateFrom(provenance.freshness) ?? 'unavailable';
  const capturedAt =
    readString(raw, ['capturedAtUtc', 'capturedAt', 'baselineDate']) ??
    readString(provenance, ['capturedAtUtc']);
  const asOfStart =
    readString(raw, ['asOfStartUtc']) ?? readString(provenance, ['asOfStartUtc']);
  const asOfEnd =
    readString(raw, ['asOfUtc', 'asOf', 'asOfDate', 'asOfEndUtc']) ??
    readString(provenance, ['asOfEndUtc']);
  const recordCount =
    safeCount(raw.recordCount) ??
    safeCount(raw.records) ??
    safeCount(coverage.records) ??
    safeCount(provenance.recordCount);
  const digest =
    safeDigest(raw.normalizedPayloadDigest) ??
    safeDigest(raw.evidenceDigest) ??
    safeDigest(raw.digest) ??
    safeDigest(provenance.datasetDigest);
  const limitations = Array.isArray(raw.limitations)
    ? raw.limitations.map(safeString).filter((item): item is string => Boolean(item)).slice(0, 8)
    : [];
  const statusComplete = ['complete', 'verified', 'available'].includes(status);
  const completenessComplete = ['complete', 'verified'].includes(completeness);
  const freshnessCurrent = ['fresh', 'current', 'complete', 'verified'].includes(freshness);

  return {
    key,
    label: SOURCE_LABELS[key],
    evidenceClass:
      readString(raw, ['evidenceClass']) ??
      readString(provenance, ['method', 'attestation']) ??
      'unavailable',
    status,
    completeness,
    freshness,
    capturedAt,
    asOfStart,
    asOfEnd,
    recordCount,
    counts: safeCounts(raw.counts),
    digest,
    limitations,
    critical: !(statusComplete && completenessComplete && freshnessCurrent),
  };
}

function unavailableSource(key: EvidenceSourceKey): NormalizedEvidenceSource {
  return {
    key,
    label: SOURCE_LABELS[key],
    evidenceClass: 'unavailable',
    status: 'unavailable',
    completeness: 'unavailable',
    freshness: 'unavailable',
    capturedAt: null,
    asOfStart: null,
    asOfEnd: null,
    recordCount: null,
    counts: {},
    digest: null,
    limitations: ['No source-capture evidence was supplied by the read-only status response.'],
    critical: true,
  };
}

/**
 * Project additive server evidence into four fixed, redacted source cards. A
 * missing source is always critical; response-serving timestamps are never
 * substituted for source capture time.
 */
export function normalizeEvidenceSources(
  status: MigrationStatusResponse | undefined,
): NormalizedEvidenceSource[] {
  const byKey = new Map<EvidenceSourceKey, MigrationEvidenceSourceProjection>();
  for (const candidate of evidenceCandidates(status?.evidence)) {
    const key =
      sourceKeyFrom(candidate.system) ??
      sourceKeyFrom(candidate.sourceId) ??
      sourceKeyFrom(candidate.source) ??
      sourceKeyFrom(candidate.label);
    if (key && !byKey.has(key)) byKey.set(key, candidate);
  }

  return EVIDENCE_SOURCE_KEYS.map((key) => {
    const supplied = byKey.get(key);
    if (supplied) return normalizeSource(key, supplied);

    if (key === 'productPipeline' && status?.reconciliation) {
      return {
        ...unavailableSource(key),
        evidenceClass: 'local-ledger-observation',
        status: 'partial',
        completeness: 'partial',
        counts: safeCounts(status.reconciliation.counts),
        limitations: [
          'Local counts have no source-capture timestamp, digest, or completeness proof.',
          'The ProductPipeline ledger is not authoritative Shopify or eBay state.',
        ],
      };
    }

    if (key === 'marketplaceConnect') {
      return {
        ...unavailableSource(key),
        evidenceClass: 'operator-attested-browser-observation',
        status: 'partial',
        completeness: 'partial',
        freshness: 'stale',
        capturedAt: '2026-08-11',
        limitations: [
          'Browser-observed baseline only: order import, price sync, and inventory sync were enabled.',
          'No current authoritative cross-platform parity evidence is available.',
        ],
      };
    }

    return unavailableSource(key);
  });
}

function responsibilityCandidates(
  value: MigrationStatusResponse['responsibilityEvidence'],
): MigrationResponsibilityEvidenceProjection[] {
  if (Array.isArray(value)) return value.filter(isRecord);
  if (!isRecord(value)) return [];
  return Object.entries(value)
    .filter(([, child]) => isRecord(child))
    .map(([responsibility, child]) => ({
      ...(child as MigrationResponsibilityEvidenceProjection),
      responsibility:
        safeString((child as MigrationResponsibilityEvidenceProjection).responsibility) ?? responsibility,
    }));
}

export function normalizeResponsibilityEvidence(
  status: MigrationStatusResponse | undefined,
): NormalizedResponsibilityEvidence[] {
  const supplied = new Map<string, MigrationResponsibilityEvidenceProjection>();
  for (const item of responsibilityCandidates(status?.responsibilityEvidence)) {
    const responsibility = safeString(item.responsibility);
    if (responsibility) supplied.set(responsibility, item);
  }

  return RESPONSIBILITY_KEYS.map((responsibility) => {
    const policy = status?.responsibilities?.find((item) => item.responsibility === responsibility);
    const evidence = supplied.get(responsibility);
    const evidenceStatus = (
      safeString(evidence?.evidenceStatus) ??
      safeString(evidence?.status) ??
      (['orderImport', 'price', 'inventory'].includes(responsibility)
        ? 'historical-baseline-only'
        : 'unverified')
    ).toLowerCase();
    const baselineResponsibility = ['orderImport', 'price', 'inventory'].includes(responsibility);
    const capturedAt =
      evidence?.capturedAtUtc ??
      evidence?.asOfUtc ??
      evidence?.baselineDate ??
      (baselineResponsibility ? '2026-08-11' : null);
    const summary = safeString(evidence?.summary) ?? (
      baselineResponsibility
        ? 'Marketplace Connect was browser-observed for this responsibility on 2026-08-11; current authoritative parity is unavailable.'
        : 'The current production owner and authoritative parity evidence remain unverified.'
    );

    return {
      responsibility,
      label: RESPONSIBILITY_LABELS[responsibility],
      acceptedOwner:
        safeOwner(policy?.owner) ?? (baselineResponsibility ? 'marketplace-connect' : 'unverified'),
      evidenceStatus,
      observedOwner:
        safeOwner(evidence?.observedOwner) ?? (baselineResponsibility ? 'marketplace-connect' : null),
      capturedAt,
      summary,
      critical: !['complete', 'verified', 'current'].includes(evidenceStatus),
    };
  });
}

export function formatEvidenceTime(value: string | null | undefined): string {
  if (!value) return 'Not supplied';
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return `${value} (date-only)`;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? 'Not supplied' : parsed.toLocaleString();
}

export function booleanPolicyState(
  value: boolean | undefined,
  labels: { safe: string; unsafe: string },
  safeValue = false,
): { label: string; tone: 'success' | 'critical' } {
  if (typeof value !== 'boolean') return { label: 'Unavailable', tone: 'critical' };
  return value === safeValue
    ? { label: labels.safe, tone: 'success' }
    : { label: labels.unsafe, tone: 'critical' };
}
