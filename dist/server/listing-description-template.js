/**
 * Deterministic branded eBay description renderer — the replacement for the
 * Marketplace Connect/Codisto description shell.
 *
 * `renderListingDescription` is a pure function: byte-identical output for
 * identical input, no dates, no randomness, no I/O. The input is validated
 * fail-closed (exact keys, bounded lengths, https-only image urls, and a
 * `bodyHtml` that must pass the shared attribute-free allowlist); every
 * attacker-controllable string except the already-allowlisted `bodyHtml` is
 * HTML-escaped on output. The rendered page contains no active content of
 * any kind: no script/iframe/object/embed/form elements, no event-handler
 * attributes, no `javascript:` urls, no external stylesheet links, and a
 * single namespaced `<style>` block with no `@import` and no `url(`.
 */
import { isAllowlistedListingHtml } from '../shared/listing-html.js';
import { EBAY_CONDITIONS } from '../shared/ebay-conditions.js';
export const LISTING_DESCRIPTION_TEMPLATE_VERSION = 'ucg-branded-v1';
const MAX_OUTPUT_BYTES = 400_000;
const MAX_TITLE_LENGTH = 80;
const MAX_CONDITION_NOTE_LENGTH = 1_000;
const MAX_BODY_HTML_LENGTH = 380_000;
const MAX_IMAGE_URLS = 24;
const MAX_IMAGE_URL_LENGTH = 2_048;
const SKU_PATTERN = /^[\x20-\x7e]{1,128}$/;
/** Control characters other than tab/newline/carriage-return never render. */
const FORBIDDEN_CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u;
/**
 * Camera-gear display phrasing overrides for the fixed eBay condition table.
 * Every other id renders its canonical marketplace label.
 */
const CONDITION_DISPLAY_OVERRIDES = Object.freeze({
    '1500': 'New other (open box)',
});
const CONDITION_LABELS = new Map(EBAY_CONDITIONS.map((option) => [
    option.id,
    CONDITION_DISPLAY_OVERRIDES[option.id] ?? option.label,
]));
export class ListingDescriptionTemplateError extends Error {
    code;
    constructor(code) {
        super('Listing description template rendering failed');
        this.code = code;
        this.name = 'ListingDescriptionTemplateError';
    }
}
const invalid = () => { throw new ListingDescriptionTemplateError('INVALID_INPUT'); };
function escapeHtml(value) {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}
function exactKeys(value, keys) {
    if (value === null || typeof value !== 'object' || Array.isArray(value))
        return false;
    const actual = Object.keys(value).sort();
    return JSON.stringify(actual) === JSON.stringify([...keys].sort());
}
function validate(value) {
    if (!exactKeys(value, [
        'templateVersion', 'title', 'bodyHtml', 'conditionId', 'conditionNote', 'imageUrls', 'sku',
    ]))
        return invalid();
    if (value.templateVersion !== LISTING_DESCRIPTION_TEMPLATE_VERSION)
        return invalid();
    const { title, bodyHtml, conditionId, conditionNote, imageUrls, sku } = value;
    if (typeof title !== 'string' || title.length === 0 || title.length > MAX_TITLE_LENGTH
        || FORBIDDEN_CONTROL.test(title))
        return invalid();
    if (typeof bodyHtml !== 'string' || bodyHtml.length > MAX_BODY_HTML_LENGTH
        || FORBIDDEN_CONTROL.test(bodyHtml) || !isAllowlistedListingHtml(bodyHtml))
        return invalid();
    if (conditionId !== null
        && (typeof conditionId !== 'string' || !CONDITION_LABELS.has(conditionId)))
        return invalid();
    if (conditionNote !== null
        && (typeof conditionNote !== 'string' || conditionNote.length === 0
            || conditionNote.length > MAX_CONDITION_NOTE_LENGTH
            || FORBIDDEN_CONTROL.test(conditionNote)))
        return invalid();
    if (!Array.isArray(imageUrls) || imageUrls.length > MAX_IMAGE_URLS)
        return invalid();
    for (const entry of imageUrls) {
        if (typeof entry !== 'string' || entry.length > MAX_IMAGE_URL_LENGTH)
            return invalid();
        let url;
        try {
            url = new URL(entry);
        }
        catch {
            return invalid();
        }
        if (url.protocol !== 'https:' || url.username !== '' || url.password !== '')
            return invalid();
    }
    if (typeof sku !== 'string' || !SKU_PATTERN.test(sku))
        return invalid();
    return Object.freeze({
        templateVersion: LISTING_DESCRIPTION_TEMPLATE_VERSION,
        title,
        bodyHtml,
        conditionId: conditionId,
        conditionNote: conditionNote,
        imageUrls: Object.freeze([...imageUrls]),
        sku,
    });
}
/**
 * One namespaced style block. Self-contained by construction: system font
 * stack only, explicit light-neutral colors on every surface (no inherited
 * or pure-white assumptions, so eBay's app dark mode keeps full contrast),
 * no `@import`, no `url(`, and a single ≤600px breakpoint.
 */
const STYLE_BLOCK = '<style>'
    + '.ucg-page{background:#faf9f7;color:#20242c;font-family:-apple-system,BlinkMacSystemFont,'
    + '"Segoe UI",Roboto,Helvetica,Arial,sans-serif;line-height:1.6;margin:0 auto;'
    + 'max-width:920px;padding:20px 16px 8px}'
    + '.ucg-page img{max-width:100%}'
    + '.ucg-header{align-items:baseline;border-bottom:1px solid #e4e0d8;display:flex;'
    + 'flex-wrap:wrap;gap:4px 16px;justify-content:space-between;padding-bottom:14px}'
    + '.ucg-wordmark{color:#20242c;font-size:22px;font-weight:700;letter-spacing:.4px}'
    + '.ucg-wordmark-accent{color:#b45309}'
    + '.ucg-tagline{color:#6b7280;font-size:13px}'
    + '.ucg-title{color:#20242c;font-size:26px;font-weight:700;line-height:1.25;margin:22px 0 10px}'
    + '.ucg-meta{align-items:center;display:flex;flex-wrap:wrap;gap:10px;margin:0 0 22px}'
    + '.ucg-condition{background:#fdf3e7;border:1px solid #ecc89a;border-radius:999px;'
    + 'color:#8a4a08;display:inline-block;font-size:13px;font-weight:600;padding:3px 12px}'
    + '.ucg-sku{color:#6b7280;font-size:13px}'
    + '.ucg-section{margin:0 0 26px}'
    + '.ucg-section-heading{border-bottom:1px solid #e4e0d8;color:#20242c;font-size:17px;'
    + 'font-weight:700;margin:0 0 12px;padding-bottom:6px}'
    + '.ucg-body{color:#374151;font-size:15px}'
    + '.ucg-body h2{color:#20242c;font-size:19px;margin:18px 0 8px}'
    + '.ucg-body h3{color:#20242c;font-size:16px;margin:16px 0 6px}'
    + '.ucg-body p,.ucg-body div{margin:0 0 12px}'
    + '.ucg-body ul,.ucg-body ol{margin:0 0 12px;padding-left:22px}'
    + '.ucg-body li{margin:0 0 4px}'
    + '.ucg-body a{color:#b45309}'
    + '.ucg-note{background:#f4f1ea;border-left:4px solid #b45309;border-radius:6px;'
    + 'color:#374151;font-size:15px;margin:0;padding:12px 16px}'
    + '.ucg-gallery{display:grid;gap:10px;grid-template-columns:repeat(auto-fill,minmax(180px,1fr))}'
    + '.ucg-gallery img{border:1px solid #e4e0d8;border-radius:8px;display:block;height:auto;'
    + 'width:100%}'
    + '.ucg-info{display:grid;gap:12px;grid-template-columns:repeat(3,1fr)}'
    + '.ucg-info-card{background:#fdfcfa;border:1px solid #e4e0d8;border-radius:10px;'
    + 'padding:14px 16px}'
    + '.ucg-info-title{color:#20242c;font-size:14px;font-weight:700;margin:0 0 4px}'
    + '.ucg-info-text{color:#4b5563;font-size:13px;margin:0}'
    + '.ucg-footer{align-items:baseline;border-top:1px solid #e4e0d8;color:#6b7280;display:flex;'
    + 'flex-wrap:wrap;font-size:13px;gap:8px;justify-content:space-between;margin-top:8px;'
    + 'padding:14px 0 18px}'
    + '.ucg-footer-mark{color:#20242c;font-weight:700}'
    + '.ucg-footer-mark .ucg-wordmark-accent{color:#b45309}'
    + '@media (max-width:600px){'
    + '.ucg-page{padding:14px 12px 6px}'
    + '.ucg-title{font-size:21px}'
    + '.ucg-info{grid-template-columns:1fr}'
    + '.ucg-gallery{grid-template-columns:repeat(auto-fill,minmax(140px,1fr))}'
    + '}'
    + '</style>';
const WORDMARK = '<span class="ucg-wordmark">usedcamera'
    + '<span class="ucg-wordmark-accent">gear</span>.com</span>';
const INFO_BLOCKS = '<div class="ucg-section ucg-info">'
    + '<div class="ucg-info-card"><p class="ucg-info-title">Fast, free shipping</p>'
    + '<p class="ucg-info-text">See the Shipping tab for the exact options and times '
    + 'for this item.</p></div>'
    + '<div class="ucg-info-card"><p class="ucg-info-title">Returns accepted</p>'
    + '<p class="ucg-info-text">See the Returns tab for the full return policy on '
    + 'this item.</p></div>'
    + '<div class="ucg-info-card"><p class="ucg-info-title">Questions?</p>'
    + '<p class="ucg-info-text">Use &#39;Ask seller a question&#39; and we will get '
    + 'back to you.</p></div>'
    + '</div>';
function conditionNoteHtml(note) {
    return escapeHtml(note).replace(/\r\n|\r|\n/g, '<br>');
}
/**
 * Render the complete branded description page for one listing. Throws
 * `ListingDescriptionTemplateError` (`INVALID_INPUT`) on any input that is
 * not exactly the documented shape, and `OUTPUT_TOO_LARGE` when the rendered
 * page would exceed the 400,000-byte bound.
 */
export function renderListingDescription(input) {
    const checked = validate(input);
    const title = escapeHtml(checked.title);
    const conditionLabel = checked.conditionId === null
        ? null
        : CONDITION_LABELS.get(checked.conditionId);
    const parts = [];
    parts.push(`<!-- template:${LISTING_DESCRIPTION_TEMPLATE_VERSION} -->`);
    parts.push('<div class="ucg-page">');
    parts.push(STYLE_BLOCK);
    parts.push(`<div class="ucg-header">${WORDMARK}`
        + '<span class="ucg-tagline">Quality used camera gear</span></div>');
    parts.push(`<h1 class="ucg-title">${title}</h1>`);
    const meta = [];
    if (conditionLabel !== null) {
        meta.push(`<span class="ucg-condition">${escapeHtml(conditionLabel)}</span>`);
    }
    meta.push(`<span class="ucg-sku">SKU: ${escapeHtml(checked.sku)}</span>`);
    parts.push(`<div class="ucg-meta">${meta.join('')}</div>`);
    if (checked.bodyHtml.length > 0) {
        parts.push('<div class="ucg-section"><h2 class="ucg-section-heading">Item description</h2>'
            + `<div class="ucg-body">${checked.bodyHtml}</div></div>`);
    }
    if (checked.conditionNote !== null) {
        parts.push('<div class="ucg-section"><h2 class="ucg-section-heading">Condition notes</h2>'
            + `<p class="ucg-note">${conditionNoteHtml(checked.conditionNote)}</p></div>`);
    }
    if (checked.imageUrls.length > 0) {
        const images = checked.imageUrls.map((url, index) => `<img src="${escapeHtml(url)}" alt="${title} — photo ${index + 1}" loading="lazy">`);
        parts.push('<div class="ucg-section"><h2 class="ucg-section-heading">Photos</h2>'
            + `<div class="ucg-gallery">${images.join('')}</div></div>`);
    }
    parts.push(INFO_BLOCKS);
    parts.push('<div class="ucg-footer">'
        + '<span class="ucg-footer-mark">usedcamera<span class="ucg-wordmark-accent">gear</span>'
        + '.com</span>'
        + '<span>© usedcameragear.com</span></div>');
    parts.push('</div>');
    const html = parts.join('\n');
    if (Buffer.byteLength(html, 'utf8') > MAX_OUTPUT_BYTES) {
        throw new ListingDescriptionTemplateError('OUTPUT_TOO_LARGE');
    }
    return html;
}
