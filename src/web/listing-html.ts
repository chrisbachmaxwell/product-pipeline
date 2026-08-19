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

export const LISTING_DESCRIPTION_MAX_LENGTH = 20_000;

/** Elements kept as plain, attribute-free tags. */
const CONTAINER_TAGS = new Set([
  'p', 'div', 'b', 'strong', 'i', 'em', 'u', 'ul', 'ol', 'li', 'h2', 'h3', 'span',
]);

/** Elements removed together with their entire content. */
const DROPPED_TAGS = new Set([
  'script', 'style', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet',
  'noscript', 'template', 'title', 'head', 'img', 'picture', 'source', 'video',
  'audio', 'track', 'canvas', 'svg', 'math', 'form', 'input', 'button', 'select',
  'option', 'textarea', 'link', 'meta', 'base', 'map', 'area', 'xmp', 'plaintext',
]);

const CONTROL_CHARACTERS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu;

const escapeText = (value: string): string => value
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;');

const escapeAttribute = (value: string): string =>
  escapeText(value).replaceAll('"', '&quot;');

/** Absolute http/https URL with no embedded credentials, else null. */
export const safeListingLinkHref = (value: string): string | null => {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (url.username !== '' || url.password !== '') return null;
    const serialized = url.toString().replaceAll(' ', '%20');
    return /^https?:\/\/[^\s"<>]+$/u.test(serialized) ? serialized : null;
  } catch {
    return null;
  }
};

const serializeChildren = (node: Node): string =>
  [...node.childNodes].map(serializeNode).join('');

const serializeNode = (node: Node): string => {
  if (node.nodeType === 3 /* TEXT_NODE */) return escapeText(node.nodeValue ?? '');
  if (node.nodeType !== 1 /* ELEMENT_NODE */) return '';
  const element = node as Element;
  const tag = element.tagName.toLowerCase();
  if (DROPPED_TAGS.has(tag)) return '';
  if (tag === 'br') return '<br>';
  const children = serializeChildren(element);
  if (tag === 'a') {
    const href = safeListingLinkHref(element.getAttribute('href') ?? '');
    return href === null ? children : `<a href="${escapeAttribute(href)}">${children}</a>`;
  }
  if (CONTAINER_TAGS.has(tag)) return `<${tag}>${children}</${tag}>`;
  // Unknown but harmless wrapper (section, font, …): keep its content only.
  return children;
};

/**
 * Sanitize untrusted HTML down to the strict allowlist above. Idempotent:
 * `sanitizeListingHtml(sanitizeListingHtml(x)) === sanitizeListingHtml(x)`.
 */
export const sanitizeListingHtml = (value: string): string => {
  if (!value) return '';
  if (typeof DOMParser === 'undefined') {
    // Non-browser fallback: never trust markup we cannot parse — strip it all.
    return escapeText(value.replace(/<[^>]*>/gu, ' '))
      .replace(CONTROL_CHARACTERS, '')
      .replace(/\s+/gu, ' ')
      .trim();
  }
  const parsed = new DOMParser().parseFromString(value, 'text/html');
  return serializeChildren(parsed.body)
    .replace(CONTROL_CHARACTERS, '')
    .trim();
};

/**
 * DOM-free check that a stored description contains only allowlisted,
 * attribute-free markup (plain text always passes). Shared with the
 * server-side draft-save validator so both sides enforce the same rule.
 */
export { isAllowlistedListingHtml } from '../shared/listing-html.js';
