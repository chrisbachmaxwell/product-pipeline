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

const MOUNTS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bRF-S\b/i, 'Canon RF-S'],
  [/\bEF-S\b/i, 'Canon EF-S'],
  [/\bEF-M\b/i, 'Canon EF-M'],
  [/\bRF\b/, 'Canon RF'],
  [/\bEF\b/, 'Canon EF'],
  [/\bFD\b/, 'Canon FD'],
  [/\bZ[- ]?mount\b|\bNikkor Z\b|\bNikon Z\b|(^|\s)Z\s\d/i, 'Nikon Z'],
  [/\bAF-S\b|\bAF-D\b|\bF[- ]?mount\b/i, 'Nikon F'],
  [/\bSony FE\b|\bFE\s\d/i, 'Sony E'],
  [/\bSony E\b|\bE[- ]?mount\b/i, 'Sony E'],
  [/\bFujifilm GF\b|\bFuji GF\b|\bGF\s?\d/i, 'Fujifilm G'],
  [/\bFujifilm XF?\b|\bFuji XF?\b|\bXF\s?\d/i, 'Fujifilm X'],
  [/\bmicro four thirds\b|\bMFT\b|\bM4\/3\b/i, 'Micro Four Thirds'],
  [/\bLeica M\b/i, 'Leica M'],
  [/\bPentax K\b/i, 'Pentax K'],
];

export function deriveLensAspects(rawTitle: string | null | undefined): Record<string, string[]> {
  if (typeof rawTitle !== 'string') return {};
  const title = rawTitle.slice(0, 200);
  if (!/\blens\b/i.test(title)) return {};
  // A camera KIT title also says "Lens" ("EOS Rebel SL3 DSLR w/ 18-55mm
  // Lens") but the listing is a CAMERA: lens aspects (Mount, Maximum
  // Aperture, Type=Zoom) are wrong for it and camera categories want Model/
  // Type instead (learned live 2026-09-16). When the title names a camera,
  // derive nothing rather than derive wrongly.
  if (/\b(camera|dslr|slr|mirrorless|camcorder|body)\b/i.test(title)) return {};

  const aspects: Record<string, string[]> = {};

  const focal = /(\d{1,4}(?:\.\d)?)\s*(?:-\s*(\d{1,4}(?:\.\d)?)\s*)?mm\b/i.exec(title);
  if (focal) {
    aspects['Focal Length'] = [focal[2] ? `${focal[1]}-${focal[2]}mm` : `${focal[1]}mm`];
  }

  // No whitespace between f and the number: "EF 300mm" must never read as
  // f/30. Accepts f/2.8, f2.8, F4; rejects implausible apertures.
  const aperture = /\bf\/?(\d{1,2}(?:\.\d{1,2})?)/i.exec(title);
  if (aperture) {
    const stop = Number(aperture[1]);
    if (Number.isFinite(stop) && stop >= 0.7 && stop <= 45) {
      aspects['Maximum Aperture'] = [`f/${aperture[1]}`];
    }
  }

  for (const [pattern, mount] of MOUNTS) {
    if (pattern.test(title)) {
      aspects.Mount = [mount];
      break;
    }
  }

  // Type: a stated range is a Zoom; a single stated focal length maps by
  // convention. Macro/fisheye words win over the numeric rule.
  if (/\bfisheye\b/i.test(title)) {
    aspects.Type = ['Fisheye'];
  } else if (/\bmacro\b/i.test(title)) {
    aspects.Type = ['Macro'];
  } else if (focal && focal[2]) {
    aspects.Type = ['Zoom'];
  } else if (focal) {
    const length = Number(focal[1]);
    if (Number.isFinite(length)) {
      aspects.Type = [length < 35 ? 'Wide Angle' : length < 85 ? 'Standard' : 'Telephoto'];
    }
  }

  // Focus Type: an explicit marker decides; otherwise default to
  // Auto & Manual UNLESS the maker's glass is manual-focus by design.
  // Three publish-time halts (L69: EF 75-300 III, EF-S 18-135 IS;
  // 2026-09-18: 6846A004) were all autofocus lenses whose titles simply
  // lack a motor acronym — eBay requires the aspect for every lens, so
  // "derive nothing" just moved the failure to publish time. The
  // manual-by-design brands stay Manual, and the editor can override.
  const MANUAL_FOCUS_BRANDS =
    /\bLeica M\b|\bZeiss\b|\bVoigtl(?:a|ä)nder\b|\bSamyang\b|\bRokinon\b|\bLaowa\b|\bMitakon\b/i;
  if (/\bmanual focus\b|\bMF\b/i.test(title) || MANUAL_FOCUS_BRANDS.test(title)) {
    aspects['Focus Type'] = ['Manual'];
  } else {
    aspects['Focus Type'] = ['Auto & Manual'];
  }

  return aspects;
}

/**
 * Camera-body and camera-kit titles: derive the Model and Type eBay's
 * camera categories ENFORCE at publish time without ever marking required
 * in the taxonomy (L67), plus Brand when the title states it. Purely
 * mechanical title parsing — the model IS the title minus the brand and
 * the store's decorations; nothing is guessed. Five days of scheduled-run
 * failures (2026-09-23) were hand-fillable Models the title stated plainly.
 */
const CAMERA_BRANDS = [
  'Canon', 'Nikon', 'Sony', 'Fujifilm', 'Panasonic', 'Olympus', 'Leica',
  'Hasselblad', 'Pentax', 'Sigma', 'Mamiya', 'Ricoh', 'GoPro', 'DJI',
  'Kodak', 'Minolta', 'Blackmagic',
];

export function deriveCameraAspects(rawTitle: string | null | undefined): Record<string, string[]> {
  if (typeof rawTitle !== 'string') return {};
  const title = rawTitle.slice(0, 200);
  if (!/\b(camera|dslr|slr|mirrorless|camcorder|body)\b/i.test(title)) return {};

  const aspects: Record<string, string[]> = {};
  const brand = CAMERA_BRANDS.find((name) =>
    new RegExp('^' + name + '\\b', 'i').test(title.trim()));
  if (brand) aspects.Brand = [brand];

  if (/\bDSLR\b|\bSLR\b/i.test(title)) {
    aspects.Type = [/\bdigital\b|\bDSLR\b/i.test(title) ? 'Digital SLR' : 'SLR'];
  } else if (/\bmirrorless\b/i.test(title)) {
    aspects.Type = ['Mirrorless Interchangeable Lens'];
  }

  // Model: the title minus brand, parentheticals, star markers, and the
  // generic camera words / kit tails. "Canon EOS 5D Mark III Digital
  // Camera Body (#022) *USED*" -> "EOS 5D Mark III".
  let model = title
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\*[^*]*\*/g, ' ')
    .replace(/\b(?:w\/|with)\b[\s\S]*$/i, ' ');
  if (brand) model = model.replace(new RegExp('^\\s*' + brand + '\\b', 'i'), ' ');
  model = model
    .replace(/\b(digital|mirrorless|cinema|dslr|slr|camera|camcorder|body|kit)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (model.length >= 2 && model.length <= 65) aspects.Model = [model];

  return aspects;
}
