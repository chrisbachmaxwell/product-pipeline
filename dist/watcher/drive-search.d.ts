/**
 * drive-search.ts — Search for product photo folders.
 *
 * Supports two modes:
 *   - "local" (default): Reads directly from the mounted StyleShoots drive
 *   - "cloud": Reads from Google Cloud Storage bucket
 *
 * Config via env vars:
 *   DRIVE_MODE=local|cloud
 *   GCS_BUCKET=pictureline-product-photos
 *   GCS_PREFIX=UsedCameraGear/
 */
export declare function isCloudMode(): boolean;
export declare const GCS_BUCKET: string;
export interface DriveSearchResult {
    folderPath: string;
    presetName: string;
    folderName: string;
    imagePaths: string[];
    /** When mode=cloud, these are GCS URLs for downloading */
    imageUrls?: string[];
}
export interface GcsFolder {
    presetName: string;
    folderName: string;
    prefix: string;
}
/**
 * List all product folders in GCS by scanning prefixes.
 * Structure: GCS_PREFIX/<preset>/<product_folder>/<images>
 */
export declare function listGcsFolders(): Promise<GcsFolder[]>;
export declare function listGcsImages(prefix: string): Promise<string[]>;
export declare function isDriveMounted(drivePath?: string): boolean;
/**
 * Search for product photos, using the configured mode (local or cloud).
 */
export declare function searchDriveForProduct(productName: string, serialSuffix?: string | null, drivePath?: string): Promise<DriveSearchResult | null>;
/**
 * Download a cloud image to a temp file. Returns local path.
 * For local mode, returns the path as-is.
 */
export declare function resolveImagePath(imagePath: string): Promise<string>;
/**
 * Get public (non-signed) GCS URLs for image paths.
 * These are shorter and don't expire, making them suitable for eBay.
 * Requires the GCS bucket to have public read access.
 * Cloud mode only — local mode returns paths as-is.
 */
export declare function getPublicUrls(imagePaths: string[]): string[];
/**
 * Get accessible URLs for image paths.
 * Cloud mode: generates signed URLs (valid 7 days).
 * Local mode: returns paths as-is.
 */
export declare function getSignedUrls(imagePaths: string[]): Promise<string[]>;
/**
 * Upload a processed image buffer to GCS and return a signed URL.
 */
export declare function uploadProcessedImage(buffer: Buffer, filename: string): Promise<string>;
