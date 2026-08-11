import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export const RESPONSIBILITIES = [
  'listingCreate',
  'listingRevise',
  'listingEndRelist',
  'mapping',
  'price',
  'inventory',
  'orderImport',
  'fulfillment',
  'feedback',
  'reconciliation',
] as const;

export type Responsibility = (typeof RESPONSIBILITIES)[number];
export type OperatorLane = 'development' | 'sandbox' | 'production-shadow';
export type EbayEnvironment = 'sandbox' | 'production';
export const OPERATOR_AUDIT_LOG_PATH = '.local/operator-audit/operator-cli.jsonl';
export type CurrentOwner =
  | 'marketplace-connect'
  | 'manual'
  | 'paused'
  | 'product-pipeline'
  | 'unverified';

export type ResponsibilityOwnership = {
  currentOwner: CurrentOwner;
  productPipelineAccess: 'disabled' | 'read-only';
};

export type OperatorConfig = {
  schemaVersion: 1;
  project: 'product-pipeline';
  lane: OperatorLane;
  mode: 'read-only';
  dryRun: true;
  writesEnabled: false;
  identities: {
    shopifyStoreDomain: string;
    ebayEnvironment: EbayEnvironment;
    ebaySellerAccount: string;
    marketplaceConnectAccount: string | null;
  };
  ownership: Record<Responsibility, ResponsibilityOwnership>;
  orders: {
    importEnabled: false;
    historicalBackfill: false;
    cutoverWatermarkUtc: null;
  };
  testLane: {
    shopifyVariantGids: string[];
    skus: string[];
    ebayListingIds: string[];
    responsibilities: Responsibility[];
  };
  audit: {
    logPath: string;
  };
};

export type LoadedOperatorConfig = {
  config: OperatorConfig;
  configPath: string;
  digest: string;
};

export class ConfigValidationError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(`Operator config denied: ${issues.join('; ')}`);
    this.name = 'ConfigValidationError';
    this.issues = issues;
  }
}

const ROOT_KEYS = [
  'schemaVersion',
  'project',
  'lane',
  'mode',
  'dryRun',
  'writesEnabled',
  'identities',
  'ownership',
  'orders',
  'testLane',
  'audit',
] as const;

const SENSITIVE_KEY_PATTERN =
  /(?:token|secret|password|credential|api[_-]?key|client[_-]?secret|access[_-]?token|refresh[_-]?token|private[_-]?key|authorization|cookie)/i;
const SENSITIVE_VALUE_PATTERN = /^(?:Bearer\s+|shpat_|shpca_|shppa_|gh[pousr]_|sk-[A-Za-z0-9_-]{10,}|v\^1\.)/i;
const WILDCARD_PATTERN = /[*?\[\]{}]/;
const STORE_DOMAIN_PATTERN = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;
const ACCOUNT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{1,79}$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Cannot canonicalize a non-finite number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  }
  throw new Error('Cannot canonicalize an unsupported value');
}

export function sha256Digest(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
}

function findSensitiveMaterial(value: unknown, fieldPath: string, issues: string[]): void {
  if (typeof value === 'string') {
    if (SENSITIVE_VALUE_PATTERN.test(value.trim())) {
      issues.push(`${fieldPath} contains credential-like material`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => findSensitiveMaterial(item, `${fieldPath}[${index}]`, issues));
    return;
  }
  if (!isRecord(value)) return;

  for (const [key, child] of Object.entries(value)) {
    const childPath = fieldPath ? `${fieldPath}.${key}` : key;
    if (SENSITIVE_KEY_PATTERN.test(key)) {
      issues.push(`${childPath} is a forbidden credential-like field`);
      continue;
    }
    findSensitiveMaterial(child, childPath, issues);
  }
}

function requireRecord(
  value: unknown,
  fieldPath: string,
  issues: string[],
): Record<string, unknown> | undefined {
  if (!isRecord(value)) {
    issues.push(`${fieldPath} must be an object`);
    return undefined;
  }
  return value;
}

function requireExactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  fieldPath: string,
  issues: string[],
): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) issues.push(`${fieldPath}.${key} is not supported`);
  }
  for (const key of allowed) {
    if (!Object.hasOwn(value, key)) issues.push(`${fieldPath}.${key} is required`);
  }
}

function requireLiteral<T extends string | number | boolean | null>(
  value: unknown,
  expected: T,
  fieldPath: string,
  issues: string[],
): T | undefined {
  if (value !== expected) {
    issues.push(`${fieldPath} must be ${JSON.stringify(expected)}`);
    return undefined;
  }
  return expected;
}

function requireEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fieldPath: string,
  issues: string[],
): T | undefined {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    issues.push(`${fieldPath} must be one of: ${allowed.join(', ')}`);
    return undefined;
  }
  return value as T;
}

function requireIdentity(
  value: unknown,
  pattern: RegExp,
  fieldPath: string,
  issues: string[],
): string | undefined {
  if (typeof value !== 'string' || !pattern.test(value)) {
    issues.push(`${fieldPath} is missing or malformed`);
    return undefined;
  }
  return value;
}

function requireOptionalIdentity(
  value: unknown,
  pattern: RegExp,
  fieldPath: string,
  issues: string[],
): string | null | undefined {
  if (value === null) return null;
  return requireIdentity(value, pattern, fieldPath, issues);
}

function requireExactStringArray(
  value: unknown,
  fieldPath: string,
  issues: string[],
): string[] | undefined {
  if (!Array.isArray(value)) {
    issues.push(`${fieldPath} must be an array`);
    return undefined;
  }

  const result: string[] = [];
  const seen = new Set<string>();
  value.forEach((item, index) => {
    if (typeof item !== 'string' || item.trim() === '') {
      issues.push(`${fieldPath}[${index}] must be a non-empty string`);
      return;
    }
    const normalized = item.trim();
    if (WILDCARD_PATTERN.test(normalized)) {
      issues.push(`${fieldPath}[${index}] must be an exact value without wildcards`);
      return;
    }
    if (seen.has(normalized)) {
      issues.push(`${fieldPath}[${index}] duplicates an earlier value`);
      return;
    }
    seen.add(normalized);
    result.push(normalized);
  });
  return result;
}

function requireResponsibilities(
  value: unknown,
  fieldPath: string,
  issues: string[],
): Responsibility[] | undefined {
  const values = requireExactStringArray(value, fieldPath, issues);
  if (!values) return undefined;
  const result: Responsibility[] = [];
  values.forEach((item, index) => {
    if (!RESPONSIBILITIES.includes(item as Responsibility)) {
      issues.push(`${fieldPath}[${index}] is not a supported responsibility`);
      return;
    }
    result.push(item as Responsibility);
  });
  return result;
}

function validateRelativeAuditPath(value: unknown, issues: string[]): string | undefined {
  if (typeof value !== 'string' || value.trim() === '') {
    issues.push('config.audit.logPath must be a non-empty repository-relative path');
    return undefined;
  }
  const normalized = path.normalize(value.trim());
  if (normalized !== OPERATOR_AUDIT_LOG_PATH) {
    issues.push(`config.audit.logPath must be exactly ${OPERATOR_AUDIT_LOG_PATH}`);
    return undefined;
  }
  return normalized;
}

export function parseOperatorConfig(value: unknown): OperatorConfig {
  const issues: string[] = [];
  findSensitiveMaterial(value, 'config', issues);
  const root = requireRecord(value, 'config', issues);
  if (!root) throw new ConfigValidationError(issues);
  requireExactKeys(root, ROOT_KEYS, 'config', issues);

  const schemaVersion = requireLiteral(root.schemaVersion, 1, 'config.schemaVersion', issues);
  const project = requireLiteral(root.project, 'product-pipeline', 'config.project', issues);
  const lane = requireEnum(
    root.lane,
    ['development', 'sandbox', 'production-shadow'] as const,
    'config.lane',
    issues,
  );
  const mode = requireLiteral(root.mode, 'read-only', 'config.mode', issues);
  const dryRun = requireLiteral(root.dryRun, true, 'config.dryRun', issues);
  const writesEnabled = requireLiteral(
    root.writesEnabled,
    false,
    'config.writesEnabled',
    issues,
  );

  const identitiesValue = requireRecord(root.identities, 'config.identities', issues);
  let identities: OperatorConfig['identities'] | undefined;
  if (identitiesValue) {
    requireExactKeys(
      identitiesValue,
      [
        'shopifyStoreDomain',
        'ebayEnvironment',
        'ebaySellerAccount',
        'marketplaceConnectAccount',
      ],
      'config.identities',
      issues,
    );
    const shopifyStoreDomain = requireIdentity(
      identitiesValue.shopifyStoreDomain,
      STORE_DOMAIN_PATTERN,
      'config.identities.shopifyStoreDomain',
      issues,
    );
    const ebayEnvironment = requireEnum(
      identitiesValue.ebayEnvironment,
      ['sandbox', 'production'] as const,
      'config.identities.ebayEnvironment',
      issues,
    );
    const ebaySellerAccount = requireIdentity(
      identitiesValue.ebaySellerAccount,
      ACCOUNT_PATTERN,
      'config.identities.ebaySellerAccount',
      issues,
    );
    const marketplaceConnectAccount = requireOptionalIdentity(
      identitiesValue.marketplaceConnectAccount,
      ACCOUNT_PATTERN,
      'config.identities.marketplaceConnectAccount',
      issues,
    );
    if (
      shopifyStoreDomain &&
      ebayEnvironment &&
      ebaySellerAccount &&
      marketplaceConnectAccount !== undefined
    ) {
      identities = {
        shopifyStoreDomain,
        ebayEnvironment,
        ebaySellerAccount,
        marketplaceConnectAccount,
      };
    }
  }

  const ownershipValue = requireRecord(root.ownership, 'config.ownership', issues);
  const ownership = {} as Record<Responsibility, ResponsibilityOwnership>;
  if (ownershipValue) {
    requireExactKeys(ownershipValue, RESPONSIBILITIES, 'config.ownership', issues);
    for (const responsibility of RESPONSIBILITIES) {
      const entry = requireRecord(
        ownershipValue[responsibility],
        `config.ownership.${responsibility}`,
        issues,
      );
      if (!entry) continue;
      requireExactKeys(
        entry,
        ['currentOwner', 'productPipelineAccess'],
        `config.ownership.${responsibility}`,
        issues,
      );
      const currentOwner = requireEnum(
        entry.currentOwner,
        ['marketplace-connect', 'manual', 'paused', 'product-pipeline', 'unverified'] as const,
        `config.ownership.${responsibility}.currentOwner`,
        issues,
      );
      const productPipelineAccess = requireEnum(
        entry.productPipelineAccess,
        ['disabled', 'read-only'] as const,
        `config.ownership.${responsibility}.productPipelineAccess`,
        issues,
      );
      if (currentOwner === 'product-pipeline' && responsibility !== 'reconciliation') {
        issues.push(
          `config.ownership.${responsibility}.currentOwner cannot be product-pipeline in shadow mode`,
        );
      }
      if (currentOwner === 'product-pipeline' && productPipelineAccess === 'disabled') {
        issues.push(
          `config.ownership.${responsibility}.productPipelineAccess cannot be disabled when product-pipeline is the current owner`,
        );
      }
      if (currentOwner && productPipelineAccess) {
        ownership[responsibility] = { currentOwner, productPipelineAccess };
      }
    }
  }

  const ordersValue = requireRecord(root.orders, 'config.orders', issues);
  let orders: OperatorConfig['orders'] | undefined;
  if (ordersValue) {
    requireExactKeys(
      ordersValue,
      ['importEnabled', 'historicalBackfill', 'cutoverWatermarkUtc'],
      'config.orders',
      issues,
    );
    const importEnabled = requireLiteral(
      ordersValue.importEnabled,
      false,
      'config.orders.importEnabled',
      issues,
    );
    const historicalBackfill = requireLiteral(
      ordersValue.historicalBackfill,
      false,
      'config.orders.historicalBackfill',
      issues,
    );
    const cutoverWatermarkUtc = requireLiteral(
      ordersValue.cutoverWatermarkUtc,
      null,
      'config.orders.cutoverWatermarkUtc',
      issues,
    );
    if (
      importEnabled === false &&
      historicalBackfill === false &&
      cutoverWatermarkUtc === null
    ) {
      orders = { importEnabled, historicalBackfill, cutoverWatermarkUtc };
    }
  }

  const testLaneValue = requireRecord(root.testLane, 'config.testLane', issues);
  let testLane: OperatorConfig['testLane'] | undefined;
  if (testLaneValue) {
    requireExactKeys(
      testLaneValue,
      ['shopifyVariantGids', 'skus', 'ebayListingIds', 'responsibilities'],
      'config.testLane',
      issues,
    );
    const shopifyVariantGids = requireExactStringArray(
      testLaneValue.shopifyVariantGids,
      'config.testLane.shopifyVariantGids',
      issues,
    );
    const skus = requireExactStringArray(testLaneValue.skus, 'config.testLane.skus', issues);
    const ebayListingIds = requireExactStringArray(
      testLaneValue.ebayListingIds,
      'config.testLane.ebayListingIds',
      issues,
    );
    const responsibilities = requireResponsibilities(
      testLaneValue.responsibilities,
      'config.testLane.responsibilities',
      issues,
    );
    if (shopifyVariantGids && skus && ebayListingIds && responsibilities) {
      testLane = { shopifyVariantGids, skus, ebayListingIds, responsibilities };
      if (
        shopifyVariantGids.length > 0 ||
        skus.length > 0 ||
        ebayListingIds.length > 0 ||
        responsibilities.length > 0
      ) {
        issues.push(
          'config.testLane must remain empty and inactive because this foundation has no action command',
        );
      }
    }
  }

  const auditValue = requireRecord(root.audit, 'config.audit', issues);
  let audit: OperatorConfig['audit'] | undefined;
  if (auditValue) {
    requireExactKeys(auditValue, ['logPath'], 'config.audit', issues);
    const logPath = validateRelativeAuditPath(auditValue.logPath, issues);
    if (logPath) audit = { logPath };
  }

  if (lane && identities) {
    const expectedEnvironment = lane === 'production-shadow' ? 'production' : 'sandbox';
    if (identities.ebayEnvironment !== expectedEnvironment) {
      issues.push(
        `config.identities.ebayEnvironment must be ${expectedEnvironment} for lane ${lane}`,
      );
    }
    if (lane === 'production-shadow' && identities.marketplaceConnectAccount === null) {
      issues.push(
        'config.identities.marketplaceConnectAccount is required for lane production-shadow',
      );
    }
    if (lane === 'production-shadow' && ownershipValue) {
      for (const responsibility of ['price', 'inventory', 'orderImport'] as const) {
        if (ownership[responsibility]?.currentOwner !== 'marketplace-connect') {
          issues.push(
            `config.ownership.${responsibility}.currentOwner must remain marketplace-connect in the production-shadow foundation`,
          );
        }
      }
    }
  }

  if (issues.length > 0) throw new ConfigValidationError(issues);

  return {
    schemaVersion: schemaVersion!,
    project: project!,
    lane: lane!,
    mode: mode!,
    dryRun: dryRun!,
    writesEnabled: writesEnabled!,
    identities: identities!,
    ownership,
    orders: orders!,
    testLane: testLane!,
    audit: audit!,
  };
}

export function evaluateReadiness(config: OperatorConfig): string[] {
  const blockers: string[] = [];
  for (const responsibility of RESPONSIBILITIES) {
    if (config.ownership[responsibility].currentOwner === 'unverified') {
      blockers.push(`ownership.${responsibility} has no verified current owner`);
    }
  }
  return blockers;
}

export function assertPathInsideRoot(root: string, candidate: string, label: string): string {
  const absolute = path.isAbsolute(candidate) ? path.normalize(candidate) : path.resolve(root, candidate);
  const relative = path.relative(root, absolute);
  if (relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) {
    return absolute;
  }
  throw new Error(`${label} must stay inside the repository root`);
}

export async function validateRepositoryRoot(repoRoot: string): Promise<string> {
  const resolvedRoot = await fs.realpath(path.resolve(repoRoot)).catch(() => null);
  if (!resolvedRoot) throw new Error('Repository root does not exist');

  const packagePath = path.join(resolvedRoot, 'package.json');
  let packageValue: unknown;
  try {
    const packageText = await fs.readFile(packagePath, 'utf8');
    packageValue = JSON.parse(packageText) as unknown;
  } catch {
    throw new Error('Repository root is missing a readable package.json');
  }
  if (!isRecord(packageValue) || packageValue.name !== 'product-pipeline') {
    throw new Error('Repository root is not the product-pipeline package');
  }

  await fs.lstat(path.join(resolvedRoot, '.git')).catch(() => {
    throw new Error('Repository root is not a Git checkout');
  });
  return resolvedRoot;
}

export async function loadOperatorConfig(
  repoRoot: string,
  requestedConfigPath: string,
): Promise<LoadedOperatorConfig> {
  const configPath = assertPathInsideRoot(repoRoot, requestedConfigPath, 'Config path');
  const stat = await fs.lstat(configPath).catch(() => null);
  if (!stat || !stat.isFile() || stat.isSymbolicLink()) {
    throw new ConfigValidationError(['config file must be a regular, non-symlink file']);
  }
  if (stat.size > 128 * 1024) {
    throw new ConfigValidationError(['config file exceeds the 128 KiB safety limit']);
  }
  const realConfigPath = await fs.realpath(configPath);
  assertPathInsideRoot(repoRoot, realConfigPath, 'Config path');

  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.readFile(realConfigPath, 'utf8')) as unknown;
  } catch {
    throw new ConfigValidationError(['config file is not valid JSON']);
  }

  const config = parseOperatorConfig(parsed);
  return {
    config,
    configPath: realConfigPath,
    digest: sha256Digest(config),
  };
}
