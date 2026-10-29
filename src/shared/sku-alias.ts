/**
 * The one reversible mapping between a Shopify SKU and the SKU ProductPipeline
 * uses as the eBay Inventory API target (L116, incident #239).
 *
 * eBay's Inventory API puts the SKU in the URL path and refuses `/` (and
 * spaces), so a Shopify SKU such as `ILCE6400/B-U641` cannot be its own eBay
 * SKU. Every SKU that is already a valid direct target keeps its exact bytes,
 * so no existing listing, job, approval or binding key changes. Any other SKU
 * becomes `PP1_` followed by its UTF-8 bytes, with every byte outside
 * `[A-Za-z0-9.-]` written as `_` plus two upper-case hex digits.
 *
 * The `PP1_` prefix is reserved in any letter case: a Shopify SKU starting
 * with it is neither direct nor aliased (it gets no eBay SKU), so an alias can
 * never equal the eBay SKU of another Shopify SKU. An alias always contains
 * at least one escape (a string whose
 * decoding is itself direct is not canonical). Decoding accepts only the exact
 * canonical form; anything else is not an alias.
 *
 * Only a Shopify SKU that order import can resolve may get an alias: the
 * alphabet below is order import's Shopify SKU grammar (L77,
 * `src/order-import-admin/shopify-order-adapter.ts`). Aliasing a SKU that
 * grammar refuses would let a sale freeze the strictly ordered order
 * pipeline, so such a SKU has no eBay SKU and is never published.
 */
export const EBAY_SKU_ALIAS_PREFIX = 'PP1_';
/** eBay Inventory API SKU length limit. */
export const EBAY_INVENTORY_SKU_MAX_LENGTH = 50;

const DIRECT_EBAY_SKU = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const RESERVED_ALIAS_PREFIX = /^pp1_/i;
const ALIAS_GRAMMAR = /^PP1_(?:[A-Za-z0-9.-]|_[0-9A-F]{2})+$/;
const UNESCAPED_BYTE = /^[A-Za-z0-9.-]$/;
const ALIASABLE_SHOPIFY_SKU = /^[A-Za-z0-9][A-Za-z0-9._ /-]{0,127}$/;

function isRawSku(value: unknown): value is string {
  return typeof value === 'string' && value.trim() === value
    && ALIASABLE_SHOPIFY_SKU.test(value) && !RESERVED_ALIAS_PREFIX.test(value);
}

/** A SKU eBay accepts byte-for-byte, so it is its own eBay target. */
export function isDirectEbaySku(value: string): boolean {
  return DIRECT_EBAY_SKU.test(value) && !RESERVED_ALIAS_PREFIX.test(value);
}

/**
 * The eBay Inventory SKU for a Shopify SKU: the SKU itself when it is already
 * direct, otherwise its canonical `PP1_` alias. `null` when the SKU is empty,
 * outside the aliasable alphabet, or its alias would exceed eBay's
 * 50-character limit.
 */
export function ebayInventorySkuFor(rawSku: string): string | null {
  if (typeof rawSku === 'string' && isDirectEbaySku(rawSku)) return rawSku;
  if (!isRawSku(rawSku)) return null;
  let alias = EBAY_SKU_ALIAS_PREFIX;
  for (const byte of Buffer.from(rawSku, 'utf8')) {
    const character = String.fromCharCode(byte);
    alias += byte < 0x80 && UNESCAPED_BYTE.test(character)
      ? character
      : `_${byte.toString(16).toUpperCase().padStart(2, '0')}`;
    if (alias.length > EBAY_INVENTORY_SKU_MAX_LENGTH) return null;
  }
  return alias;
}

/** The Shopify SKU a canonical alias stands for; `null` for anything else. */
export function decodeEbaySkuAlias(value: string): string | null {
  if (typeof value !== 'string' || value.length > EBAY_INVENTORY_SKU_MAX_LENGTH
    || !ALIAS_GRAMMAR.test(value)) return null;
  const bytes: number[] = [];
  const body = value.slice(EBAY_SKU_ALIAS_PREFIX.length);
  for (let index = 0; index < body.length; index += 1) {
    if (body[index] === '_') {
      bytes.push(Number.parseInt(body.slice(index + 1, index + 3), 16));
      index += 2;
    } else {
      bytes.push(body.charCodeAt(index));
    }
  }
  let raw: string;
  try {
    raw = new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(bytes));
  } catch {
    return null;
  }
  return ebayInventorySkuFor(raw) === value ? raw : null;
}

/** A SKU a provider adapter may target: a direct SKU or a canonical alias. */
export function isEbayTargetSku(value: string): boolean {
  return typeof value === 'string'
    && (isDirectEbaySku(value) || decodeEbaySkuAlias(value) !== null);
}

/**
 * Whether an observed eBay SKU belongs to a Shopify SKU: its exact bytes (a
 * direct SKU, or a legacy Trading listing that kept the raw SKU) or its
 * canonical alias.
 */
export function ebaySkuMatchesShopifySku(ebaySku: string, shopifySku: string): boolean {
  return ebaySku === shopifySku
    || (ebaySku !== '' && ebayInventorySkuFor(shopifySku) === ebaySku);
}
