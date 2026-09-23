import { describe, expect, it } from 'vitest';
import { deriveCameraAspects, deriveLensAspects } from './camera-aspect-derivation.js';

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
    // A bare lens title still gets the Focus Type default (2026-09-18) —
    // eBay requires the aspect for every lens — but nothing else is guessed.
    expect(deriveLensAspects('Mystery Lens')).toEqual({ 'Focus Type': ['Auto & Manual'] });
  });
});

describe('camera-kit titles never grow lens aspects (2026-09-16)', () => {
  it('derives nothing for a camera kit whose title mentions a lens', () => {
    expect(deriveLensAspects(
      'Canon EOS Rebel SL3 DSLR w/ EF-S 18-55mm f/4-5.6 IS STM Lens (#978) *USED*',
    )).toEqual({});
    expect(deriveLensAspects(
      'Sony NEX 6 Mirrorless Camera w/16-50mm & 55-210mm OSS Lenses *USED*',
    )).toEqual({});
    expect(deriveLensAspects('Nikon D50 DSLR Camera Body (#392) *USED*')).toEqual({});
  });
  it('still derives for a plain lens title', () => {
    expect(deriveLensAspects('Sony 70-200mm f/2.8 GM Lens (#608) *USED*'))
      .toMatchObject({ 'Focal Length': ['70-200mm'] });
  });
});

describe('Focus Type defaults for marker-less lens titles (2026-09-18)', () => {
  it('defaults an unmarked lens title to Auto & Manual', () => {
    expect(deriveLensAspects('Canon EF 28-105mm f/3.5-4.5 II Lens (#123) *USED*'))
      .toMatchObject({ 'Focus Type': ['Auto & Manual'] });
  });
  it('keeps manual-by-design brands Manual without an MF marker', () => {
    expect(deriveLensAspects('Zeiss Planar T* 50mm f/1.4 Lens (#9) *USED*'))
      .toMatchObject({ 'Focus Type': ['Manual'] });
    expect(deriveLensAspects('Voigtlander Nokton 40mm f/1.2 Lens *USED*'))
      .toMatchObject({ 'Focus Type': ['Manual'] });
  });
  it('an explicit MF marker still outranks everything', () => {
    expect(deriveLensAspects('Canon 50mm f/1.8 MF Lens *USED*'))
      .toMatchObject({ 'Focus Type': ['Manual'] });
  });
});

describe('camera Model/Type derivation (2026-09-23)', () => {
  it('derives Brand, Model, and Type from body titles', () => {
    // 'Digital Camera Body' carries no DSLR/mirrorless marker — Type is
    // not guessed; the publish-all aspect gate names it for the employee.
    expect(deriveCameraAspects('Canon EOS 5D Mark III Digital Camera Body (#022) *USED*'))
      .toEqual({ Brand: ['Canon'], Model: ['EOS 5D Mark III'] });
    expect(deriveCameraAspects('Canon EOS 7D Mark II Digital SLR Camera Body (#741) *USED*'))
      .toEqual({ Brand: ['Canon'], Type: ['Digital SLR'], Model: ['EOS 7D Mark II'] });
    expect(deriveCameraAspects('Nikon Z8 Mirrorless Camera Body (#861) *USED*'))
      .toEqual({ Brand: ['Nikon'], Type: ['Mirrorless Interchangeable Lens'], Model: ['Z8'] });
    expect(deriveCameraAspects('Panasonic Lumix DC-G9 Digital Camera Body (#050) *USED*'))
      .toMatchObject({ Brand: ['Panasonic'], Model: ['Lumix DC-G9'] });
  });
  it('drops kit tails and derives nothing for non-camera titles', () => {
    expect(deriveCameraAspects('Canon EOS 70D DSLR Camera with 18-55mm STM Lens (#207) *USED*'))
      .toMatchObject({ Model: ['EOS 70D'] });
    expect(deriveCameraAspects('Canon EF 300mm f/2.8L Lens (#1) *USED*')).toEqual({});
    expect(deriveCameraAspects(null)).toEqual({});
  });
});
