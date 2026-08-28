export declare class ShopifyProductContentError extends Error {
    constructor();
}
export type ShopifyProductContent = Readonly<{
    /** Raw Shopify description HTML, or null when the product has none. */
    descriptionHtml: string | null;
    /** Product media, in Shopify order, already host- and shape-validated. */
    imageUrls: readonly string[];
}>;
type FetchLike = typeof fetch;
export declare function createShopifyProductContentReader(dependencies: Readonly<{
    getAccessToken: () => Promise<string>;
    fetchImpl?: FetchLike;
}>): (productGid: string) => Promise<ShopifyProductContent>;
export declare const SHOPIFY_PRODUCT_CONTENT_TESTING: Readonly<{
    MAX_IMAGES: 24;
    MAX_RESPONSE_BYTES: number;
    REQUEST_TIMEOUT_MS: 15000;
    MAX_DESCRIPTION_CHARACTERS: 500000;
    SHOPIFY_ADMIN_ORIGIN: "https://usedcameragear.myshopify.com";
    SHOPIFY_ADMIN_PATH: "/admin/api/2023-10/graphql.json";
}>;
export {};
