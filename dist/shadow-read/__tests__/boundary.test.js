import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
const IMPLEMENTATION_FILES = [
    '../errors.ts',
    '../fixture-data.ts',
    '../limits.ts',
    '../order-window.ts',
    '../pagination.ts',
    '../token.ts',
    '../transport.ts',
];
describe('shadow-read static isolation boundary', () => {
    it('contains no global network, environment, credential-file, database, server, or app imports', () => {
        for (const relativePath of IMPLEMENTATION_FILES) {
            const source = readFileSync(new URL(relativePath, import.meta.url), 'utf8');
            expect(source, relativePath).not.toMatch(/\bfetch\s*\(/);
            expect(source, relativePath).not.toMatch(/globalThis\.fetch/);
            expect(source, relativePath).not.toMatch(/process\.env/);
            expect(source, relativePath).not.toMatch(/from\s+['"](?:node:fs|fs|node:http|node:https|http|https)['"]/);
            expect(source, relativePath).not.toMatch(/better-sqlite3|drizzle-orm|\.\.\/db\/|\.\.\/server\/|\.\.\/shopify\/|\.\.\/ebay\//);
        }
    });
    it('imports only local shadow-read modules plus deterministic node crypto', () => {
        for (const relativePath of IMPLEMENTATION_FILES) {
            const source = readFileSync(new URL(relativePath, import.meta.url), 'utf8');
            const imports = [...source.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((match) => match[1]);
            expect(imports.every((specifier) => specifier.startsWith('./') || specifier === 'node:crypto'), relativePath).toBe(true);
        }
    });
});
