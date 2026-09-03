/**
 * Strict, dependency-free HTML handling for the local listing draft
 * description.
 *
 * Allowlist: p, br, div, b, strong, i, em, u, ul, ol, li, h2, h3,
 * a (href only, http/https), span (no attributes). Everything else —
 * event handlers, style/class attributes, scripts, iframes, images,
 * forms, embeds — is stripped. Text content is HTML-escaped on output,
 * so the sanitizer's result always satisfies `isAllowlistedListingHtml`.
 *
 * `sanitizeListingHtml` must run on any untrusted markup (including the
 * eBay-provided current description) before it enters a contentEditable
 * surface, and again on every value read back out of that surface.
 */
export declare const LISTING_DESCRIPTION_MAX_LENGTH = 20000;
/** Absolute http/https URL with no embedded credentials, else null. */
export declare const safeListingLinkHref: (value: string) => string | null;
/**
 * Sanitize untrusted HTML down to the strict allowlist above. Idempotent:
 * `sanitizeListingHtml(sanitizeListingHtml(x)) === sanitizeListingHtml(x)`.
 */
export declare const sanitizeListingHtml: (value: string) => string;
/**
 * DOM-free check that a stored description contains only allowlisted,
 * attribute-free markup (plain text always passes). Shared with the
 * server-side draft-save validator so both sides enforce the same rule.
 */
export { isAllowlistedListingHtml } from '../shared/listing-html.js';
