import { loadCredentials } from '../config/credentials.js';
import { denyExternalWrite } from '../safety/writer-quarantine.js';

const EBAY_API_BASE = 'https://api.ebay.com';
const EBAY_OAUTH_TOKEN = `${EBAY_API_BASE}/identity/v1/oauth2/token`;

export type EbayToken = {
  accessToken: string;
  refreshToken?: string;
  expiresIn: number;
  tokenType: string;
  scope?: string;
};

const buildBasicAuth = (clientId: string, clientSecret: string): string => {
  const token = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  return `Basic ${token}`;
};

const parseTokenResponse = async (response: Response): Promise<EbayToken> => {
  const payload = (await response.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    token_type?: string;
    scope?: string;
    error?: string;
    error_description?: string;
  };

  if (!response.ok) {
    throw new Error(payload.error_description || payload.error || `eBay token request failed (${response.status})`);
  }

  if (!payload.access_token || !payload.expires_in || !payload.token_type) {
    throw new Error('eBay token response missing required fields');
  }

  return {
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token,
    expiresIn: payload.expires_in,
    tokenType: payload.token_type,
    scope: payload.scope,
  };
};

export const requestEbayAppToken = async (scopes: string[]): Promise<EbayToken> => {
  const { ebay } = await loadCredentials();
  const response = await fetch(EBAY_OAUTH_TOKEN, {
    method: 'POST',
    headers: {
      Authorization: buildBasicAuth(ebay.appId, ebay.certId),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      scope: scopes.join(' '),
    }),
  });

  return parseTokenResponse(response);
};

export const exchangeEbayAuthCode = async (code: string, redirectUri: string): Promise<EbayToken> => {
  const { ebay } = await loadCredentials();
  const response = await fetch(EBAY_OAUTH_TOKEN, {
    method: 'POST',
    headers: {
      Authorization: buildBasicAuth(ebay.appId, ebay.certId),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
    }),
  });

  return parseTokenResponse(response);
};

export const refreshEbayUserToken = async (refreshToken: string, scopes: string[]): Promise<EbayToken> => {
  const { ebay } = await loadCredentials();
  const response = await fetch(EBAY_OAUTH_TOKEN, {
    method: 'POST',
    headers: {
      Authorization: buildBasicAuth(ebay.appId, ebay.certId),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      scope: scopes.join(' '),
    }),
  });

  return parseTokenResponse(response);
};

export type EbayRequestOptions = {
  method?: string;
  path: string;
  accessToken: string;
  body?: unknown;
  headers?: Record<string, string>;
};

export const ebayRequest = async <T>({
  method = 'GET',
  path,
  accessToken,
  body,
  headers = {},
}: EbayRequestOptions): Promise<T> => {
  const normalizedMethod = method.toUpperCase();
  if (!['GET', 'HEAD'].includes(normalizedMethod)) {
    denyExternalWrite('externalCommerce', `eBay ${normalizedMethod} ${path}`);
  }

  const response = await fetch(`${EBAY_API_BASE}${path}`, {
    method: normalizedMethod,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'Accept-Language': 'en-US',
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`eBay API request failed (${response.status}): ${text}`);
  }

  // eBay returns 204 No Content for successful PUT/DELETE operations
  if (response.status === 204 || response.headers.get('content-length') === '0') {
    return undefined as unknown as T;
  }

  const text = await response.text();
  if (!text) return undefined as unknown as T;
  return JSON.parse(text) as T;
};
