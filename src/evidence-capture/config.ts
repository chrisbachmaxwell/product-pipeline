import { createHash, createPublicKey } from 'node:crypto';
import fs, { constants as fsConstants } from 'node:fs';
import path from 'node:path';

export const EVIDENCE_CAPTURE_CONFIG_RELATIVE_PATH = 'config/evidence-capture.json';
export const EVIDENCE_CAPTURE_OUTPUT_DIRECTORY = '.local/evidence-capture';

export type EvidenceCaptureLane = 'sandbox' | 'production-shadow';

export type EvidenceCaptureConfig = {
  schemaVersion: 1;
  project: 'product-pipeline';
  lane: EvidenceCaptureLane;
  mode: 'authoritative-read-capture';
  outputDirectory: typeof EVIDENCE_CAPTURE_OUTPUT_DIRECTORY;
  identities: {
    shopifyStoreDomain: string;
    shopifyShopGid: string;
    shopifyAppGid: string;
    ebayEnvironment: 'sandbox' | 'production';
    ebayUserId: string;
    ebayMarketplaceId: 'EBAY_US';
    ebayRegistrationMarketplaceId: 'EBAY_US';
  };
  collector: {
    name: 'product-pipeline-evidence-capture';
    version: 1;
    buildCommit: string;
  };
  signing: {
    keyId: string;
    publicKeySpkiDerBase64: string;
  };
  limits: {
    requestTimeoutMs: number;
    maxPagesPerSource: number;
    maxRecordsPerSource: number;
    maxResponseBytes: number;
    minimumEbayAccessValiditySeconds: number;
    maxOrderWindowHours: 168;
  };
  safety: {
    externalPlatformReads: true;
    externalPlatformWrites: false;
    historicalBackfill: false;
    oauthAcquisition: false;
    accessRefresh: false;
    rawPayloadPersistence: false;
    personalDataPersistence: false;
    cutoverWatermarkUtc: null;
    ownershipTransferAllowed: false;
  };
};

export type LoadedEvidenceCaptureConfig = {
  config: EvidenceCaptureConfig;
  repositoryRoot: string;
  configAbsolutePath: string;
  outputDirectoryAbsolutePath: string;
  scopeDigest: `sha256:${string}`;
  configDigest: `sha256:${string}`;
};

export class EvidenceCaptureConfigError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(`Evidence-capture configuration denied: ${issues.join('; ')}`);
    this.name = 'EvidenceCaptureConfigError';
    this.issues = issues;
  }
}

const MAX_CONFIG_BYTES = 32 * 1024;
const STORE_DOMAIN_PATTERN = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;
const SHOP_GID_PATTERN = /^gid:\/\/shopify\/Shop\/[0-9]+$/;
const APP_GID_PATTERN = /^gid:\/\/shopify\/App\/[0-9]+$/;
const EBAY_USER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const BUILD_COMMIT_PATTERN = /^[a-f0-9]{40}$/;
const KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;
const SENSITIVE_KEY_PATTERN =
  /(?:token|secret|password|credential|api[_-]?key|client[_-]?secret|access[_-]?token|refresh[_-]?token|private[_-]?key|authorization|cookie)/i;
const SENSITIVE_VALUE_PATTERN =
  /(?:^Bearer\s+|^shpat_|^shpca_|^shppa_|^gh[pousr]_|^sk-[A-Za-z0-9_-]{10,}|^v\^1\.|-----BEGIN [A-Z ]*PRIVATE KEY-----|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})/i;

const ROOT_KEYS = [
  'schemaVersion',
  'project',
  'lane',
  'mode',
  'outputDirectory',
  'identities',
  'collector',
  'signing',
  'limits',
  'safety',
] as const;
const IDENTITY_KEYS = [
  'shopifyStoreDomain',
  'shopifyShopGid',
  'shopifyAppGid',
  'ebayEnvironment',
  'ebayUserId',
  'ebayMarketplaceId',
  'ebayRegistrationMarketplaceId',
] as const;
const COLLECTOR_KEYS = ['name', 'version', 'buildCommit'] as const;
const SIGNING_KEYS = ['keyId', 'publicKeySpkiDerBase64'] as const;
const LIMIT_KEYS = [
  'requestTimeoutMs',
  'maxPagesPerSource',
  'maxRecordsPerSource',
  'maxResponseBytes',
  'minimumEbayAccessValiditySeconds',
  'maxOrderWindowHours',
] as const;
const SAFETY_KEYS = [
  'externalPlatformReads',
  'externalPlatformWrites',
  'historicalBackfill',
  'oauthAcquisition',
  'accessRefresh',
  'rawPayloadPersistence',
  'personalDataPersistence',
  'cutoverWatermarkUtc',
  'ownershipTransferAllowed',
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  field: string,
  issues: string[],
): void {
  const allowed = new Set(keys);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    issues.push(`${field} contains unsupported fields`);
  }
  for (const key of keys) {
    if (!Object.hasOwn(value, key)) issues.push(`${field}.${key} is required`);
  }
}

function record(value: unknown, field: string, issues: string[]): Record<string, unknown> | null {
  if (!isRecord(value)) {
    issues.push(`${field} must be an object`);
    return null;
  }
  return value;
}

function literal<T extends string | number | boolean | null>(
  value: unknown,
  expected: T,
  field: string,
  issues: string[],
): T | undefined {
  if (value !== expected) {
    issues.push(`${field} has an unsafe or unsupported value`);
    return undefined;
  }
  return expected;
}

function enumeration<T extends string>(
  value: unknown,
  allowed: readonly T[],
  field: string,
  issues: string[],
): T | undefined {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    issues.push(`${field} is missing or unsupported`);
    return undefined;
  }
  return value as T;
}

function exactString(
  value: unknown,
  pattern: RegExp,
  field: string,
  issues: string[],
  maximumLength = 256,
): string | undefined {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > maximumLength
    || value.trim() !== value
    || CONTROL_CHARACTER_PATTERN.test(value)
    || /[*?\[\]{}<>]/.test(value)
    || !pattern.test(value)
  ) {
    issues.push(`${field} is missing or malformed`);
    return undefined;
  }
  return value;
}

function boundedInteger(
  value: unknown,
  minimum: number,
  maximum: number,
  field: string,
  issues: string[],
): number | undefined {
  if (!Number.isInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    issues.push(`${field} is outside the supported safety bound`);
    return undefined;
  }
  return Number(value);
}

function inspectSensitiveMaterial(value: unknown, field: string, issues: string[]): void {
  if (typeof value === 'string') {
    if (SENSITIVE_VALUE_PATTERN.test(value.trim())) {
      issues.push(`${field} contains credential-like or personal material`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => inspectSensitiveMaterial(entry, `${field}[${index}]`, issues));
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (SENSITIVE_KEY_PATTERN.test(key)) {
      issues.push(`${field} contains a forbidden credential-like field`);
      continue;
    }
    inspectSensitiveMaterial(child, `${field}.${key}`, issues);
  }
}

function validatePublicKey(value: unknown, issues: string[]): string | undefined {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length > 512) {
    issues.push('config.signing.publicKeySpkiDerBase64 is malformed');
    return undefined;
  }
  try {
    const der = Buffer.from(value, 'base64');
    if (der.toString('base64') !== value) throw new Error('noncanonical');
    const key = createPublicKey({ key: der, format: 'der', type: 'spki' });
    if (key.asymmetricKeyType !== 'ed25519') throw new Error('wrong-key-type');
    return value;
  } catch {
    issues.push('config.signing.publicKeySpkiDerBase64 is not an Ed25519 public key');
    return undefined;
  }
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Cannot canonicalize a non-finite number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  throw new TypeError('Cannot canonicalize an unsupported value');
}

export function sha256Digest(value: unknown): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
}

export function parseEvidenceCaptureConfig(value: unknown): EvidenceCaptureConfig {
  const issues: string[] = [];
  inspectSensitiveMaterial(value, 'config', issues);
  const root = record(value, 'config', issues);
  if (!root) throw new EvidenceCaptureConfigError(issues);
  exactKeys(root, ROOT_KEYS, 'config', issues);

  const schemaVersion = literal(root.schemaVersion, 1, 'config.schemaVersion', issues);
  const project = literal(root.project, 'product-pipeline', 'config.project', issues);
  const lane = enumeration(
    root.lane,
    ['sandbox', 'production-shadow'] as const,
    'config.lane',
    issues,
  );
  const mode = literal(root.mode, 'authoritative-read-capture', 'config.mode', issues);
  const outputDirectory = literal(
    root.outputDirectory,
    EVIDENCE_CAPTURE_OUTPUT_DIRECTORY,
    'config.outputDirectory',
    issues,
  );

  const identityValue = record(root.identities, 'config.identities', issues);
  let identities: EvidenceCaptureConfig['identities'] | undefined;
  if (identityValue) {
    exactKeys(identityValue, IDENTITY_KEYS, 'config.identities', issues);
    const shopifyStoreDomain = exactString(
      identityValue.shopifyStoreDomain,
      STORE_DOMAIN_PATTERN,
      'config.identities.shopifyStoreDomain',
      issues,
    );
    const shopifyShopGid = exactString(
      identityValue.shopifyShopGid,
      SHOP_GID_PATTERN,
      'config.identities.shopifyShopGid',
      issues,
    );
    const shopifyAppGid = exactString(
      identityValue.shopifyAppGid,
      APP_GID_PATTERN,
      'config.identities.shopifyAppGid',
      issues,
    );
    const ebayEnvironment = enumeration(
      identityValue.ebayEnvironment,
      ['sandbox', 'production'] as const,
      'config.identities.ebayEnvironment',
      issues,
    );
    const ebayUserId = exactString(
      identityValue.ebayUserId,
      EBAY_USER_ID_PATTERN,
      'config.identities.ebayUserId',
      issues,
      128,
    );
    const ebayMarketplaceId = literal(
      identityValue.ebayMarketplaceId,
      'EBAY_US',
      'config.identities.ebayMarketplaceId',
      issues,
    );
    const ebayRegistrationMarketplaceId = literal(
      identityValue.ebayRegistrationMarketplaceId,
      'EBAY_US',
      'config.identities.ebayRegistrationMarketplaceId',
      issues,
    );
    if (
      shopifyStoreDomain
      && shopifyShopGid
      && shopifyAppGid
      && ebayEnvironment
      && ebayUserId
      && ebayMarketplaceId
      && ebayRegistrationMarketplaceId
    ) {
      identities = {
        shopifyStoreDomain,
        shopifyShopGid,
        shopifyAppGid,
        ebayEnvironment,
        ebayUserId,
        ebayMarketplaceId,
        ebayRegistrationMarketplaceId,
      };
    }
  }

  const collectorValue = record(root.collector, 'config.collector', issues);
  let collector: EvidenceCaptureConfig['collector'] | undefined;
  if (collectorValue) {
    exactKeys(collectorValue, COLLECTOR_KEYS, 'config.collector', issues);
    const name = literal(
      collectorValue.name,
      'product-pipeline-evidence-capture',
      'config.collector.name',
      issues,
    );
    const version = literal(collectorValue.version, 1, 'config.collector.version', issues);
    const buildCommit = exactString(
      collectorValue.buildCommit,
      BUILD_COMMIT_PATTERN,
      'config.collector.buildCommit',
      issues,
      40,
    );
    if (name && version === 1 && buildCommit) collector = { name, version, buildCommit };
  }

  const signingValue = record(root.signing, 'config.signing', issues);
  let signing: EvidenceCaptureConfig['signing'] | undefined;
  if (signingValue) {
    exactKeys(signingValue, SIGNING_KEYS, 'config.signing', issues);
    const keyId = exactString(
      signingValue.keyId,
      KEY_ID_PATTERN,
      'config.signing.keyId',
      issues,
      64,
    );
    const publicKeySpkiDerBase64 = validatePublicKey(
      signingValue.publicKeySpkiDerBase64,
      issues,
    );
    if (keyId && publicKeySpkiDerBase64) signing = { keyId, publicKeySpkiDerBase64 };
  }

  const limitValue = record(root.limits, 'config.limits', issues);
  let limits: EvidenceCaptureConfig['limits'] | undefined;
  if (limitValue) {
    exactKeys(limitValue, LIMIT_KEYS, 'config.limits', issues);
    const requestTimeoutMs = boundedInteger(
      limitValue.requestTimeoutMs, 1_000, 30_000, 'config.limits.requestTimeoutMs', issues,
    );
    const maxPagesPerSource = boundedInteger(
      limitValue.maxPagesPerSource, 1, 200, 'config.limits.maxPagesPerSource', issues,
    );
    const maxRecordsPerSource = boundedInteger(
      limitValue.maxRecordsPerSource, 1, 25_000, 'config.limits.maxRecordsPerSource', issues,
    );
    const maxResponseBytes = boundedInteger(
      limitValue.maxResponseBytes, 1_024, 8 * 1024 * 1024, 'config.limits.maxResponseBytes', issues,
    );
    const minimumEbayAccessValiditySeconds = boundedInteger(
      limitValue.minimumEbayAccessValiditySeconds,
      300,
      3_600,
      'config.limits.minimumEbayAccessValiditySeconds',
      issues,
    );
    const maxOrderWindowHours = literal(
      limitValue.maxOrderWindowHours,
      168,
      'config.limits.maxOrderWindowHours',
      issues,
    );
    if (
      requestTimeoutMs
      && maxPagesPerSource
      && maxRecordsPerSource
      && maxResponseBytes
      && minimumEbayAccessValiditySeconds
      && maxOrderWindowHours === 168
    ) {
      limits = {
        requestTimeoutMs,
        maxPagesPerSource,
        maxRecordsPerSource,
        maxResponseBytes,
        minimumEbayAccessValiditySeconds,
        maxOrderWindowHours,
      };
    }
  }

  const safetyValue = record(root.safety, 'config.safety', issues);
  let safety: EvidenceCaptureConfig['safety'] | undefined;
  if (safetyValue) {
    exactKeys(safetyValue, SAFETY_KEYS, 'config.safety', issues);
    const externalPlatformReads = literal(
      safetyValue.externalPlatformReads, true, 'config.safety.externalPlatformReads', issues,
    );
    const externalPlatformWrites = literal(
      safetyValue.externalPlatformWrites, false, 'config.safety.externalPlatformWrites', issues,
    );
    const historicalBackfill = literal(
      safetyValue.historicalBackfill, false, 'config.safety.historicalBackfill', issues,
    );
    const oauthAcquisition = literal(
      safetyValue.oauthAcquisition, false, 'config.safety.oauthAcquisition', issues,
    );
    const accessRefresh = literal(
      safetyValue.accessRefresh, false, 'config.safety.accessRefresh', issues,
    );
    const rawPayloadPersistence = literal(
      safetyValue.rawPayloadPersistence, false, 'config.safety.rawPayloadPersistence', issues,
    );
    const personalDataPersistence = literal(
      safetyValue.personalDataPersistence, false, 'config.safety.personalDataPersistence', issues,
    );
    const cutoverWatermarkUtc = literal(
      safetyValue.cutoverWatermarkUtc, null, 'config.safety.cutoverWatermarkUtc', issues,
    );
    const ownershipTransferAllowed = literal(
      safetyValue.ownershipTransferAllowed,
      false,
      'config.safety.ownershipTransferAllowed',
      issues,
    );
    if (
      externalPlatformReads === true
      && externalPlatformWrites === false
      && historicalBackfill === false
      && oauthAcquisition === false
      && accessRefresh === false
      && rawPayloadPersistence === false
      && personalDataPersistence === false
      && cutoverWatermarkUtc === null
      && ownershipTransferAllowed === false
    ) {
      safety = {
        externalPlatformReads,
        externalPlatformWrites,
        historicalBackfill,
        oauthAcquisition,
        accessRefresh,
        rawPayloadPersistence,
        personalDataPersistence,
        cutoverWatermarkUtc,
        ownershipTransferAllowed,
      };
    }
  }

  if (lane && identities) {
    const expected = lane === 'production-shadow' ? 'production' : 'sandbox';
    if (identities.ebayEnvironment !== expected) {
      issues.push('config identity environment does not match the selected lane');
    }
    if (/^(?:replace|example|placeholder|changeme|todo)(?:[-_.]|$)/i.test(identities.ebayUserId)) {
      issues.push('config.identities.ebayUserId must be an exact account identifier');
    }
  }

  if (
    issues.length > 0
    || schemaVersion !== 1
    || !project
    || !lane
    || !mode
    || !outputDirectory
    || !identities
    || !collector
    || !signing
    || !limits
    || !safety
  ) {
    throw new EvidenceCaptureConfigError(issues.length > 0 ? issues : ['configuration is incomplete']);
  }

  return {
    schemaVersion,
    project,
    lane,
    mode,
    outputDirectory,
    identities,
    collector,
    signing,
    limits,
    safety,
  };
}

function assertRepositoryRoot(root: string): string {
  const absolute = fs.realpathSync(path.resolve(root));
  const packagePath = path.join(absolute, 'package.json');
  const agentsPath = path.join(absolute, 'AGENTS.md');
  if (!fs.statSync(packagePath).isFile() || !fs.statSync(agentsPath).isFile()) {
    throw new EvidenceCaptureConfigError(['repository root is not ProductPipeline']);
  }
  const parsed = JSON.parse(fs.readFileSync(packagePath, 'utf8')) as { name?: unknown };
  if (parsed.name !== 'product-pipeline') {
    throw new EvidenceCaptureConfigError(['repository root is not ProductPipeline']);
  }
  return absolute;
}

function assertNoSymlinkComponents(root: string, target: string): void {
  const relative = path.relative(root, target);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new EvidenceCaptureConfigError(['requested path is outside the repository']);
  }
  let current = root;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try {
      if (fs.lstatSync(current).isSymbolicLink()) {
        throw new EvidenceCaptureConfigError(['requested path contains a symbolic link']);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
  }
}

function readBoundedJsonFile(filePath: string): unknown {
  const descriptor = fs.openSync(
    filePath,
    fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
  );
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size <= 0 || stat.size > MAX_CONFIG_BYTES) {
      throw new EvidenceCaptureConfigError(['configuration file is unavailable or unsafe']);
    }
    const buffer = Buffer.alloc(Math.min(stat.size + 1, MAX_CONFIG_BYTES + 1));
    const bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, 0);
    if (bytesRead !== stat.size || bytesRead > MAX_CONFIG_BYTES) {
      throw new EvidenceCaptureConfigError(['configuration file is unavailable or unsafe']);
    }
    try {
      return JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'));
    } catch {
      throw new EvidenceCaptureConfigError(['configuration JSON is invalid']);
    }
  } finally {
    fs.closeSync(descriptor);
  }
}

export function loadEvidenceCaptureConfig(input: {
  repositoryRoot: string;
  requestedConfigPath: string;
}): LoadedEvidenceCaptureConfig {
  const repositoryRoot = assertRepositoryRoot(input.repositoryRoot);
  if (input.requestedConfigPath !== EVIDENCE_CAPTURE_CONFIG_RELATIVE_PATH) {
    throw new EvidenceCaptureConfigError(['configuration path must be the fixed repository-local path']);
  }
  const configAbsolutePath = path.resolve(repositoryRoot, input.requestedConfigPath);
  const outputDirectoryAbsolutePath = path.resolve(repositoryRoot, EVIDENCE_CAPTURE_OUTPUT_DIRECTORY);
  assertNoSymlinkComponents(repositoryRoot, configAbsolutePath);
  assertNoSymlinkComponents(repositoryRoot, outputDirectoryAbsolutePath);
  const config = parseEvidenceCaptureConfig(readBoundedJsonFile(configAbsolutePath));
  return {
    config,
    repositoryRoot,
    configAbsolutePath,
    outputDirectoryAbsolutePath,
    scopeDigest: sha256Digest(config.identities),
    configDigest: sha256Digest(config),
  };
}
