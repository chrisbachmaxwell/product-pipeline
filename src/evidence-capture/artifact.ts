import {
  createPrivateKey,
  createPublicKey,
  randomUUID,
  sign as signBytes,
  verify as verifyBytes,
} from 'node:crypto';
import fs, { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import {
  canonicalJson,
  sha256Digest,
  type LoadedEvidenceCaptureConfig,
} from './config.js';

export const EVIDENCE_SIGNING_KEY_ENV =
  'PRODUCT_PIPELINE_EVIDENCE_SIGNING_KEY_PKCS8_B64';

export type EvidenceSource = 'shopify' | 'ebay' | 'marketplace-connect';

export type EvidenceArtifactPayload<T> = {
  schemaVersion: 1;
  kind: 'product-pipeline-authoritative-read-evidence';
  source: EvidenceSource;
  captureId: string;
  generatedAtUtc: string;
  scopeDigest: `sha256:${string}`;
  configDigest: `sha256:${string}`;
  collector: {
    name: 'product-pipeline-evidence-capture';
    version: 1;
    buildCommit: string;
  };
  safety: {
    externalReadsPerformed: boolean;
    externalWrites: 0;
    historicalBackfill: false;
    oauthAcquisition: false;
    accessRefresh: false;
    rawPayloadPersistence: false;
    personalDataPersistence: false;
    ownershipTransferred: false;
    cutoverReady: false;
    productionParity: false;
  };
  evidence: T;
};

export type EvidenceArtifact<T> = {
  payload: EvidenceArtifactPayload<T>;
  signature: {
    algorithm: 'Ed25519';
    keyId: string;
    payloadDigest: `sha256:${string}`;
    valueBase64: string;
  };
};

export type EvidenceArtifactSigner = Readonly<{
  sign: <T>(payload: EvidenceArtifactPayload<T>) => EvidenceArtifact<T>;
  keyId: string;
}>;

export class EvidenceArtifactError extends Error {
  constructor(message: string) {
    super(`Evidence artifact denied: ${message}`);
    this.name = 'EvidenceArtifactError';
  }
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;
const FORBIDDEN_KEY_PATTERN =
  /(?:authorization|cookie|access[_-]?token|refresh[_-]?token|token|secret|password|credential|api[_-]?key|private[_-]?key|email|phone|address|customer|buyer|first[_-]?name|last[_-]?name|full[_-]?name|line[_-]?items?|raw(?:[_-]?json|[_-]?payload)?|checkout[_-]?note)/i;
const FORBIDDEN_VALUE_PATTERN =
  /(?:Bearer\s+[A-Za-z0-9._~+/-]{8,}|shpat_[A-Za-z0-9_-]{8,}|shpca_[A-Za-z0-9_-]{8,}|shppa_[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9_-]{8,}|sk-[A-Za-z0-9_-]{10,}|v\^1\.[^\s]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/i;
const EMAIL_VALUE_PATTERN = /(?:^|[^A-Za-z0-9._%+-])[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}(?:$|[^A-Za-z0-9.-])/i;
const MAX_ARTIFACT_BYTES = 8 * 1024 * 1024;
const ARTIFACT_FILENAME_PATTERN =
  /^(?:shopify|ebay|marketplace-connect)-[0-9]{8}T[0-9]{9}Z-[a-f0-9]{12}\.json$/;

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length
    && actual.every((key, index) => key === sortedExpected[index]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertNoForbiddenMaterial(value: unknown, pathLabel = 'artifact'): void {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (FORBIDDEN_VALUE_PATTERN.test(trimmed) || EMAIL_VALUE_PATTERN.test(trimmed)) {
      throw new EvidenceArtifactError(`${pathLabel} contains forbidden material`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoForbiddenMaterial(entry, `${pathLabel}[${index}]`));
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (key === 'rawPayloadPersistence' && child === false) continue;
    if (FORBIDDEN_KEY_PATTERN.test(key)) {
      throw new EvidenceArtifactError(`${pathLabel} contains a forbidden field`);
    }
    assertNoForbiddenMaterial(child, `${pathLabel}.${key}`);
  }
}

function canonicalUtc(value: string): boolean {
  const parsed = Date.parse(value);
  return !Number.isNaN(parsed) && new Date(parsed).toISOString() === value;
}

function decodeCanonicalBase64(value: string, label: string): Buffer {
  if (!BASE64_PATTERN.test(value) || value.length > 8_192) {
    throw new EvidenceArtifactError(`${label} is malformed`);
  }
  const decoded = Buffer.from(value, 'base64');
  if (decoded.toString('base64') !== value) {
    throw new EvidenceArtifactError(`${label} is noncanonical`);
  }
  return decoded;
}

export function buildEvidencePayload<T>(input: {
  loaded: LoadedEvidenceCaptureConfig;
  source: EvidenceSource;
  evidence: T;
  generatedAtUtc: string;
  externalReadsPerformed: boolean;
  captureId?: string;
}): EvidenceArtifactPayload<T> {
  if (!canonicalUtc(input.generatedAtUtc)) {
    throw new EvidenceArtifactError('generation time is not canonical UTC');
  }
  const captureId = input.captureId ?? randomUUID();
  if (!UUID_PATTERN.test(captureId)) {
    throw new EvidenceArtifactError('capture ID is malformed');
  }
  assertNoForbiddenMaterial(input.evidence, 'evidence');
  return {
    schemaVersion: 1,
    kind: 'product-pipeline-authoritative-read-evidence',
    source: input.source,
    captureId,
    generatedAtUtc: input.generatedAtUtc,
    scopeDigest: input.loaded.scopeDigest,
    configDigest: input.loaded.configDigest,
    collector: { ...input.loaded.config.collector },
    safety: {
      externalReadsPerformed: input.externalReadsPerformed,
      externalWrites: 0,
      historicalBackfill: false,
      oauthAcquisition: false,
      accessRefresh: false,
      rawPayloadPersistence: false,
      personalDataPersistence: false,
      ownershipTransferred: false,
      cutoverReady: false,
      productionParity: false,
    },
    evidence: input.evidence,
  };
}

export function createEvidenceArtifactSigner(input: {
  loaded: LoadedEvidenceCaptureConfig;
  environment: Readonly<Record<string, string | undefined>>;
}): EvidenceArtifactSigner {
  const encodedPrivateKey = input.environment[EVIDENCE_SIGNING_KEY_ENV];
  if (typeof encodedPrivateKey !== 'string' || encodedPrivateKey.length === 0) {
    throw new EvidenceArtifactError('signing authority is unavailable');
  }
  let privateKey;
  try {
    privateKey = createPrivateKey({
      key: decodeCanonicalBase64(encodedPrivateKey, 'signing authority'),
      format: 'der',
      type: 'pkcs8',
    });
  } catch (error) {
    if (error instanceof EvidenceArtifactError) throw error;
    throw new EvidenceArtifactError('signing authority is invalid');
  }
  if (privateKey.asymmetricKeyType !== 'ed25519') {
    throw new EvidenceArtifactError('signing authority has the wrong key type');
  }
  const derivedPublic = createPublicKey(privateKey).export({ format: 'der', type: 'spki' });
  const configuredPublic = Buffer.from(input.loaded.config.signing.publicKeySpkiDerBase64, 'base64');
  if (!Buffer.from(derivedPublic).equals(configuredPublic)) {
    throw new EvidenceArtifactError('signing authority does not match the pinned public key');
  }

  const sign = <T>(payload: EvidenceArtifactPayload<T>): EvidenceArtifact<T> => {
    assertNoForbiddenMaterial(payload);
    const serialized = canonicalJson(payload);
    const signature = signBytes(null, Buffer.from(serialized, 'utf8'), privateKey);
    return {
      payload,
      signature: {
        algorithm: 'Ed25519',
        keyId: input.loaded.config.signing.keyId,
        payloadDigest: sha256Digest(payload),
        valueBase64: signature.toString('base64'),
      },
    };
  };

  return Object.freeze({ sign, keyId: input.loaded.config.signing.keyId });
}

export function verifyEvidenceArtifact<T>(input: {
  artifact: EvidenceArtifact<T>;
  loaded: LoadedEvidenceCaptureConfig;
}): void {
  const { artifact, loaded } = input;
  if (
    !isRecord(artifact)
    || !hasExactKeys(artifact, ['payload', 'signature'])
    || !isRecord(artifact.payload)
    || !hasExactKeys(artifact.payload, [
      'captureId',
      'collector',
      'configDigest',
      'evidence',
      'generatedAtUtc',
      'kind',
      'safety',
      'schemaVersion',
      'scopeDigest',
      'source',
    ])
    || !isRecord(artifact.payload.collector)
    || !hasExactKeys(artifact.payload.collector, ['buildCommit', 'name', 'version'])
    || !isRecord(artifact.payload.safety)
    || !hasExactKeys(artifact.payload.safety, [
      'accessRefresh',
      'cutoverReady',
      'externalReadsPerformed',
      'externalWrites',
      'historicalBackfill',
      'oauthAcquisition',
      'ownershipTransferred',
      'personalDataPersistence',
      'productionParity',
      'rawPayloadPersistence',
    ])
    || !isRecord(artifact.signature)
    || !hasExactKeys(artifact.signature, [
      'algorithm',
      'keyId',
      'payloadDigest',
      'valueBase64',
    ])
  ) {
    throw new EvidenceArtifactError('signature envelope shape is invalid');
  }
  assertNoForbiddenMaterial(artifact.payload);
  if (
    artifact.payload.schemaVersion !== 1
    || artifact.payload.kind !== 'product-pipeline-authoritative-read-evidence'
    || !['shopify', 'ebay', 'marketplace-connect'].includes(artifact.payload.source)
    || !UUID_PATTERN.test(artifact.payload.captureId)
    || !canonicalUtc(artifact.payload.generatedAtUtc)
    || artifact.payload.scopeDigest !== loaded.scopeDigest
    || artifact.payload.configDigest !== loaded.configDigest
    || artifact.payload.collector.name !== loaded.config.collector.name
    || artifact.payload.collector.version !== loaded.config.collector.version
    || artifact.payload.collector.buildCommit !== loaded.config.collector.buildCommit
    || typeof artifact.payload.safety.externalReadsPerformed !== 'boolean'
    || artifact.payload.safety.externalWrites !== 0
    || artifact.payload.safety.historicalBackfill !== false
    || artifact.payload.safety.oauthAcquisition !== false
    || artifact.payload.safety.accessRefresh !== false
    || artifact.payload.safety.rawPayloadPersistence !== false
    || artifact.payload.safety.personalDataPersistence !== false
    || artifact.payload.safety.ownershipTransferred !== false
    || artifact.payload.safety.cutoverReady !== false
    || artifact.payload.safety.productionParity !== false
    || artifact.signature.algorithm !== 'Ed25519'
    || artifact.signature.keyId !== loaded.config.signing.keyId
    || !DIGEST_PATTERN.test(artifact.signature.payloadDigest)
    || artifact.signature.payloadDigest !== sha256Digest(artifact.payload)
  ) {
    throw new EvidenceArtifactError('signature envelope is inconsistent');
  }
  const publicKey = createPublicKey({
    key: Buffer.from(loaded.config.signing.publicKeySpkiDerBase64, 'base64'),
    format: 'der',
    type: 'spki',
  });
  const signature = decodeCanonicalBase64(artifact.signature.valueBase64, 'signature');
  if (!verifyBytes(
    null,
    Buffer.from(canonicalJson(artifact.payload), 'utf8'),
    publicKey,
    signature,
  )) {
    throw new EvidenceArtifactError('signature verification failed');
  }
}

function assertExistingPrivateDirectory(loaded: LoadedEvidenceCaptureConfig): void {
  const repositoryRoot = fs.realpathSync(loaded.repositoryRoot);
  if (repositoryRoot !== loaded.repositoryRoot) {
    throw new EvidenceArtifactError('repository root is not canonical');
  }
  let current = repositoryRoot;
  for (const segment of ['.local', 'evidence-capture']) {
    current = path.join(current, segment);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(current);
    } catch {
      throw new EvidenceArtifactError('artifact directory is unavailable');
    }
    if (
      !stat.isDirectory()
      || stat.isSymbolicLink()
      || (stat.mode & 0o777) !== 0o700
    ) {
      throw new EvidenceArtifactError('artifact directory is unsafe');
    }
    const real = fs.realpathSync(current);
    if (path.relative(repositoryRoot, real).startsWith('..')) {
      throw new EvidenceArtifactError('artifact directory escaped the repository');
    }
  }
  if (current !== loaded.outputDirectoryAbsolutePath) {
    throw new EvidenceArtifactError('artifact directory does not match configuration');
  }
}

/**
 * Reads one artifact emitted by this tool from the fixed ignored directory.
 * The file must be canonical JSON, regular, private, single-linked, and named
 * from its signed digest. This operation never creates or repairs storage.
 */
export function readEvidenceArtifact(input: {
  loaded: LoadedEvidenceCaptureConfig;
  requestedArtifactPath: string;
}): EvidenceArtifact<unknown> {
  assertExistingPrivateDirectory(input.loaded);
  if (
    path.isAbsolute(input.requestedArtifactPath)
    || path.normalize(input.requestedArtifactPath) !== input.requestedArtifactPath
    || path.dirname(input.requestedArtifactPath) !== '.local/evidence-capture'
  ) {
    throw new EvidenceArtifactError('artifact path is outside the fixed local boundary');
  }
  const filename = path.basename(input.requestedArtifactPath);
  if (!ARTIFACT_FILENAME_PATTERN.test(filename)) {
    throw new EvidenceArtifactError('artifact filename is malformed');
  }
  const absolutePath = path.join(input.loaded.repositoryRoot, input.requestedArtifactPath);
  const pathStat = fs.lstatSync(absolutePath);
  if (
    !pathStat.isFile()
    || pathStat.isSymbolicLink()
    || pathStat.nlink !== 1
    || (pathStat.mode & 0o777) !== 0o600
    || pathStat.size <= 0
    || pathStat.size > MAX_ARTIFACT_BYTES
  ) {
    throw new EvidenceArtifactError('artifact file is unavailable or unsafe');
  }
  const descriptor = fs.openSync(
    absolutePath,
    fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
  );
  let serialized: string;
  try {
    const openedStat = fs.fstatSync(descriptor);
    if (
      !openedStat.isFile()
      || openedStat.dev !== pathStat.dev
      || openedStat.ino !== pathStat.ino
      || openedStat.nlink !== 1
      || (openedStat.mode & 0o777) !== 0o600
      || openedStat.size !== pathStat.size
    ) {
      throw new EvidenceArtifactError('artifact changed during verification');
    }
    const bytes = Buffer.alloc(openedStat.size + 1);
    const count = fs.readSync(descriptor, bytes, 0, bytes.length, 0);
    if (count !== openedStat.size) {
      throw new EvidenceArtifactError('artifact length changed during verification');
    }
    serialized = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, count));
  } catch (error) {
    if (error instanceof EvidenceArtifactError) throw error;
    throw new EvidenceArtifactError('artifact could not be read safely');
  } finally {
    fs.closeSync(descriptor);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    throw new EvidenceArtifactError('artifact JSON is malformed');
  }
  if (`${canonicalJson(parsed)}\n` !== serialized) {
    throw new EvidenceArtifactError('artifact JSON is not canonical');
  }
  const artifact = parsed as EvidenceArtifact<unknown>;
  verifyEvidenceArtifact({ loaded: input.loaded, artifact });
  const artifactDigest = sha256Digest(artifact);
  const timestamp = artifact.payload.generatedAtUtc.replace(/[-:.]/g, '');
  const expectedFilename =
    `${artifact.payload.source}-${timestamp}-${artifactDigest.slice(7, 19)}.json`;
  if (filename !== expectedFilename) {
    throw new EvidenceArtifactError('artifact filename does not match signed content');
  }
  return artifact;
}

function ensurePrivateDirectory(repositoryRoot: string, directory: string): void {
  const relative = path.relative(repositoryRoot, directory);
  if (relative !== '.local/evidence-capture') {
    throw new EvidenceArtifactError('output directory is outside the fixed local boundary');
  }
  let current = repositoryRoot;
  for (const segment of ['.local', 'evidence-capture']) {
    current = path.join(current, segment);
    try {
      const stat = fs.lstatSync(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new EvidenceArtifactError('output directory is unavailable or unsafe');
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      fs.mkdirSync(current, { mode: 0o700 });
    }
    const real = fs.realpathSync(current);
    if (path.relative(repositoryRoot, real).startsWith('..')) {
      throw new EvidenceArtifactError('output directory escaped the repository');
    }
    fs.chmodSync(current, 0o700);
  }
}

export function writeEvidenceArtifact<T>(input: {
  artifact: EvidenceArtifact<T>;
  loaded: LoadedEvidenceCaptureConfig;
}): { relativePath: string; artifactDigest: `sha256:${string}` } {
  verifyEvidenceArtifact(input);
  ensurePrivateDirectory(input.loaded.repositoryRoot, input.loaded.outputDirectoryAbsolutePath);
  const serialized = `${canonicalJson(input.artifact)}\n`;
  const bytes = Buffer.byteLength(serialized);
  if (bytes <= 0 || bytes > MAX_ARTIFACT_BYTES) {
    throw new EvidenceArtifactError('artifact exceeds the local size bound');
  }
  const artifactDigest = sha256Digest(input.artifact);
  const timestamp = input.artifact.payload.generatedAtUtc.replace(/[-:.]/g, '');
  const filename = `${input.artifact.payload.source}-${timestamp}-${artifactDigest.slice(7, 19)}.json`;
  const finalPath = path.join(input.loaded.outputDirectoryAbsolutePath, filename);
  const temporaryPath = path.join(
    input.loaded.outputDirectoryAbsolutePath,
    `.pending-${input.artifact.payload.captureId}`,
  );
  let descriptor: number | null = null;
  try {
    descriptor = fs.openSync(
      temporaryPath,
      fsConstants.O_CREAT
        | fsConstants.O_EXCL
        | fsConstants.O_WRONLY
        | (fsConstants.O_NOFOLLOW ?? 0),
      0o600,
    );
    fs.writeFileSync(descriptor, serialized, 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    fs.linkSync(temporaryPath, finalPath);
    fs.unlinkSync(temporaryPath);
    fs.chmodSync(finalPath, 0o600);
    const directoryDescriptor = fs.openSync(input.loaded.outputDirectoryAbsolutePath, 'r');
    try {
      fs.fsyncSync(directoryDescriptor);
    } finally {
      fs.closeSync(directoryDescriptor);
    }
  } catch (error) {
    if (descriptor !== null) fs.closeSync(descriptor);
    try {
      fs.unlinkSync(temporaryPath);
    } catch {
      // No pending artifact remains when the file was never created or was already linked.
    }
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new EvidenceArtifactError('artifact already exists; overwrite is forbidden');
    }
    if (error instanceof EvidenceArtifactError) throw error;
    throw new EvidenceArtifactError('artifact could not be published safely');
  }
  const stat = fs.lstatSync(finalPath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600) {
    throw new EvidenceArtifactError('published artifact failed filesystem verification');
  }
  return {
    relativePath: path.relative(input.loaded.repositoryRoot, finalPath),
    artifactDigest,
  };
}
