/**
 * TIM (TradeInManager) Service
 * Fetches and caches items from trades.pictureline.com API
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { info, error as logError } from '../utils/logger.js';
const CREDENTIALS_DIR = path.join(os.homedir(), '.clawdbot', 'credentials');
const TIM_BASE_URL = 'https://trades.pictureline.com';
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
let cachedItems = null;
let cacheTimestamp = 0;
let sessionCookie = null;
let sessionExpiry = 0;
async function getTimCredentials() {
    const email = process.env.TIM_EMAIL;
    if (!email) {
        throw new Error('TIM_EMAIL is required; no service-account identity is embedded in source');
    }
    // Try env var first (Railway), then fall back to the legacy password file.
    if (process.env.TIM_PASSWORD) {
        return { email, password: process.env.TIM_PASSWORD };
    }
    const password = (await fs.readFile(path.join(CREDENTIALS_DIR, 'tradeinmanager.txt'), 'utf8')).trim();
    return { email, password };
}
async function authenticate() {
    if (sessionCookie && Date.now() < sessionExpiry) {
        return sessionCookie;
    }
    const creds = await getTimCredentials();
    const response = await fetch(`${TIM_BASE_URL}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(creds),
    });
    if (!response.ok) {
        throw new Error(`TIM auth failed: ${response.status}`);
    }
    const cookies = response.headers.getSetCookie?.() ?? [];
    const sidCookie = cookies.find(c => c.startsWith('connect.sid='));
    if (!sidCookie) {
        throw new Error('TIM auth: no session cookie returned');
    }
    const cookieValue = sidCookie.split(';')[0];
    sessionCookie = cookieValue;
    // Session valid for ~30 days, refresh every 6 hours to be safe
    sessionExpiry = Date.now() + 6 * 60 * 60 * 1000;
    info('[TIM] Authenticated successfully');
    return cookieValue;
}
export async function fetchTimItems(forceRefresh = false) {
    if (!forceRefresh && cachedItems && Date.now() - cacheTimestamp < CACHE_TTL_MS) {
        return cachedItems;
    }
    try {
        const cookie = await authenticate();
        const response = await fetch(`${TIM_BASE_URL}/api/items`, {
            headers: { Cookie: cookie },
        });
        if (!response.ok) {
            // If session expired, clear and retry once
            if (response.status === 401 || response.status === 403) {
                sessionCookie = null;
                sessionExpiry = 0;
                const newCookie = await authenticate();
                const retry = await fetch(`${TIM_BASE_URL}/api/items`, {
                    headers: { Cookie: newCookie },
                });
                if (!retry.ok)
                    throw new Error(`TIM API error: ${retry.status}`);
                cachedItems = await retry.json();
            }
            else {
                throw new Error(`TIM API error: ${response.status}`);
            }
        }
        else {
            cachedItems = await response.json();
        }
        cacheTimestamp = Date.now();
        info(`[TIM] Fetched ${cachedItems.length} items`);
        return cachedItems;
    }
    catch (err) {
        logError(`[TIM] Failed to fetch items: ${err}`);
        // Return stale cache if available
        if (cachedItems)
            return cachedItems;
        throw err;
    }
}
export function clearTimCache() {
    cachedItems = null;
    cacheTimestamp = 0;
}
