import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { appendAuditRecord, AuditIntegrityError, verifyAuditLog, verifyAuditText, } from '../audit.js';
const temporaryDirectories = [];
async function tempRoot() {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'product-pipeline-audit-'));
    temporaryDirectories.push(root);
    return root;
}
function event(command = 'preflight') {
    return {
        command,
        lane: 'production-shadow',
        mode: 'read-only',
        outcome: 'passed',
        configDigest: `sha256:${'1'.repeat(64)}`,
        target: {
            shopifyStoreDomain: 'usedcameragear.myshopify.com',
            ebayEnvironment: 'production',
            ebaySellerAccount: 'usedcam-0',
            marketplaceConnectAccount: 'usedcam-0',
        },
        ownershipDigest: `sha256:${'2'.repeat(64)}`,
        checks: [{ id: 'safety.read-only', result: 'pass' }],
    };
}
afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});
describe('operator audit chain', () => {
    it('appends deterministic linked records and verifies the chain', async () => {
        const root = await tempRoot();
        const logPath = '.local/operator-audit/operator-cli.jsonl';
        const first = await appendAuditRecord(root, logPath, event(), {
            now: () => new Date('2026-08-11T16:00:00.000Z'),
            createRunId: () => 'run-1',
        });
        const second = await appendAuditRecord(root, logPath, event('ownership'), {
            now: () => new Date('2026-08-11T16:01:00.000Z'),
            createRunId: () => 'run-2',
        });
        expect(first.sequence).toBe(1);
        expect(first.previousHash).toBe('GENESIS');
        expect(first.recordHash).toMatch(/^sha256:[a-f0-9]{64}$/);
        expect(second.sequence).toBe(2);
        expect(second.previousHash).toBe(first.recordHash);
        await expect(verifyAuditLog(root, logPath)).resolves.toEqual({
            valid: true,
            recordCount: 2,
            headHash: second.recordHash,
        });
    });
    it('detects payload tampering and refuses to append to a damaged chain', async () => {
        const root = await tempRoot();
        const logPath = '.local/operator-audit/operator-cli.jsonl';
        await appendAuditRecord(root, logPath, event());
        const absolutePath = path.join(root, logPath);
        const original = await fs.readFile(absolutePath, 'utf8');
        await fs.writeFile(absolutePath, original.replace('"outcome":"passed"', '"outcome":"blocked"'));
        const verification = await verifyAuditLog(root, logPath);
        expect(verification.valid).toBe(false);
        expect(verification.error).toContain('hash does not match');
        await expect(appendAuditRecord(root, logPath, event())).rejects.toThrow(AuditIntegrityError);
    });
    it('detects gaps, malformed JSON, and incomplete final lines', async () => {
        expect(verifyAuditText('{"sequence":1}\n').valid).toBe(false);
        expect(verifyAuditText('{not-json}\n').error).toContain('not valid JSON');
        expect(verifyAuditText('{}').error).toContain('incomplete final line');
    });
    it('fails closed when another or interrupted writer holds the lock', async () => {
        const root = await tempRoot();
        const logPath = '.local/operator-audit/operator-cli.jsonl';
        await fs.mkdir(path.join(root, '.local/operator-audit'), { recursive: true });
        await fs.writeFile(path.join(root, `${logPath}.lock`), 'held');
        await expect(appendAuditRecord(root, logPath, event())).rejects.toThrow(/locked/);
    });
    it('rejects credential-like material before writing', async () => {
        const root = await tempRoot();
        const unsafe = {
            ...event(),
            checks: [{ id: 'secret.value', result: 'pass' }],
        };
        await expect(appendAuditRecord(root, '.local/operator-audit/operator-cli.jsonl', unsafe)).rejects.toThrow(/credential-like/);
        await expect(fs.stat(path.join(root, '.local/operator-audit/operator-cli.jsonl'))).rejects.toThrow();
    });
    it('does not follow a symlinked local audit directory', async () => {
        const root = await tempRoot();
        const outside = await tempRoot();
        await fs.symlink(outside, path.join(root, '.local'));
        await expect(appendAuditRecord(root, '.local/operator-audit/operator-cli.jsonl', event())).rejects.toThrow(/real directory/);
        await expect(fs.stat(path.join(outside, 'operator-audit'))).rejects.toThrow();
    });
});
