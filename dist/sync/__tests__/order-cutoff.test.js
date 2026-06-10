import { describe, it, expect } from 'vitest';
import { applyCutoff } from '../order-sync.js';
describe('applyCutoff', () => {
    it('returns createdAfter unchanged when no cutoff is set', () => {
        expect(applyCutoff('2026-06-01T00:00:00.000Z', null)).toBe('2026-06-01T00:00:00.000Z');
    });
    it('clamps createdAfter forward to the cutoff', () => {
        expect(applyCutoff('2026-06-01T00:00:00.000Z', '2026-06-09T12:00:00.000Z')).toBe('2026-06-09T12:00:00.000Z');
    });
    it('keeps createdAfter when it is already after the cutoff', () => {
        expect(applyCutoff('2026-06-10T00:00:00.000Z', '2026-06-09T12:00:00.000Z')).toBe('2026-06-10T00:00:00.000Z');
    });
});
