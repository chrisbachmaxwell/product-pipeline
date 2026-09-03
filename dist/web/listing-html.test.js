import { describe, expect, it } from 'vitest';
import { isAllowlistedListingHtml, safeListingLinkHref, sanitizeListingHtml, } from './listing-html';
describe('listing draft HTML allowlist', () => {
    it('accepts plain text, including angle-bracket-free entities and math', () => {
        expect(isAllowlistedListingHtml('Plain text description')).toBe(true);
        expect(isAllowlistedListingHtml('Aperture f/2.8 & weight < 500g')).toBe(true);
        expect(isAllowlistedListingHtml('Ships in 1&ndash;2 days')).toBe(true);
    });
    it('accepts only allowlisted attribute-free tags', () => {
        expect(isAllowlistedListingHtml('<h2>Condition</h2><p>Light <b>wear</b>, <em>fully</em> tested.</p>'
            + '<ul><li>Hood</li><li>Caps</li></ul><br>'
            + '<a href="https://example.com/manual">Manual</a><span>ok</span>')).toBe(true);
        expect(isAllowlistedListingHtml('<h3>Heading</h3><div>Body</div><ol><li>1</li></ol>')).toBe(true);
    });
    it('rejects scripts, event handlers, styles, images, and unsafe links', () => {
        expect(isAllowlistedListingHtml('<script>alert(1)</script>')).toBe(false);
        expect(isAllowlistedListingHtml('<p onclick="alert(1)">x</p>')).toBe(false);
        expect(isAllowlistedListingHtml('<p style="color:red">x</p>')).toBe(false);
        expect(isAllowlistedListingHtml('<span class="x">x</span>')).toBe(false);
        expect(isAllowlistedListingHtml('<img src="x">')).toBe(false);
        expect(isAllowlistedListingHtml('<iframe src="https://example.com"></iframe>')).toBe(false);
        expect(isAllowlistedListingHtml('<a href="javascript:alert(1)">x</a>')).toBe(false);
        expect(isAllowlistedListingHtml('<a href="https://a.com" target="_blank">x</a>')).toBe(false);
        expect(isAllowlistedListingHtml('<h1>Too big</h1>')).toBe(false);
        expect(isAllowlistedListingHtml('<P>uppercase is never emitted</P>')).toBe(false);
    });
    it('only links to credential-free http(s) URLs', () => {
        expect(safeListingLinkHref('https://example.com/a?b=c')).toBe('https://example.com/a?b=c');
        expect(safeListingLinkHref('http://example.com')).toBe('http://example.com/');
        expect(safeListingLinkHref('javascript:alert(1)')).toBeNull();
        expect(safeListingLinkHref('data:text/html,x')).toBeNull();
        expect(safeListingLinkHref('https://user:pass@example.com')).toBeNull();
        expect(safeListingLinkHref('/relative/path')).toBeNull();
        expect(safeListingLinkHref('not a url')).toBeNull();
    });
    it('strips all markup in the non-browser fallback rather than trusting it', () => {
        // vitest runs without a DOM: sanitizeListingHtml must degrade to plain text.
        const sanitized = sanitizeListingHtml('<p onclick="x">Hello <script>alert(1)</script>world</p>');
        expect(sanitized).not.toContain('<');
        expect(sanitized).toContain('Hello');
        expect(isAllowlistedListingHtml(sanitized)).toBe(true);
        expect(sanitizeListingHtml('')).toBe('');
    });
});
