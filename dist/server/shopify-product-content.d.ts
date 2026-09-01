/**
 * Manufacturer part number, derived by removing this store's per-unit suffix.
 *
 * Verified against the live catalog: SKUs are the manufacturer part number
 * plus a unit tag — `ILCE7M3/B-U406` -> `ILCE7M3/B`, `2882A001-U002` ->
 * `2882A001`, `MT-24EX-U167` -> `MT-24EX`.
 *
 * ONLY the `-U<digits>` unit suffix is stripped. Other trailing tags seen in
 * the catalog (`-OB` open box, `-DISP` display) are condition markers whose
 * relationship to the part number is not established, so they are left
 * intact: emitting a slightly long MPN is harmless, inventing a wrong one is
 * not. MPN is an optional free-text aspect on eBay.
 */
export declare function mpnFromSku(sku: string | null | undefined): string | null;
/**
 * Normalized GTIN from the Shopify barcode field, or null when it is absent
 * or not a recognizable UPC/EAN.
 *
 * The live catalog stores the same product's UPC inconsistently — A7 III
 * units carry both `027242910768` and `27242910768`. eBay treats those as
 * different products, so an 11-digit value is zero-padded to a 12-digit
 * UPC-A. Only 12-digit (UPC-A) and 13-digit (EAN-13) results are accepted.
 */
export declare function normalizedGtin(barcode: string | null | undefined): string | null;
/**
 * Brand from the Shopify vendor field, or null when it cannot be trusted.
 *
 * Verified populated across the catalog (Canon, Leica, Fujifilm, Sony,
 * Aputure, Hasselblad, Tamron, DJI). The guard exists because at least one
 * product carried the STORE name in `vendor` instead of a real brand, and
 * listing "usedcameragear" as the Brand is worse than leaving it for the
 * operator: this returns null so the field stays visibly empty.
 */
export declare function brandFromVendor(vendor: string | null | undefined, storeName: string): string | null;
export declare class ShopifyProductContentError extends Error {
    constructor();
}
export type ShopifyProductContent = Readonly<{
    /** Raw Shopify description HTML, or null when the product has none. */
    descriptionHtml: string | null;
    /** Product media, in Shopify order, already host- and shape-validated. */
    imageUrls: readonly string[];
    /** Shopify `vendor`, when it is a trustworthy brand. eBay aspect "Brand". */
    brand: string | null;
    /** SKU minus the unit suffix. eBay aspect "MPN". */
    mpn: string | null;
    /** Normalized 12/13-digit GTIN from the variant barcode. */
    upc: string | null;
}>;
type FetchLike = typeof fetch;
export declare function createShopifyProductContentReader(dependencies: Readonly<{
    getAccessToken: () => Promise<string>;
    fetchImpl?: FetchLike;
}>): (productGid: string, variantGid: string) => Promise<ShopifyProductContent>;
export declare const SHOPIFY_PRODUCT_CONTENT_TESTING: Readonly<{
    MAX_IMAGES: 24;
    MAX_RESPONSE_BYTES: number;
    REQUEST_TIMEOUT_MS: 15000;
    MAX_DESCRIPTION_CHARACTERS: 500000;
    SHOPIFY_ADMIN_ORIGIN: "https://usedcameragear.myshopify.com";
    SHOPIFY_ADMIN_PATH: "/admin/api/2023-10/graphql.json";
}>;
export {};
