import { denyShadowRead } from './errors.js';

export const HARD_READ_LIMITS = Object.freeze({
  timeoutMs: 15_000,
  maxPages: 100,
  maxRecords: 10_000,
  maxResponseBytes: 5 * 1024 * 1024,
});

export type ReadLimits = Readonly<{
  timeoutMs: number;
  maxPages: number;
  maxRecords: number;
  maxResponseBytes: number;
}>;

const LIMIT_KEYS = ['maxPages', 'maxRecords', 'maxResponseBytes', 'timeoutMs'] as const;

function boundedInteger(value: unknown, maximum: number): value is number {
  return Number.isInteger(value) && Number(value) >= 1 && Number(value) <= maximum;
}

export function validateReadLimits(input: unknown): ReadLimits {
  if (
    !input
    || typeof input !== 'object'
    || Array.isArray(input)
    || Object.keys(input).sort().some((key, index) => key !== LIMIT_KEYS[index])
    || Object.keys(input).length !== LIMIT_KEYS.length
  ) {
    denyShadowRead('configuration-denied');
  }
  const candidate = input as Record<string, unknown>;
  if (
    !boundedInteger(candidate.timeoutMs, HARD_READ_LIMITS.timeoutMs)
    || !boundedInteger(candidate.maxPages, HARD_READ_LIMITS.maxPages)
    || !boundedInteger(candidate.maxRecords, HARD_READ_LIMITS.maxRecords)
    || !boundedInteger(candidate.maxResponseBytes, HARD_READ_LIMITS.maxResponseBytes)
  ) {
    denyShadowRead('configuration-denied');
  }

  return Object.freeze({
    timeoutMs: candidate.timeoutMs,
    maxPages: candidate.maxPages,
    maxRecords: candidate.maxRecords,
    maxResponseBytes: candidate.maxResponseBytes,
  });
}
