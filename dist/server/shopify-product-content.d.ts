/**
 * Manufacturer part number, derived by removing this store's unit tag.
 *
 * The store's convention, per the operator: the SKU is the manufacturer part
 * number, then `-U`, then the last three of that unit's serial number.
 * Everything from `-U` onward — including the `-U` itself — is the unit tag,
 * not the part number.
 *
 * An earlier version required digits after `-U`. That was wrong on real data:
 * serials contain letters and units can carry an extra tag, so
 * `SEL24F14GM-U84M-new` and `16443058-U` (2 of 174 live SKUs) were left whole.
 * The split is therefore on the LAST `-U`, which keeps a part number that
 * legitimately contains `-U` earlier in the string intact.
 *
 * Other trailing tags with no `-U` (`-OB` open box, `-DISP` display) are
 * condition markers whose relationship to the part number is not established,
 * so they are left alone: a slightly long MPN is harmless, an invented one is
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
