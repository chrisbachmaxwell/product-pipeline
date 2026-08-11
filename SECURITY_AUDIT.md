# eBay Sync App - Security Audit Report
*Conducted: February 11, 2026*

> **Historical report — superseded.** On 2026-08-11, a legacy production-like API key was found committed in `test-mappings.js` and mapping documentation. The current files have been redacted and the live mapping script is network-inert, but Git history still contains the former value. Treat that credential as exposed and rotate it through the authorized deployment owner. Current production API authorization must not trust the legacy API key; see `PROJECT_BRAIN.md` and `docs/READ_ONLY_PARITY.md`.

## Executive Summary

The original February report stated that the eBay Sync App was production-ready. That conclusion is superseded and must not be used as current assurance.

## Current correction — 2026-08-11

- Production API-key, query-key, Referer, and Origin authorization are no longer accepted. The shadow runtime requires a verified Shopify App Bridge session JWT for the exact app and Used Camera Gear store.
- Only migration status, projected local listings, and capability metadata API reads are mounted; legacy customer/order/log/settings/test and remote-reader routes are unmounted.
- All commerce writers remain hard-quarantined. This is a safety boundary, not Shopify/eBay/Marketplace Connect parity proof.
- The former hard-coded API key remains exposed in Git history and still requires external-owner rotation.
- CORS, rate limiting, redacted output, and local tests are defense-in-depth; they do not establish production security or platform identity by themselves.

## Security Issues Found & Fixed

### 🔐 **Authentication - historical implementation**
**Issue**: API endpoints were completely unprotected
**Impact**: Anyone could access sensitive order/product data and trigger operations
**Historical fix**:
- Added API key authentication middleware for all `/api/*` routes
- API key required via `X-API-Key` header or `api_key` query parameter
- Health endpoint remains public for monitoring

### ⚡ **Rate Limiting - historical implementation**
**Issue**: No rate limiting protection against abuse
**Impact**: API could be overwhelmed by rapid requests
**Fix**:
- Implemented token bucket rate limiting (100 requests/minute per IP)
- Returns proper HTTP 429 with rate limit headers
- Automatic token refill over time

### 🌐 **CORS Configuration - historical implementation**
**Issue**: CORS was too permissive (any *.shopify.com domain)
**Impact**: Potential cross-origin attacks from malicious subdomains
**Fix**:
- Restricted to specific known origins
- Added dynamic origin validation function
- Included app's own domain in allowed origins

### 🔒 **Error Handling - historical implementation**
**Issue**: Stack traces could be exposed in production
**Impact**: Information disclosure could aid attackers
**Fix**:
- Added global error handler
- Stack traces hidden in production (`NODE_ENV=production`)
- Proper error sanitization

### 🎣 **Webhook Security - historical implementation**
**Issue**: Shopify webhooks proceeded even with invalid signatures
**Impact**: Malicious webhook calls could trigger unintended actions
**Fix**:
- Signature verification now blocks processing on failure
- Improved error handling for missing raw body

### 💾 **Database Configuration - historical implementation**
**Issue**: Database path was hardcoded to local filesystem
**Impact**: No persistent storage on Railway platform
**Fix**:
- Updated to use `DATABASE_PATH` environment variable
- Configured Railway volume mounted at `/data`
- Backwards compatible with local development

## Historical findings that are no longer reliable

- **No hardcoded secrets** - Invalidated by the API key later found in tracked files and Git history
- **No SQL injection risks** - Uses parameterized queries throughout
- **Health endpoint appropriate** - Only exposes basic status, no sensitive data
- **No console.log secrets** - Logger utility used properly

## Railway Platform Configuration

### Volume Setup
- **Volume ID**: `ebc76fd4-d665-4953-a59e-389438c4326a`
- **Mount Path**: `/data`
- **Purpose**: Persistent SQLite database storage

### Environment Variables Set
| Variable | Value | Purpose |
|----------|-------|---------|
| `DATABASE_PATH` | `/data/ebaysync.db` | SQLite database location on volume |
| `NODE_ENV` | `production` | Enable production mode security |
| `API_KEY` | `ebay-sync-[random]` | API authentication key |

### Environment Variables Required (Not Yet Set)
Based on code analysis, these credentials will be needed:

#### eBay API Credentials
- `EBAY_APP_ID` - eBay application ID
- `EBAY_DEV_ID` - eBay developer ID  
- `EBAY_CERT_ID` - eBay certificate ID
- `EBAY_RU_NAME` - eBay RU name (optional)

#### Shopify API Credentials
- `SHOPIFY_CLIENT_ID` - Shopify app client ID
- `SHOPIFY_CLIENT_SECRET` - Shopify app secret
- `SHOPIFY_API_VERSION` - API version (optional, defaults to 2024-01)

## Deployment Status

✅ **Security fixes deployed** - Pushed to `chris` remote (auto-deploys)
✅ **Railway volume created** - Persistent storage configured
✅ **Core env vars set** - Database and security configuration complete

## Recommendations

1. **Set API credentials** - Configure the eBay and Shopify environment variables above
2. **Monitor logs** - Watch for auth failures and rate limit hits
3. **Credential remediation** - Rotate the historically exposed API key; do not distribute or restore production API-key authorization
4. **Regular updates** - Keep dependencies updated for security patches
5. **Backup strategy** - Consider periodic volume backups for the SQLite database

## Current security conclusion: not a production-parity attestation

The current shadow runtime is intentionally fail-closed, but this historical audit does not prove production security, current credential scope, external integration health, or replacement readiness. Use current source tests, `PROJECT_BRAIN.md`, `docs/WRITER_QUARANTINE.md`, and `docs/READ_ONLY_PARITY.md` for the active safety boundary and remaining blockers.
