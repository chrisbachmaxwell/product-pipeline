import { describe, it, expect } from 'vitest';
import { isFolderStable } from '../cloud-watcher.js';

describe('isFolderStable', () => {
  it('is not stable on first sighting', () => {
    expect(isFolderStable(undefined, 5)).toBe(false);
  });

  it('is not stable while images are still arriving', () => {
    expect(isFolderStable(3, 5)).toBe(false);
  });

  it('is stable once the image count is unchanged between polls', () => {
    expect(isFolderStable(5, 5)).toBe(true);
  });

  it('is never stable for an empty folder', () => {
    expect(isFolderStable(0, 0)).toBe(false);
  });
});
