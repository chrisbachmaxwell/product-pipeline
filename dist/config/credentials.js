import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const CREDENTIALS_DIR = path.join(os.homedir(), '.clawdbot', 'credentials');
const normalizeKey = (key) => key.trim().toLowerCase().replace(/\s+/g, '_');
const parseKeyValueFile = async (filePath) => {
    const contents = await fs.readFile(filePath, 'utf8');
    const lines = contents.split(/\r?\n/);
    const data = {};
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#'))
            continue;
        const separatorIndex = trimmed.indexOf('=') !== -1 ? trimmed.indexOf('=') : trimmed.indexOf(':');
        if (separatorIndex === -1)
            continue;
        const key = normalizeKey(trimmed.slice(0, separatorIndex));
        const value = trimmed.slice(separatorIndex + 1).trim();
        if (key && value)
            data[key] = value;
    }
    return data;
};
const required = (value, label) => {
    if (!value)
        throw new Error(`Missing credential: ${label}`);
    return value;
};
const safeParseFile = async (filePath) => {
    try {
        return await parseKeyValueFile(filePath);
    }
    catch {
        return {};
    }
};
const loadEbayCredentials = async () => {
    const filePath = path.join(CREDENTIALS_DIR, 'ebay-api.txt');
    const data = await safeParseFile(filePath);
    const appId = process.env.EBAY_APP_ID ||
        data.app_id ||
        data.appid ||
        data.client_id ||
        data.clientid ||
        data.application_id ||
        data.applicationid ||
        data['app_id_(client_id)'];
    const devId = process.env.EBAY_DEV_ID ||
        data.dev_id ||
        data.devid ||
        data.developer_id ||
        data.developerid;
    const certId = process.env.EBAY_CERT_ID ||
        data.cert_id ||
        data.certid ||
        data.client_secret ||
        data.clientsecret ||
        data.cert ||
        data.secret ||
        data['cert_id_(client_secret)'];
    const ruName = process.env.EBAY_RU_NAME || data.ru_name || data.runame || data.redirect_uri;
    return {
        appId: required(appId, 'eBay App ID'),
        devId: required(devId, 'eBay Dev ID'),
        certId: required(certId, 'eBay Cert ID'),
        ruName,
    };
};
const loadShopifyCredentials = async () => {
    const filePath = path.join(CREDENTIALS_DIR, 'shopify-usedcameragear-api.txt');
    // Production and ambiguous environments are environment-only. Credential
    // file fallback is retained solely for explicit local development and tests.
    const allowDevelopmentFile = process.env.NODE_ENV === 'development'
        || process.env.NODE_ENV === 'test';
    const data = allowDevelopmentFile ? await safeParseFile(filePath) : {};
    const clientId = process.env.SHOPIFY_CLIENT_ID ||
        data.client_id ||
        data.clientid ||
        data.api_key ||
        data.apikey;
    const clientSecret = process.env.SHOPIFY_CLIENT_SECRET ||
        data.client_secret ||
        data.clientsecret ||
        data.api_secret ||
        data.apisecret ||
        data.api_password ||
        data.apipassword;
    return {
        clientId: required(clientId, 'Shopify Client ID'),
        clientSecret: required(clientSecret, 'Shopify Client Secret'),
        storeDomain: 'usedcameragear.myshopify.com',
    };
};
export const loadCredentials = async () => {
    const [ebay, shopify] = await Promise.all([loadEbayCredentials(), loadShopifyCredentials()]);
    return { ebay, shopify };
};
export { loadEbayCredentials, loadShopifyCredentials };
