/**
 * DOM-free check that a listing description contains only allowlisted,
 * attribute-free markup (plain text always passes). Shared by the server
 * draft-save validator and the web draft validators so both sides enforce
 * exactly the same rule: p, div, br, b, strong, i, em, u, ul, ol, li,
 * h2, h3, span with no attributes, and a with only a credential-free
 * absolute http/https href.
 */
const HTML_TAG_PATTERN = /<\/?[a-z][^>]*>/giu;
const ALLOWED_TAG_PATTERN = new RegExp(
  '^(?:'
  + '<\\/?(?:p|div|b|strong|i|em|u|ul|ol|li|h2|h3|span)>'
  + '|<br ?\\/?>'
  + '|<a href="https?:\\/\\/[^\\s"<>]+">'
  + '|<\\/a>'
  + ')$',
  'u',
);

export const isAllowlistedListingHtml = (value: string): boolean => {
  const tags = value.match(HTML_TAG_PATTERN) ?? [];
  return tags.every((tag) => ALLOWED_TAG_PATTERN.test(tag));
};

/**
 * Deterministic, DOM-free conversion of arbitrary storefront HTML (for
 * example Shopify `descriptionHtml`) into the allowlist above. Strategy:
 * active/none-rendering elements are removed WITH their content
 * (script/style/iframe/object/embed/svg/form/noscript/head/title/template);
 * allowlisted tags are kept with every attribute stripped; heading levels
 * outside h2/h3 are folded to the nearest allowed level; `<a>` survives only
 * with a credential-free absolute http(s) href; every other tag is unwrapped
 * (dropped, content kept). The result always passes
 * `isAllowlistedListingHtml` — the one transformation that could reintroduce
 * a tag is impossible because angle brackets inside text are left encoded.
 */
const DROP_WITH_CONTENT = /<(script|style|iframe|object|embed|svg|form|noscript|head|title|template)\b[^>]*>[\s\S]*?<\/\1\s*>/giu;
const KEEP_BARE = new Set([
  'p', 'div', 'br', 'b', 'strong', 'i', 'em', 'u', 'ul', 'ol', 'li', 'h2', 'h3', 'span',
]);
const HEADING_FOLD: Readonly<Record<string, string>> = Object.freeze({
  h1: 'h2', h4: 'h3', h5: 'h3', h6: 'h3',
});
const SAFE_HREF = /^https?:\/\/[^\s"<>]+$/u;

export const sanitizeListingHtml = (value: string): string => {
  const sanitized = value
    .replace(/<!--[\s\S]*?-->/gu, ' ')
    .replace(DROP_WITH_CONTENT, ' ')
    .replace(/<\/?([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/gu, (tag, rawName: string, rawAttributes: string) => {
      const name = rawName.toLowerCase();
      const closing = tag.startsWith('</');
      if (KEEP_BARE.has(name)) {
        if (name === 'br') return '<br>';
        return closing ? `</${name}>` : `<${name}>`;
      }
      const folded = HEADING_FOLD[name];
      if (folded !== undefined) return closing ? `</${folded}>` : `<${folded}>`;
      if (name === 'a') {
        if (closing) return '</a>';
        const href = /\bhref\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/iu.exec(rawAttributes);
        const target = href?.[2] ?? href?.[3] ?? href?.[4] ?? '';
        if (SAFE_HREF.test(target)) {
          try {
            const url = new URL(target);
            if (url.username === '' && url.password === '') return `<a href="${target}">`;
          } catch { /* unwrap below */ }
        }
        // Unmatched `</a>` from an unwrapped opener is tolerated by parsers
        // and by the allowlist, which checks tags independently.
        return '';
      }
      return ' ';
    })
    .replace(/[ \t]{2,}/gu, ' ');
  return isAllowlistedListingHtml(sanitized) ? sanitized : '';
};
