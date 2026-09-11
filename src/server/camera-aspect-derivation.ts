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

  // Focus Type only when the title carries an autofocus or manual marker.
  if (/\bmanual focus\b|\bMF\b/i.test(title)) {
    aspects['Focus Type'] = ['Manual'];
  } else if (/\bUSM\b|\bSTM\b|\bHSM\b|\bAF(?:-[SDP])?\b|\bXD\b|\bDDSSM\b|\bVR\b|\bOIS\b/i.test(title)) {
    aspects['Focus Type'] = ['Auto & Manual'];
  }

  return aspects;
}
