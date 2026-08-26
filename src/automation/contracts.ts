import { createHash } from 'node:crypto';

export const AUTOMATION_RESPONSIBILITIES = Object.freeze([
  'inventory',
  'price',
  'orderImport',
  'fulfillment',
] as const);

export type AutomationResponsibility = (typeof AUTOMATION_RESPONSIBILITIES)[number];

export type Sha256Digest = `sha256:${string}`;

export type AutomationCeiling = Readonly<{
  minimumCadenceSeconds: number;
  maximumWritesPerRun: number;
  maximumWritesPerHour: number;
  minimumWriteSpacingMs: number;
}>;

export const MAXIMUM_AUTOMATION_AUTHORIZATION_MS = 30 * 24 * 60 * 60 * 1_000;

export const AUTOMATION_CEILINGS = Object.freeze({
  inventory: Object.freeze({
    minimumCadenceSeconds: 60,
    maximumWritesPerRun: 25,
    maximumWritesPerHour: 100,
    minimumWriteSpacingMs: 1_000,
  }),
  price: Object.freeze({
    minimumCadenceSeconds: 300,
    maximumWritesPerRun: 10,
    maximumWritesPerHour: 30,
    minimumWriteSpacingMs: 2_000,
  }),
  orderImport: Object.freeze({
    minimumCadenceSeconds: 60,
    maximumWritesPerRun: 5,
    maximumWritesPerHour: 5,
    minimumWriteSpacingMs: 10_000,
  }),
  fulfillment: Object.freeze({
    minimumCadenceSeconds: 60,
    maximumWritesPerRun: 5,
    maximumWritesPerHour: 20,
    minimumWriteSpacingMs: 10_000,
  }),
} satisfies Readonly<Record<AutomationResponsibility, AutomationCeiling>>);

export type AutomationPolicy = Readonly<{
  schemaVersion: 1;
  decision: 'enable';
  scopeKey: Sha256Digest;
  responsibility: AutomationResponsibility;
  ownershipVersion: number;
  cadenceSeconds: number;
  maximumWritesPerRun: number;
  maximumWritesPerHour: number;
  minimumWriteSpacingMs: number;
  lightspeedCascadeAccepted: boolean;
  activationEvidenceDigest: Sha256Digest;
  userApprovalEvidenceDigest: Sha256Digest;
  authorizedAtUtc: string;
  expiresAtUtc: string;
}>;

export type AutomationPolicyInput = Omit<AutomationPolicy, 'schemaVersion' | 'decision'>;

export class AutomationContractError extends Error {
  readonly code = 'AUTOMATION_POLICY_DENIED' as const;

  constructor() {
    super('Automation policy denied');
    this.name = 'AutomationContractError';
  }
}

const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const EXACT_INPUT_KEYS = Object.freeze([
  'scopeKey',
  'responsibility',
  'ownershipVersion',
  'cadenceSeconds',
  'maximumWritesPerRun',
  'maximumWritesPerHour',
  'minimumWriteSpacingMs',
  'lightspeedCascadeAccepted',
  'activationEvidenceDigest',
  'userApprovalEvidenceDigest',
  'authorizedAtUtc',
  'expiresAtUtc',
] as const);

function deny(): never {
  throw new AutomationContractError();
}

function isExactCanonicalUtc(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const epochMs = Date.parse(value);
  return Number.isFinite(epochMs) && new Date(epochMs).toISOString() === value;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function isExactInputShape(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  const expected = [...EXACT_INPUT_KEYS].sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

export function isAutomationResponsibility(value: unknown): value is AutomationResponsibility {
  return typeof value === 'string'
    && (AUTOMATION_RESPONSIBILITIES as readonly string[]).includes(value);
}

/**
 * Constructs the only canonical policy shape accepted by the future G18
 * persistence slice. It grants no authority and performs no I/O.
 */
export function buildAutomationPolicy(input: AutomationPolicyInput): AutomationPolicy {
  if (!isExactInputShape(input)) deny();
  if (!DIGEST_PATTERN.test(input.scopeKey)
    || !isAutomationResponsibility(input.responsibility)
    || !isPositiveSafeInteger(input.ownershipVersion)
    || !isPositiveSafeInteger(input.cadenceSeconds)
    || !isPositiveSafeInteger(input.maximumWritesPerRun)
    || !isPositiveSafeInteger(input.maximumWritesPerHour)
    || !isPositiveSafeInteger(input.minimumWriteSpacingMs)
    || typeof input.lightspeedCascadeAccepted !== 'boolean'
    || !DIGEST_PATTERN.test(input.activationEvidenceDigest)
    || !DIGEST_PATTERN.test(input.userApprovalEvidenceDigest)
    || !isExactCanonicalUtc(input.authorizedAtUtc)
    || !isExactCanonicalUtc(input.expiresAtUtc)) {
    deny();
  }

  const ceiling = AUTOMATION_CEILINGS[input.responsibility];
  const authorizedEpochMs = Date.parse(input.authorizedAtUtc);
  const expiresEpochMs = Date.parse(input.expiresAtUtc);
  if (input.cadenceSeconds < ceiling.minimumCadenceSeconds
    || input.maximumWritesPerRun > ceiling.maximumWritesPerRun
    || input.maximumWritesPerHour > ceiling.maximumWritesPerHour
    || input.minimumWriteSpacingMs < ceiling.minimumWriteSpacingMs
    || expiresEpochMs <= authorizedEpochMs
    || expiresEpochMs - authorizedEpochMs > MAXIMUM_AUTOMATION_AUTHORIZATION_MS
    || (input.responsibility === 'orderImport') !== input.lightspeedCascadeAccepted) {
    deny();
  }

  return Object.freeze({
    schemaVersion: 1,
    decision: 'enable',
    scopeKey: input.scopeKey,
    responsibility: input.responsibility,
    ownershipVersion: input.ownershipVersion,
    cadenceSeconds: input.cadenceSeconds,
    maximumWritesPerRun: input.maximumWritesPerRun,
    maximumWritesPerHour: input.maximumWritesPerHour,
    minimumWriteSpacingMs: input.minimumWriteSpacingMs,
    lightspeedCascadeAccepted: input.lightspeedCascadeAccepted,
    activationEvidenceDigest: input.activationEvidenceDigest,
    userApprovalEvidenceDigest: input.userApprovalEvidenceDigest,
    authorizedAtUtc: input.authorizedAtUtc,
    expiresAtUtc: input.expiresAtUtc,
  });
}

/** The serialized bytes are the review boundary for a future operator approval. */
export function serializeAutomationPolicy(policy: AutomationPolicy): string {
  const { schemaVersion, decision, ...input } = policy;
  if (schemaVersion !== 1 || decision !== 'enable') deny();
  const checked = buildAutomationPolicy(input);
  return JSON.stringify(checked);
}

export function digestAutomationPolicy(policy: AutomationPolicy): Sha256Digest {
  return `sha256:${createHash('sha256')
    .update(serializeAutomationPolicy(policy), 'utf8')
    .digest('hex')}`;
}
