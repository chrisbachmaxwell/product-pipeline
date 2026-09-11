/**
 * Deterministic camera-gear aspect derivation from the product title —
 * fills the item specifics eBay REQUIRES for lens listings (learned the
 * hard way, 2026-09-11: Brand, Focal Length, Type, Focus Type, Maximum
 * Aperture, Mount — refused one at a time behind generic error 25002).
 *
 * SOURCE-layer only: everything here is a default the operator can
 * override in the editor. Values are derived only when the title states
 * them plainly; nothing is guessed. Lens aspects are gated on the title
 * actually describing a lens so a camera-body listing never grows a
 * "Focal Length".
 */
export declare function deriveLensAspects(rawTitle: string | null | undefined): Record<string, string[]>;
