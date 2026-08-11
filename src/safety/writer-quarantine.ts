import type { NextFunction, Request, Response } from 'express';
import type { MigrationResponsibility, WriterResponsibility } from './responsibilities.js';

/**
 * `listingLifecycle` is retained only as a coarse legacy denial label for
 * already-quarantined services. It is not accepted by ownership, approval,
 * persistence, reconciliation, or canary APIs.
 */
export type QuarantinedResponsibility =
  | WriterResponsibility
  | 'listingLifecycle'
  | 'externalCommerce';

export const WRITER_QUARANTINE_CODE = 'WRITER_QUARANTINED' as const;

export const MARKETPLACE_CONNECT_BASELINE = Object.freeze({
  policyVersion: 1,
  phase: 'marketplace-connect-incumbent' as const,
  effectiveMode: 'shadow-read-only' as const,
  externalWritesAllowed: false as const,
  historicalBackfillAllowed: false as const,
  cutoverWatermarkUtc: null,
  remoteVerification: 'not-performed' as const,
  responsibilities: Object.freeze({
    orderImport: Object.freeze({
      owner: 'marketplace-connect' as const,
      productPipelineAccess: 'disabled' as const,
      writesAllowed: false as const,
    }),
    price: Object.freeze({
      owner: 'marketplace-connect' as const,
      productPipelineAccess: 'read-only' as const,
      writesAllowed: false as const,
    }),
    inventory: Object.freeze({
      owner: 'marketplace-connect' as const,
      productPipelineAccess: 'read-only' as const,
      writesAllowed: false as const,
    }),
    listingCreate: Object.freeze({
      owner: 'unverified' as const,
      productPipelineAccess: 'read-only' as const,
      writesAllowed: false as const,
    }),
    listingRevise: Object.freeze({
      owner: 'unverified' as const,
      productPipelineAccess: 'read-only' as const,
      writesAllowed: false as const,
    }),
    listingEndRelist: Object.freeze({
      owner: 'unverified' as const,
      productPipelineAccess: 'read-only' as const,
      writesAllowed: false as const,
    }),
    mapping: Object.freeze({
      owner: 'unverified' as const,
      productPipelineAccess: 'read-only' as const,
      writesAllowed: false as const,
    }),
    fulfillment: Object.freeze({
      owner: 'unverified' as const,
      productPipelineAccess: 'read-only' as const,
      writesAllowed: false as const,
    }),
    feedback: Object.freeze({
      owner: 'unverified' as const,
      productPipelineAccess: 'read-only' as const,
      writesAllowed: false as const,
    }),
    reconciliation: Object.freeze({
      owner: 'unverified' as const,
      productPipelineAccess: 'read-only' as const,
      writesAllowed: false as const,
    }),
  }) satisfies Readonly<Record<MigrationResponsibility, {
    owner: 'marketplace-connect' | 'unverified';
    productPipelineAccess: 'disabled' | 'read-only';
    writesAllowed: false;
  }>>,
  quarantineChannels: Object.freeze([
    'api',
    'shopify-webhooks',
    'ebay-webhooks',
    'scheduler',
    'legacy-cli',
    'authentication-routes',
    'ebay-adapter',
    'shopify-order-adapter',
    'shopify-inventory-adapter',
  ] as const),
});

export class WriterQuarantinedError extends Error {
  readonly code = WRITER_QUARANTINE_CODE;
  readonly responsibility: QuarantinedResponsibility;
  readonly operation: string;
  readonly incumbentOwner: 'marketplace-connect' | 'unverified';

  constructor(responsibility: QuarantinedResponsibility, operation: string) {
    super(
      `ProductPipeline ${operation} is quarantined in shadow mode; a separately authorized responsibility cutover is required`,
    );
    this.name = 'WriterQuarantinedError';
    this.responsibility = responsibility;
    this.operation = operation;
    this.incumbentOwner = ['orderImport', 'price', 'inventory'].includes(responsibility)
      ? 'marketplace-connect'
      : 'unverified';
  }

  toResponse() {
    return {
      error: 'ProductPipeline is in shadow read-only mode',
      code: this.code,
      responsibility: this.responsibility,
      operation: this.operation,
      incumbentOwner: this.incumbentOwner,
      effectiveMode: MARKETPLACE_CONNECT_BASELINE.effectiveMode,
      externalWritesAllowed: false,
      historicalBackfillAllowed: false,
      cutoverWatermarkUtc: null,
      requiredDecision: 'separately-authorized-cutover',
    };
  }
}

/**
 * The current migration phase has no runtime override. Every call fails before
 * credentials, databases, platform reads, or writes are reached.
 */
export function denyExternalWrite(
  responsibility: QuarantinedResponsibility,
  operation: string,
): void {
  throw new WriterQuarantinedError(responsibility, operation);
}

export function responsibilityForApiPath(pathname: string): QuarantinedResponsibility {
  if (/order|sync\/trigger|cleanup/i.test(pathname)) return 'orderImport';
  if (/price/i.test(pathname)) return 'price';
  if (/inventory/i.test(pathname)) return 'inventory';
  if (/fulfill/i.test(pathname)) return 'fulfillment';
  if (/feedback/i.test(pathname)) return 'feedback';
  if (/mapping/i.test(pathname)) return 'mapping';
  if (/end|relist|withdraw/i.test(pathname)) return 'listingEndRelist';
  if (/create|publish|draft/i.test(pathname)) return 'listingCreate';
  if (/listing|product|template|image|pipeline|watcher|tim/i.test(pathname)) return 'listingRevise';
  return 'externalCommerce';
}

export function isReadOnlyHttpMethod(method: string): boolean {
  return ['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase());
}

/** Default-deny every state-changing API method during shadow mode. */
export function writerQuarantineMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (isReadOnlyHttpMethod(req.method)) {
    next();
    return;
  }

  const error = new WriterQuarantinedError(
    responsibilityForApiPath(req.originalUrl || req.path),
    `${req.method.toUpperCase()} ${req.originalUrl || req.path}`,
  );
  res.status(423).json(error.toResponse());
}

export function getMigrationPolicyStatus(servedAt = new Date().toISOString()) {
  return {
    phase: MARKETPLACE_CONNECT_BASELINE.phase,
    effectiveMode: MARKETPLACE_CONNECT_BASELINE.effectiveMode,
    externalWritesAllowed: false as const,
    historicalBackfillAllowed: false as const,
    cutoverWatermarkUtc: null,
    remoteVerification: MARKETPLACE_CONNECT_BASELINE.remoteVerification,
    servedAt,
    responsibilities: Object.entries(MARKETPLACE_CONNECT_BASELINE.responsibilities).map(
      ([responsibility, policy]) => ({ responsibility, ...policy }),
    ),
    quarantine: {
      enabled: true as const,
      channels: [...MARKETPLACE_CONNECT_BASELINE.quarantineChannels],
      runtimeOverrideAvailable: false as const,
    },
  };
}
