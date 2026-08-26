import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { describe, expect, it } from 'vitest';
import { createHealthRouter } from './health.js';
async function requestHealth(port) {
    return new Promise((resolve, reject) => {
        http.get({ hostname: '127.0.0.1', port, path: '/health' }, (response) => {
            let raw = '';
            response.setEncoding('utf8');
            response.on('data', (chunk) => { raw += chunk; });
            response.on('end', () => resolve(JSON.parse(raw)));
        }).on('error', reject);
    });
}
describe('health operational counters', () => {
    it('reuses a cheap redacted cache projection without an inspection dependency', async () => {
        let cacheReads = 0;
        const app = express();
        app.use(createHealthRouter(() => {
            cacheReads += 1;
            return {
                snapshotStatus: 'current',
                ageSeconds: 12,
                status: 'critical',
                health: { migrationStore: 'verified', auditChain: 'verified',
                    catalogRead: 'failed', shadowParity: 'attention' },
                counters: { unresolvedJobs: 1, failedJobs: 0, reconciliationExceptions: 1,
                    shadowUnmatchedOrders: 1, shadowBlockedOrders: 0, catalogReadFailures: 1 },
                dailyDigest: { dateUtc: '2026-08-25', digest: `sha256:${'b'.repeat(64)}` },
                readOnly: true,
                externalWritesPerformed: 0,
                providerReadsPerformed: 0,
                notificationsSent: 0,
            };
        }));
        const server = http.createServer(app);
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
        try {
            const address = server.address();
            if (!address || typeof address === 'string')
                throw new Error('missing address');
            const bodies = await Promise.all([
                requestHealth(address.port), requestHealth(address.port), requestHealth(address.port),
            ]);
            expect(cacheReads).toBe(3);
            expect(bodies[0].monitoring).toMatchObject({
                snapshotStatus: 'current', ageSeconds: 12,
                status: 'critical', counters: { unresolvedJobs: 1, catalogReadFailures: 1 },
                dailyDigest: { dateUtc: '2026-08-25', digest: `sha256:${'b'.repeat(64)}` },
                readOnly: true, externalWritesPerformed: 0, providerReadsPerformed: 0,
                notificationsSent: 0,
            });
            expect(JSON.stringify(bodies)).not.toMatch(/buyer|email|address|token|orderId|sku/i);
        }
        finally {
            await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        }
    });
    it('has no request-time store or full monitoring reader in the public health route', () => {
        const source = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'health.ts'), 'utf8');
        expect(source).not.toMatch(/readOperationalMonitoring|readConfiguredMigrationState|inspectMigrationStoreReadOnly|better-sqlite3/);
        expect(source).toContain('getCachedOperationalHealth');
    });
    it('represents an unwarmed cache explicitly without inventing counters', async () => {
        const app = express();
        app.use(createHealthRouter(() => ({
            snapshotStatus: 'unavailable', ageSeconds: null, status: 'unavailable',
            health: null, counters: null, dailyDigest: null, readOnly: true,
            externalWritesPerformed: 0, providerReadsPerformed: 0, notificationsSent: 0,
        })));
        const server = http.createServer(app);
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
        try {
            const address = server.address();
            if (!address || typeof address === 'string')
                throw new Error('missing address');
            expect((await requestHealth(address.port)).monitoring).toEqual({
                snapshotStatus: 'unavailable', ageSeconds: null, status: 'unavailable',
                health: null, counters: null, dailyDigest: null, readOnly: true,
                externalWritesPerformed: 0, providerReadsPerformed: 0, notificationsSent: 0,
            });
        }
        finally {
            await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        }
    });
});
