import { describe, expect, it } from 'vitest';
import { deriveLensAspects } from './camera-aspect-derivation.js';

describe('deriveLensAspects', () => {
  it('derives the full required set for the lens that fought back (L62)', () => {
    expect(deriveLensAspects('Canon EF 300mm f/2.8L IS USM II Lens (#596) *USED*')).toEqual({
      'Focal Length': ['300mm'],
      'Maximum Aperture': ['f/2.8'],
      Mount: ['Canon EF'],
      Type: ['Telephoto'],
      'Focus Type': ['Auto & Manual'],
    });
  });

  it('handles zooms, wide angles, and other mounts', () => {
    expect(deriveLensAspects('Canon RF 70-200mm f/2.8L IS USM Lens *USED*')).toMatchObject({
      'Focal Length': ['70-200mm'],
      Type: ['Zoom'],
      Mount: ['Canon RF'],
    });
    expect(deriveLensAspects('Fujifilm XF 23mm f4 R LM WR Lens (#330)')).toMatchObject({
      'Focal Length': ['23mm'],
      Type: ['Wide Angle'],
      Mount: ['Fujifilm X'],
    });
    expect(deriveLensAspects('Voigtlander 15mm f/4.5 ASPH III Manual Focus Lens for Sony FE'))
      .toMatchObject({ 'Focus Type': ['Manual'], Mount: ['Sony E'] });
  });

  it('derives nothing for non-lens titles and stays silent when unstated', () => {
    expect(deriveLensAspects('Canon EOS R5 Mirrorless Camera Body (#303) *USED*')).toEqual({});
    expect(deriveLensAspects('Canon BG-E21 Battery Grip (6D Mark II) (#072) *USED*')).toEqual({});
    expect(deriveLensAspects(null)).toEqual({});
    expect(deriveLensAspects('Mystery Lens')).toEqual({});
  });
});
