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
import fs from 'node:fs';
import path from 'node:path';
import { parseFolderName, isImageFile } from './folder-parser.js';
import { info, warn } from '../utils/logger.js';
const DEFAULT_DRIVE_PATH = '/Volumes/StyleShootsDrive/UsedCameraGear/';
const DRIVE_MODE = process.env.DRIVE_MODE ?? 'local';
export function isCloudMode() {
    return DRIVE_MODE === 'cloud';
}
export const GCS_BUCKET = process.env.GCS_BUCKET ?? 'pictureline-product-photos';
const GCS_PREFIX = process.env.GCS_PREFIX ?? 'UsedCameraGear/';
// ── Tokenization & Matching ────────────────────────────────────────────
function extractSerial(str) {
    const m = str.match(/#\s*(\d+)/);
    return m ? m[1] : null;
}
function tokenize(str) {
    return str
        .toLowerCase()
        .replace(/[^a-z0-9\s\-\.]/g, ' ')
        .split(/[\s\-]+/)
        .filter(t => t.length > 0);
}
function tokenOverlapDir(from, in_) {
    if (from.length === 0)
        return 0;
    let matches = 0;
    for (const token of from) {
        if (in_.includes(token)) {
            matches++;
            continue;
        }
        for (const target of in_) {
            if (target.includes(token) || token.includes(target)) {
                matches += 0.5;
                break;
            }
        }
    }
    return matches / from.length;
}
function matchScore(shopifyName, folderName, folderSerial) {
    const shopifySerial = extractSerial(shopifyName);
    const shopifyTokens = tokenize(shopifyName);
    const folderTokens = tokenize(folderName);
    if (shopifySerial && folderSerial && shopifySerial === folderSerial) {
        const folderNonSerial = folderTokens.filter(t => t !== folderSerial);
        if (folderNonSerial.length === 0)
            return 0.95;
        const overlap = tokenOverlapDir(folderNonSerial, shopifyTokens);
        return 0.90 + (overlap * 0.10);
    }
    if (shopifySerial && folderSerial && shopifySerial !== folderSerial) {
        return 0;
    }
    const folder2shopify = tokenOverlapDir(folderTokens, shopifyTokens);
    const shopify2folder = tokenOverlapDir(shopifyTokens, folderTokens);
    return Math.max(folder2shopify, shopify2folder);
}
// ── Cloud (GCS) Backend ────────────────────────────────────────────────
let _gcsStorage = null;
async function getGcsStorage() {
    if (!_gcsStorage) {
        const { Storage } = await import('@google-cloud/storage');
        // Support GOOGLE_APPLICATION_CREDENTIALS_JSON env var (Railway)
        const credsJson = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
        if (credsJson && !process.env.GOOGLE_APPLICATION_CREDENTIALS) {
            const fs = await import('fs');
            const path = '/tmp/gcs-credentials.json';
            fs.writeFileSync(path, credsJson);
            process.env.GOOGLE_APPLICATION_CREDENTIALS = path;
        }
        _gcsStorage = new Storage({ projectId: process.env.GCS_PROJECT_ID });
    }
    return _gcsStorage;
}
/**
 * List all product folders in GCS by scanning prefixes.
 * Structure: GCS_PREFIX/<preset>/<product_folder>/<images>
 */
export async function listGcsFolders() {
    const storage = await getGcsStorage();
    const bucket = storage.bucket(GCS_BUCKET);
    // List "preset" level prefixes
    const [, , apiResponse] = await bucket.getFiles({
        prefix: GCS_PREFIX,
        delimiter: '/',
        autoPaginate: false,
    });
    const presetPrefixes = apiResponse?.prefixes ?? [];
    const folders = [];
    for (const presetPrefix of presetPrefixes) {
        const presetName = presetPrefix.replace(GCS_PREFIX, '').replace(/\/$/, '');
        if (!presetName || presetName.startsWith('.'))
            continue;
        // List product folder prefixes within this preset
        const [, , presetResponse] = await bucket.getFiles({
            prefix: presetPrefix,
            delimiter: '/',
            autoPaginate: false,
        });
        const productPrefixes = presetResponse?.prefixes ?? [];
        for (const productPrefix of productPrefixes) {
            const folderName = productPrefix.replace(presetPrefix, '').replace(/\/$/, '');
            if (!folderName || folderName.startsWith('.'))
                continue;
            folders.push({ presetName, folderName, prefix: productPrefix });
        }
    }
    return folders;
}
export async function listGcsImages(prefix) {
    const storage = await getGcsStorage();
    const bucket = storage.bucket(GCS_BUCKET);
    const [files] = await bucket.getFiles({ prefix });
    return files
        .map((f) => f.name)
        .filter((name) => {
        const basename = path.basename(name);
        return isImageFile(basename);
    })
        .sort();
}
function gcsPublicUrl(objectName) {
    return `https://storage.googleapis.com/${GCS_BUCKET}/${objectName}`;
}
async function gcsSignedUrl(objectName) {
    const storage = await getGcsStorage();
    const [url] = await storage
        .bucket(GCS_BUCKET)
        .file(objectName)
        .getSignedUrl({
        action: 'read',
        expires: Date.now() + 60 * 60 * 1000, // 1 hour
    });
    return url;
}
async function searchCloudForProduct(productName) {
    const folders = await listGcsFolders();
    let bestMatch = null;
    for (const folder of folders) {
        const parsed = parseFolderName(folder.folderName);
        const score = matchScore(productName, parsed.productName, parsed.serialSuffix);
        if (score >= 0.7 && (!bestMatch || score > bestMatch.score)) {
            const imageKeys = await listGcsImages(folder.prefix);
            if (imageKeys.length > 0) {
                const imageUrls = imageKeys.map(gcsPublicUrl);
                bestMatch = {
                    result: {
                        folderPath: `gs://${GCS_BUCKET}/${folder.prefix}`,
                        presetName: folder.presetName,
                        folderName: folder.folderName,
                        imagePaths: imageKeys, // GCS object keys
                        imageUrls,
                    },
                    score,
                };
            }
        }
    }
    if (bestMatch) {
        info(`[DriveSearch:cloud] Found match for "${productName}": ${bestMatch.result.presetName}/${bestMatch.result.folderName} (${bestMatch.result.imagePaths.length} images, score: ${bestMatch.score.toFixed(2)})`);
    }
    return bestMatch?.result ?? null;
}
// ── Local Backend ──────────────────────────────────────────────────────
export function isDriveMounted(drivePath) {
    // In cloud mode, we don't need a local drive
    if (DRIVE_MODE === 'cloud')
        return true;
    try {
        fs.accessSync(drivePath ?? DEFAULT_DRIVE_PATH, fs.constants.R_OK);
        return true;
    }
    catch {
        return false;
    }
}
function collectImages(folderPath) {
    try {
        return fs.readdirSync(folderPath)
            .filter(isImageFile)
            .sort()
            .map(f => path.join(folderPath, f));
    }
    catch {
        return [];
    }
}
async function searchLocalForProduct(productName, drivePath) {
    const basePath = drivePath ?? DEFAULT_DRIVE_PATH;
    if (!isDriveMounted(basePath)) {
        warn('[DriveSearch:local] StyleShoots drive is not mounted');
        return null;
    }
    let bestMatch = null;
    try {
        const presets = fs.readdirSync(basePath, { withFileTypes: true });
        for (const preset of presets) {
            if (!preset.isDirectory() || preset.name.startsWith('.'))
                continue;
            const presetPath = path.join(basePath, preset.name);
            let productDirs;
            try {
                productDirs = fs.readdirSync(presetPath, { withFileTypes: true });
            }
            catch {
                continue;
            }
            for (const dir of productDirs) {
                if (!dir.isDirectory() || dir.name.startsWith('.'))
                    continue;
                const parsed = parseFolderName(dir.name);
                const score = matchScore(productName, parsed.productName, parsed.serialSuffix);
                if (score >= 0.7 && (!bestMatch || score > bestMatch.score)) {
                    const folderPath = path.join(presetPath, dir.name);
                    const imagePaths = collectImages(folderPath);
                    if (imagePaths.length > 0) {
                        bestMatch = {
                            result: { folderPath, presetName: preset.name, folderName: dir.name, imagePaths },
                            score,
                        };
                    }
                }
            }
        }
    }
    catch (err) {
        warn(`[DriveSearch:local] Error scanning drive: ${err}`);
        return null;
    }
    if (bestMatch) {
        info(`[DriveSearch:local] Found match for "${productName}": ${bestMatch.result.presetName}/${bestMatch.result.folderName} (${bestMatch.result.imagePaths.length} images, score: ${bestMatch.score.toFixed(2)})`);
    }
    return bestMatch?.result ?? null;
}
// ── Public API ─────────────────────────────────────────────────────────
/**
 * Search for product photos, using the configured mode (local or cloud).
 */
export async function searchDriveForProduct(productName, serialSuffix, drivePath) {
    if (DRIVE_MODE === 'cloud') {
        return searchCloudForProduct(productName);
    }
    return searchLocalForProduct(productName, drivePath);
}
/**
 * Download a cloud image to a temp file. Returns local path.
 * For local mode, returns the path as-is.
 */
export async function resolveImagePath(imagePath) {
    if (DRIVE_MODE !== 'cloud')
        return imagePath;
    // imagePath is a GCS object key — download to temp
    const storage = await getGcsStorage();
    const tmpDir = path.join(process.env.TMPDIR ?? '/tmp', 'styleshoots-cache');
    if (!fs.existsSync(tmpDir))
        fs.mkdirSync(tmpDir, { recursive: true });
    const localPath = path.join(tmpDir, path.basename(imagePath));
    await storage.bucket(GCS_BUCKET).file(imagePath).download({ destination: localPath });
    return localPath;
}
/**
 * Get public (non-signed) GCS URLs for image paths.
 * These are shorter and don't expire, making them suitable for eBay.
 * Requires the GCS bucket to have public read access.
 * Cloud mode only — local mode returns paths as-is.
 */
export function getPublicUrls(imagePaths) {
    if (DRIVE_MODE !== 'cloud')
        return imagePaths;
    return imagePaths.map((p) => gcsPublicUrl(p));
}
/**
 * Get accessible URLs for image paths.
 * Cloud mode: generates signed URLs (valid 7 days).
 * Local mode: returns paths as-is.
 */
export async function getSignedUrls(imagePaths) {
    if (DRIVE_MODE !== 'cloud')
        return imagePaths;
    const storage = await getGcsStorage();
    const bucket = storage.bucket(GCS_BUCKET);
    const urls = [];
    for (const p of imagePaths) {
        const [url] = await bucket.file(p).getSignedUrl({
            action: 'read',
            expires: Date.now() + 7 * 24 * 60 * 60 * 1000, // 7 days
        });
        urls.push(url);
    }
    return urls;
}
/**
 * Upload a processed image buffer to GCS and return a signed URL.
 */
export async function uploadProcessedImage(buffer, filename) {
    if (DRIVE_MODE !== 'cloud') {
        // In local mode, save to temp and return path
        const tmpDir = path.join(process.env.TMPDIR ?? '/tmp', 'processed-images');
        if (!fs.existsSync(tmpDir))
            fs.mkdirSync(tmpDir, { recursive: true });
        const localPath = path.join(tmpDir, filename);
        fs.writeFileSync(localPath, buffer);
        return localPath;
    }
    const storage = await getGcsStorage();
    const bucket = storage.bucket(GCS_BUCKET);
    const gcsPath = `processed/${filename}`;
    const file = bucket.file(gcsPath);
    await file.save(buffer, { contentType: 'image/png' });
    const [url] = await file.getSignedUrl({
        action: 'read',
        expires: Date.now() + 7 * 24 * 60 * 60 * 1000,
    });
    return url;
}
