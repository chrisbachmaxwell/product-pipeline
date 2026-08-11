import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const repositoryRoot = path.resolve(sourceRoot, '..');
describe('repository credential and scope boundary', () => {
    it('keeps the committed Shopify app request scopes read-only', async () => {
        const [config, testMode] = await Promise.all([
            fs.readFile(path.join(repositoryRoot, 'shopify.app.toml'), 'utf8'),
            fs.readFile(path.join(sourceRoot, 'server/middleware/test-mode.ts'), 'utf8'),
        ]);
        const scopeLine = config.match(/^scopes\s*=\s*"([^"]*)"$/m)?.[1] ?? '';
        expect(scopeLine.split(',').filter(Boolean)).toEqual([
            'read_products',
            'read_orders',
            'read_inventory',
            'read_fulfillments',
        ]);
        expect(scopeLine).not.toMatch(/(?:^|,)write_/);
        expect(testMode).not.toMatch(/scope:\s*['"][^'"]*write_/);
    });
    it('keeps the retired live mapping script network-inert and secret-free', async () => {
        const script = await fs.readFile(path.join(repositoryRoot, 'test-mappings.js'), 'utf8');
        expect(script).not.toMatch(/\bfetch\s*\(/);
        expect(script).not.toMatch(/https?:\/\//);
        expect(script).not.toMatch(/ebay-sync-[a-f0-9]{20,}/i);
        expect(script).toContain('legacy live mapping test is quarantined');
    });
    it('does not retain the legacy hard-coded API-key shape in mapping documents', async () => {
        const documents = await Promise.all(['MAPPING_TEST_PLAN.md', 'MAPPING_SYSTEM_COMPLETE.md'].map((name) => fs.readFile(path.join(repositoryRoot, name), 'utf8')));
        for (const document of documents) {
            expect(document).not.toMatch(/ebay-sync-[a-f0-9]{20,}/i);
        }
    });
    it('keeps legacy integration identities out of tracked service source', async () => {
        const timService = await fs.readFile(path.join(sourceRoot, 'services/tim-service.ts'), 'utf8');
        expect(timService).not.toMatch(/[A-Za-z0-9._%+-]+@gmail\.com/i);
        expect(timService).toContain('TIM_EMAIL is required');
    });
});
