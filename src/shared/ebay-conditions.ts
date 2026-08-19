/**
 * Fixed eBay listing-condition table. These are marketplace-wide constants,
 * not seller data: they are never fetched from eBay and never change at
 * runtime, so the listing editor can render them without any remote read.
 */
export type EbayConditionOption = Readonly<{
  id: string;
  label: string;
}>;

export const EBAY_CONDITIONS: readonly EbayConditionOption[] = Object.freeze([
  Object.freeze({ id: '1000', label: 'New' }),
  Object.freeze({ id: '1500', label: 'New other (see details)' }),
  Object.freeze({ id: '1750', label: 'New with defects' }),
  Object.freeze({ id: '2000', label: 'Certified - Refurbished' }),
  Object.freeze({ id: '2500', label: 'Seller refurbished' }),
  Object.freeze({ id: '2750', label: 'Like New' }),
  Object.freeze({ id: '3000', label: 'Used' }),
  Object.freeze({ id: '4000', label: 'Very Good' }),
  Object.freeze({ id: '5000', label: 'Good' }),
  Object.freeze({ id: '6000', label: 'Acceptable' }),
  Object.freeze({ id: '7000', label: 'For parts or not working' }),
]);
