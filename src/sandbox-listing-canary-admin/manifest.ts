import fs from 'node:fs';
import { createHash } from 'node:crypto';
import type { Digest } from '../migration-store/index.js';

export const SANDBOX_API_ORIGIN = 'https://api.sandbox.ebay.com' as const;
export const SANDBOX_IDENTITY_ORIGIN = 'https://apiz.sandbox.ebay.com' as const;
export const SANDBOX_MARKETPLACE = 'EBAY_US' as const;
export const SANDBOX_MARKER = 'PRODUCT PIPELINE SANDBOX TEST - DO NOT BUY' as const;

const PRODUCT_GID = /^gid:\/\/shopify\/Product\/[0-9]+$/;
const VARIANT_GID = /^gid:\/\/shopify\/ProductVariant\/[0-9]+$/;
const SAFE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const IMAGE_HOSTS = new Set([
  'cdn.shopify.com',
  'i.ebayimg.com',
  'thumbs.ebaystatic.com',
  'secureir.ebaystatic.com',
  'i.ebaystatic.com',
]);
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const CONDITIONS = new Set([
  'NEW',
  'LIKE_NEW',
  'NEW_OTHER',
  'NEW_WITH_DEFECTS',
  'CERTIFIED_REFURBISHED',
  'EXCELLENT_REFURBISHED',
  'VERY_GOOD_REFURBISHED',
  'GOOD_REFURBISHED',
  'SELLER_REFURBISHED',
  'USED_EXCELLENT',
  'USED_VERY_GOOD',
  'USED_GOOD',
  'USED_ACCEPTABLE',
  'FOR_PARTS_OR_NOT_WORKING',
]);

export class SandboxManifestError extends Error {
  constructor(readonly code: string) {
    super('Sandbox canary manifest denied');
    this.name = 'SandboxManifestError';
  }
}
const deny = (code: string): never => {
  throw new SandboxManifestError(code);
};

export type SandboxTarget = Readonly<{
  storeDomain: string;
  productGid: string;
  variantGid: string;
  sku: string;
  shopifyEvidenceDigest: Digest;
}>;

export type SandboxListingManifest = Readonly<{
  schemaVersion: 1;
  environment: 'sandbox';
  marketplaceId: 'EBAY_US';
  target: SandboxTarget;
  listing: Readonly<{
    title: string;
    description: string;
    imageUrls: readonly string[];
    categoryId: string;
    condition: string;
    conditionDescription: string;
    quantity: 1;
    price: Readonly<{ currency: 'USD'; value: '1.00' }>;
    merchantLocationKey: string;
    fulfillmentPolicyId: string;
    paymentPolicyId: string;
    returnPolicyId: string;
  }>;
}>;

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join('|') === [...keys].sort().join('|');
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) deny('MANIFEST_INVALID');
  return value as Record<string, unknown>;
}
function text(value: unknown, max = 256): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > max ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    deny('MANIFEST_INVALID');
  }
  return value as string;
}

export function validateTarget(input: {
  storeDomain: string;
  productGid: string;
  variantGid: string;
  sku: string;
  shopifyEvidenceDigest: string;
}): SandboxTarget {
  if (
    !/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(input.storeDomain) ||
    !PRODUCT_GID.test(input.productGid) ||
    !VARIANT_GID.test(input.variantGid) ||
    !SAFE.test(input.sku) ||
    !DIGEST.test(input.shopifyEvidenceDigest)
  )
    deny('TARGET_INVALID');
  return Object.freeze({
    storeDomain: input.storeDomain,
    productGid: input.productGid,
    variantGid: input.variantGid,
    sku: input.sku,
    shopifyEvidenceDigest: input.shopifyEvidenceDigest as Digest,
  });
}

export function readSandboxManifest(
  filePath: string,
  exactTarget: SandboxTarget,
): {
  manifest: SandboxListingManifest;
  digest: Digest;
} {
  if (!filePath.startsWith('/')) deny('MANIFEST_PATH_DENIED');
  let fd: number | null = null;
  let source = '';
  try {
    fd = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const before = fs.fstatSync(fd);
    if (
      !before.isFile() ||
      before.size > 64 * 1024 ||
      (before.mode & 0o077) !== 0 ||
      before.nlink !== 1 ||
      (typeof process.geteuid === 'function' && before.uid !== process.geteuid())
    )
      deny('MANIFEST_PATH_DENIED');
    const bytes = Buffer.alloc(before.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.readSync(fd, bytes, offset, bytes.length - offset, null);
      if (count === 0) break;
      offset += count;
    }
    const after = fs.fstatSync(fd);
    if (
      offset !== before.size ||
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs
    )
      deny('MANIFEST_PATH_DENIED');
    source = bytes.subarray(0, offset).toString('utf8');
    bytes.fill(0);
  } catch (error) {
    if (error instanceof SandboxManifestError) throw error;
    deny('MANIFEST_PATH_DENIED');
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(source);
  } catch {
    deny('MANIFEST_INVALID');
  }
  const root = record(raw);
  if (
    !exactKeys(root, ['schemaVersion', 'environment', 'marketplaceId', 'target', 'listing']) ||
    root.schemaVersion !== 1 ||
    root.environment !== 'sandbox' ||
    root.marketplaceId !== SANDBOX_MARKETPLACE
  ) {
    deny('MANIFEST_INVALID');
  }
  const target = record(root.target);
  if (
    !exactKeys(target, ['storeDomain', 'productGid', 'variantGid', 'sku', 'shopifyEvidenceDigest'])
  )
    deny('MANIFEST_INVALID');
  const validatedTarget = validateTarget(target as Parameters<typeof validateTarget>[0]);
  if (JSON.stringify(validatedTarget) !== JSON.stringify(exactTarget)) deny('TARGET_MISMATCH');
  const listing = record(root.listing);
  if (
    !exactKeys(listing, [
      'title',
      'description',
      'imageUrls',
      'categoryId',
      'condition',
      'conditionDescription',
      'quantity',
      'price',
      'merchantLocationKey',
      'fulfillmentPolicyId',
      'paymentPolicyId',
      'returnPolicyId',
    ])
  )
    deny('MANIFEST_INVALID');
  const title = text(listing.title, 80);
  const description = text(listing.description, 50_000);
  if (!title.startsWith(SANDBOX_MARKER) || !description.includes(SANDBOX_MARKER))
    deny('MARKER_REQUIRED');
  const images = listing.imageUrls;
  if (
    !Array.isArray(images) ||
    images.length < 1 ||
    images.length > 12 ||
    images.some((v) => {
      if (typeof v !== 'string' || v.length > 2048) return true;
      try {
        const u = new URL(v);
        return (
          u.protocol !== 'https:' ||
          u.username !== '' ||
          u.password !== '' ||
          u.port !== '' ||
          u.search !== '' ||
          u.hash !== '' ||
          !IMAGE_HOSTS.has(u.hostname.toLowerCase())
        );
      } catch {
        return true;
      }
    })
  )
    deny('MANIFEST_INVALID');
  const price = record(listing.price);
  if (
    !exactKeys(price, ['currency', 'value']) ||
    price.currency !== 'USD' ||
    price.value !== '1.00' ||
    listing.quantity !== 1
  )
    deny('CANARY_COMMERCE_LIMIT');
  const manifest: SandboxListingManifest = Object.freeze({
    schemaVersion: 1,
    environment: 'sandbox',
    marketplaceId: SANDBOX_MARKETPLACE,
    target: validatedTarget,
    listing: Object.freeze({
      title,
      description,
      imageUrls: Object.freeze([...(images as string[])]),
      categoryId: (() => {
        const value = text(listing.categoryId, 32);
        if (!/^[0-9]{1,12}$/.test(value)) deny('MANIFEST_INVALID');
        return value;
      })(),
      condition: (() => {
        const value = text(listing.condition, 64);
        if (!CONDITIONS.has(value)) deny('MANIFEST_INVALID');
        return value;
      })(),
      conditionDescription: text(listing.conditionDescription, 1000),
      quantity: 1,
      price: Object.freeze({ currency: 'USD', value: '1.00' }),
      merchantLocationKey: text(listing.merchantLocationKey, 128),
      fulfillmentPolicyId: text(listing.fulfillmentPolicyId, 128),
      paymentPolicyId: text(listing.paymentPolicyId, 128),
      returnPolicyId: text(listing.returnPolicyId, 128),
    }),
  });
  const digest =
    `sha256:${createHash('sha256').update(JSON.stringify(manifest)).digest('hex')}` as Digest;
  return { manifest, digest };
}

export function buildPayloads(manifest: SandboxListingManifest): {
  inventory: Record<string, unknown>;
  offer: Record<string, unknown>;
} {
  const l = manifest.listing;
  return {
    inventory: {
      availability: { shipToLocationAvailability: { quantity: 1 } },
      condition: l.condition,
      conditionDescription: l.conditionDescription,
      product: {
        title: l.title,
        description: l.description,
        imageUrls: l.imageUrls,
      },
    },
    offer: {
      sku: manifest.target.sku,
      marketplaceId: SANDBOX_MARKETPLACE,
      format: 'FIXED_PRICE',
      listingDuration: 'GTC',
      availableQuantity: 1,
      categoryId: l.categoryId,
      listingDescription: l.description,
      listingPolicies: {
        fulfillmentPolicyId: l.fulfillmentPolicyId,
        paymentPolicyId: l.paymentPolicyId,
        returnPolicyId: l.returnPolicyId,
      },
      merchantLocationKey: l.merchantLocationKey,
      pricingSummary: { price: l.price },
    },
  };
}
