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
