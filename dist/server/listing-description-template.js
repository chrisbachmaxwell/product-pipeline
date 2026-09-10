/**
 * Deterministic branded eBay description renderer — the replacement for the
 * Marketplace Connect/Codisto description shell, with visual parity to it:
 * grey page with white content cards, the store's real logo, the merchant's
 * rich description markup, a CSS-only image gallery (hero + `:target`
 * lightboxes + thumbnails), a shipping/payment info section, and CSS-only
 * radio-button tabs (Contact / Shipping & Payments / Payment / Returns).
 *
 * `renderListingDescription` is a pure function: byte-identical output for
 * identical input, no dates, no randomness, no I/O. The input is validated
 * fail-closed (exact keys, bounded lengths, https-only image urls, and a
 * `bodyHtml` that must pass the shared attribute-free allowlist); every
 * attacker-controllable string except the already-allowlisted `bodyHtml` is
 * HTML-escaped on output. The rendered page contains no active content: no
 * script/iframe/object/embed/form elements, no event-handler attributes, no
 * `javascript:` urls, no external stylesheet links, and a single namespaced
 * `<style>` block with no `@import` and no `url(`. The gallery lightboxes
 * and the tabs are driven purely by CSS `:target` and `:checked` state (bare
 * radio `<input>`s outside any `<form>`, exactly as the Codisto template
 * eBay served for years) — no JavaScript exists anywhere in the output.
 */
import { isAllowlistedListingHtml } from '../shared/listing-html.js';
import { EBAY_CONDITIONS } from '../shared/ebay-conditions.js';
export const LISTING_DESCRIPTION_TEMPLATE_VERSION = 'ucg-branded-v2';
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
 * The store's live header logo, served from its own domain (Shopify CDN
 * behind it). Hotlinking our own storefront asset is exactly what the
 * Codisto template did with its CDN copy of the same logo.
 */
const STORE_LOGO_URL = 'https://usedcameragear.com/cdn/shop/files/USedCameraGearLogos_FINAL-05.png?v=1709933634&width=400';
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
 * Shopify's image CDN resizes on the fly via `width`/`height` query
 * parameters; other hosts get the original url for every role. Deterministic
 * string append — no URL re-serialization that could reorder parameters.
 */
function sizedImageUrl(rawUrl, params) {
    let host = '';
    try {
        host = new URL(rawUrl).hostname;
    }
    catch {
        return rawUrl;
    }
    const shopifyCdn = host === 'cdn.shopify.com'
        || host.endsWith('.shopifycdn.com')
        || host === 'usedcameragear.com';
    if (!shopifyCdn)
        return rawUrl;
    return rawUrl + (rawUrl.includes('?') ? '&' : '?') + params;
}
/**
 * One namespaced style block. Self-contained by construction: system font
 * stack only, explicit colors on every surface (no inherited or pure-white
 * assumptions, so eBay's app dark mode keeps full contrast), no `@import`,
 * no `url(`, and a single ≤640px breakpoint. The `.ucg-lightbox` and
 * `.ucg-tab` rules replicate the Codisto CSS-only mechanics (`:target`
 * overlays and `:checked` tab panels).
 */
const STYLE_BLOCK = '<style>'
    + '.ucg-page{background:#ececec;color:#20242c;font-family:-apple-system,BlinkMacSystemFont,'
    + '"Segoe UI",Roboto,Helvetica,Arial,sans-serif;line-height:1.6;margin:0;'
    + 'padding:18px 10px 8px}'
    + '.ucg-shell{margin:0 auto;max-width:980px}'
    + '.ucg-page img{max-width:100%}'
    + '.ucg-card{background:#ffffff;border:1px solid #ddd9d0;border-radius:8px;'
    + 'box-shadow:0 1px 3px rgba(0,0,0,.06);margin:0 0 16px;padding:22px 26px}'
    + '.ucg-brandbar{align-items:center;display:flex;flex-wrap:wrap;gap:8px 16px;'
    + 'justify-content:space-between}'
    + '.ucg-logo{height:46px;width:auto}'
    + '.ucg-wordmark{color:#20242c;font-size:22px;font-weight:700;letter-spacing:.4px}'
    + '.ucg-wordmark-accent{color:#b45309}'
    + '.ucg-tagline{color:#6b7280;font-size:13px}'
    + '.ucg-title{color:#20242c;font-size:26px;font-weight:700;line-height:1.25;margin:0 0 8px}'
    + '.ucg-meta{align-items:center;display:flex;flex-wrap:wrap;gap:10px;margin:0 0 18px}'
    + '.ucg-condition{background:#fdf3e7;border:1px solid #ecc89a;border-radius:999px;'
    + 'color:#8a4a08;display:inline-block;font-size:13px;font-weight:600;padding:3px 12px}'
    + '.ucg-sku{color:#6b7280;font-size:13px}'
    + '.ucg-body{color:#374151;font-size:15px}'
    + '.ucg-body h2{color:#20242c;font-size:19px;margin:18px 0 8px}'
    + '.ucg-body h3{color:#20242c;font-size:16px;margin:16px 0 6px}'
    + '.ucg-body p,.ucg-body div{margin:0 0 12px}'
    + '.ucg-body ul,.ucg-body ol{margin:0 0 12px;padding-left:22px}'
    + '.ucg-body li{margin:0 0 4px}'
    + '.ucg-body a{color:#b45309}'
    + '.ucg-note{background:#f4f1ea;border-left:4px solid #b45309;border-radius:6px;'
    + 'color:#374151;font-size:15px;margin:14px 0 0;padding:12px 16px}'
    + '.ucg-section-heading{border-bottom:1px solid #e4e0d8;color:#20242c;font-size:18px;'
    + 'font-weight:700;margin:0 0 14px;padding-bottom:8px}'
    + '.ucg-hero{margin:20px 0 6px;text-align:center}'
    + '.ucg-hero img{border:1px solid #e4e0d8;border-radius:8px;max-height:520px;width:auto}'
    + '.ucg-thumbs{display:flex;flex-wrap:wrap;gap:10px;justify-content:center;margin:10px 0 4px}'
    + '.ucg-thumbs a{border:1px solid #e4e0d8;border-radius:8px;display:block;line-height:0;'
    + 'padding:4px}'
    + '.ucg-thumbs img{border-radius:5px;height:120px;object-fit:contain;width:120px}'
    + '.ucg-lightbox{background:rgba(15,15,15,.88);height:100%;left:0;opacity:0;'
    + 'position:fixed;text-align:center;top:-9999px;width:100%;z-index:999}'
    + '.ucg-lightbox:target{opacity:1;top:0}'
    + '.ucg-lightbox img{margin-top:2%;max-height:88%;max-width:92%}'
    + '.ucg-close{color:#ffffff;font-size:44px;font-weight:700;line-height:1;'
    + 'position:absolute;right:18px;top:10px}'
    + '.ucg-info{display:grid;gap:14px;grid-template-columns:repeat(3,1fr)}'
    + '.ucg-info-card{background:#fbfaf7;border:1px solid #e4e0d8;border-radius:10px;'
    + 'padding:14px 16px}'
    + '.ucg-info-title{color:#20242c;font-size:14px;font-weight:700;margin:0 0 6px}'
    + '.ucg-info-text{color:#4b5563;font-size:13px;margin:0 0 8px}'
    + '.ucg-tabs{margin:0 0 16px;min-height:330px;position:relative}'
    + '.ucg-tab{float:left}'
    + '.ucg-tab [type=radio]{display:none}'
    + '.ucg-tab-label{background:#e5e1d8;border:1px solid #ccc7bb;border-radius:8px 8px 0 0;'
    + 'box-sizing:border-box;color:#374151;cursor:pointer;display:block;font-size:14px;'
    + 'font-weight:600;height:42px;line-height:20px;margin-right:4px;padding:10px 18px}'
    + '.ucg-tab [type=radio]:checked+.ucg-tab-label{background:#ffffff;'
    + 'border-bottom-color:#ffffff;color:#20242c}'
    + '.ucg-tabpanel{background:#ffffff;border:1px solid #ccc7bb;border-radius:0 8px 8px 8px;'
    + 'box-shadow:0 1px 3px rgba(0,0,0,.06);color:#374151;font-size:14px;height:270px;'
    + 'left:0;overflow:auto;padding:18px 22px;position:absolute;right:0;top:41px;'
    + 'visibility:hidden;z-index:1}'
    + '.ucg-tab [type=radio]:checked~.ucg-tabpanel{visibility:visible;z-index:2}'
    + '.ucg-tabpanel p{margin:0 0 10px}'
    + '.ucg-footer{align-items:baseline;color:#6b7280;display:flex;flex-wrap:wrap;'
    + 'font-size:13px;gap:8px;justify-content:space-between;padding:4px 6px 16px}'
    + '.ucg-footer-mark{color:#20242c;font-weight:700}'
    + '.ucg-footer-mark .ucg-wordmark-accent{color:#b45309}'
    + '@media (max-width:640px){'
    + '.ucg-page{padding:12px 6px 6px}'
    + '.ucg-card{padding:16px 14px}'
    + '.ucg-title{font-size:21px}'
    + '.ucg-info{grid-template-columns:1fr}'
    + '.ucg-thumbs img{height:88px;width:88px}'
    + '.ucg-tab-label{font-size:12px;padding:12px 8px}'
    + '}'
    + '</style>';
const WORDMARK = '<span class="ucg-wordmark">usedcamera'
    + '<span class="ucg-wordmark-accent">gear</span>.com</span>';
const PAYMENT_TEXT = '<p>Immediate payment is required upon selecting &#39;Buy It Now&#39; or upon checking out '
    + 'through the cart.</p>'
    + '<p>We accept all major credit and debit cards, PayPal, and Google Pay through eBay '
    + 'checkout.</p>'
    + '<p>We are legally required to collect sales tax in those states and localities where we '
    + 'maintain a physical presence (nexus). The applicable amount of sales tax charged to an '
    + 'order is calculated based on the shipment destination&#39;s state and local sales tax '
    + 'laws.</p>'
    + '<p>Thank you for shopping with us on eBay!</p>';
const INFO_SECTION = '<div class="ucg-card">'
    + '<h2 class="ucg-section-heading">Shipping info</h2>'
    + '<div class="ucg-info">'
    + '<div class="ucg-info-card"><p class="ucg-info-title">Fast, free shipping</p>'
    + '<p class="ucg-info-text">Shipping is FREE for this item. See the Shipping &amp; Payments '
    + 'tab below for details.</p></div>'
    + '<div class="ucg-info-card"><p class="ucg-info-title">Payment</p>'
    + '<p class="ucg-info-text">Immediate payment through eBay checkout. All major cards, '
    + 'PayPal, and Google Pay accepted.</p></div>'
    + '<div class="ucg-info-card"><p class="ucg-info-title">Questions?</p>'
    + '<p class="ucg-info-text">Use &#39;Ask seller a question&#39; on this listing and our '
    + 'team will get back to you.</p></div>'
    + '</div></div>';
const TABS_SECTION = '<div class="ucg-tabs">'
    + '<div class="ucg-tab">'
    + '<input type="radio" id="ucg-tab-1" name="ucg-tabs" checked>'
    + '<label class="ucg-tab-label" for="ucg-tab-1">Contact</label>'
    + '<div class="ucg-tabpanel">'
    + '<p>To contact our Customer Service team, use the &#39;Ask seller a question&#39; link '
    + 'on this listing and we will be happy to assist.</p>'
    + '<p>&copy; usedcameragear.com</p>'
    + '</div></div>'
    + '<div class="ucg-tab">'
    + '<input type="radio" id="ucg-tab-2" name="ucg-tabs">'
    + '<label class="ucg-tab-label" for="ucg-tab-2">Shipping &amp; Payments</label>'
    + '<div class="ucg-tabpanel">'
    + '<p>Shipping is FREE for this item within the United States.</p>'
    + '<p>Orders are packed carefully and shipped promptly after payment clears. See the '
    + 'Shipping section of this listing for carrier options and delivery estimates.</p>'
    + '</div></div>'
    + '<div class="ucg-tab">'
    + '<input type="radio" id="ucg-tab-3" name="ucg-tabs">'
    + '<label class="ucg-tab-label" for="ucg-tab-3">Payment</label>'
    + `<div class="ucg-tabpanel">${PAYMENT_TEXT}</div></div>`
    + '<div class="ucg-tab">'
    + '<input type="radio" id="ucg-tab-4" name="ucg-tabs">'
    + '<label class="ucg-tab-label" for="ucg-tab-4">Returns</label>'
    + '<div class="ucg-tabpanel">'
    + '<p>Returns are accepted.</p>'
    + '<p>Items must be returned within 30 days of delivery, and the seller pays for return '
    + 'shipping. See the Returns section of this listing for the full policy.</p>'
    + '</div></div>'
    + '</div>';
function conditionNoteHtml(note) {
    return escapeHtml(note).replace(/\r\n|\r|\n/g, '<br>');
}
/**
 * The Codisto-style CSS-only gallery: a hero image opening a full-screen
 * `:target` lightbox, one hidden lightbox per photo, and a thumbnail strip
 * whose anchors open the matching lightbox. The lightbox close control is an
 * anchor back to the page top (clearing `:target`).
 */
function galleryHtml(imageUrls, title) {
    const hero = imageUrls[0];
    const parts = [];
    parts.push('<div class="ucg-hero"><a href="#ucg-img-1">'
        + `<img src="${escapeHtml(sizedImageUrl(hero, 'width=640'))}" alt="${title}" loading="lazy">`
        + '</a></div>');
    imageUrls.forEach((url, index) => {
        parts.push(`<a href="#ucg-top" class="ucg-lightbox" id="ucg-img-${index + 1}">`
            + '<span class="ucg-close">&times;</span>'
            + `<img src="${escapeHtml(sizedImageUrl(url, 'width=1200'))}" `
            + `alt="${title} - photo ${index + 1}" loading="lazy"></a>`);
    });
    const thumbs = imageUrls.map((url, index) => `<a href="#ucg-img-${index + 1}">`
        + `<img src="${escapeHtml(sizedImageUrl(url, 'width=240&height=240'))}" `
        + `alt="${title} - thumbnail ${index + 1}" loading="lazy"></a>`).join('');
    parts.push(`<div class="ucg-thumbs">${thumbs}</div>`);
    return parts.join('\n');
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
    parts.push('<div class="ucg-page" id="ucg-top">');
    parts.push(STYLE_BLOCK);
    parts.push('<div class="ucg-shell">');
    parts.push('<div class="ucg-card ucg-brandbar">'
        + `<img class="ucg-logo" src="${escapeHtml(STORE_LOGO_URL)}" alt="usedcameragear.com">`
        + '<span class="ucg-tagline">Quality used camera gear</span></div>');
    parts.push('<div class="ucg-card">');
    parts.push(`<h1 class="ucg-title">${title}</h1>`);
    const meta = [];
    if (conditionLabel !== null) {
        meta.push(`<span class="ucg-condition">${escapeHtml(conditionLabel)}</span>`);
    }
    meta.push(`<span class="ucg-sku">SKU: ${escapeHtml(checked.sku)}</span>`);
    parts.push(`<div class="ucg-meta">${meta.join('')}</div>`);
    if (checked.bodyHtml.length > 0) {
        parts.push(`<div class="ucg-body">${checked.bodyHtml}</div>`);
    }
    if (checked.conditionNote !== null) {
        parts.push('<p class="ucg-note"><strong>Condition notes</strong><br>'
            + `${conditionNoteHtml(checked.conditionNote)}</p>`);
    }
    if (checked.imageUrls.length > 0) {
        parts.push(galleryHtml(checked.imageUrls, title));
    }
    parts.push('</div>');
    parts.push(INFO_SECTION);
    parts.push(TABS_SECTION);
    parts.push('<div class="ucg-footer">'
        + `<span class="ucg-footer-mark">${WORDMARK}</span>`
        + '<span>&copy; usedcameragear.com</span></div>');
    parts.push('</div>');
    parts.push('</div>');
    const html = parts.join('\n');
    if (Buffer.byteLength(html, 'utf8') > MAX_OUTPUT_BYTES) {
        throw new ListingDescriptionTemplateError('OUTPUT_TOO_LARGE');
    }
    return html;
}
