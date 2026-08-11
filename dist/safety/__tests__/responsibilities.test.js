import { describe, expect, it } from 'vitest';
import { CANARY_RESPONSIBILITIES } from '../canary-readiness.js';
import { MIGRATION_RESPONSIBILITIES, WRITER_RESPONSIBILITIES, isMigrationResponsibility, isWriterResponsibility, } from '../responsibilities.js';
describe('canonical migration responsibility vocabulary', () => {
    it('uses one exact writer vocabulary for canary scope', () => {
        expect(CANARY_RESPONSIBILITIES).toBe(WRITER_RESPONSIBILITIES);
        expect([...WRITER_RESPONSIBILITIES]).toEqual([
            'orderImport',
            'price',
            'inventory',
            'listingCreate',
            'listingRevise',
            'listingEndRelist',
            'mapping',
            'fulfillment',
            'feedback',
        ]);
    });
    it('keeps reconciliation in ownership/evidence but out of writer actions', () => {
        expect(MIGRATION_RESPONSIBILITIES).toEqual([
            ...WRITER_RESPONSIBILITIES,
            'reconciliation',
        ]);
        expect(isMigrationResponsibility('reconciliation')).toBe(true);
        expect(isWriterResponsibility('reconciliation')).toBe(false);
    });
    it.each([
        'orders',
        'order_sync',
        'listing_update',
        'listingLifecycle',
        'unknown',
        '',
        null,
        undefined,
    ])('does not translate or accept legacy/unknown responsibility %s', (value) => {
        expect(isMigrationResponsibility(value)).toBe(false);
        expect(isWriterResponsibility(value)).toBe(false);
    });
});
