import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PRODUCT_PIPELINE_SHOPIFY_IDENTITY } from '../shopify/production-identity.js';
import { PRODUCT_PIPELINE_PRODUCTION_RUNTIME } from './config.js';
import { repairFixedProductionShopifyDatabasePermissions, SHOPIFY_DATABASE_PERMISSION_REPAIR_STAGES, } from './database-permission-repair.js';
const roots = [];
const FIXED_PATH = PRODUCT_PIPELINE_PRODUCTION_RUNTIME.databasePath;
const ORIGINAL_MODE = 0o640;
const CONTENT = Buffer.from('SQLite format 3\u0000permission-repair-test-content');
const REPAIR_ENVIRONMENT = Object.freeze({
    NODE_ENV: 'production',
    RAILWAY_PROJECT_ID: PRODUCT_PIPELINE_PRODUCTION_RUNTIME.projectId,
    RAILWAY_ENVIRONMENT_ID: PRODUCT_PIPELINE_PRODUCTION_RUNTIME.environmentId,
    RAILWAY_SERVICE_ID: PRODUCT_PIPELINE_PRODUCTION_RUNTIME.serviceId,
    DATABASE_PATH: FIXED_PATH,
    SHOPIFY_CLIENT_ID: PRODUCT_PIPELINE_SHOPIFY_IDENTITY.clientId,
    SHOPIFY_DATABASE_PERMISSION_REPAIR_REPLICA_COUNT: '1',
    SHOPIFY_DATABASE_PERMISSION_REPAIR_VOLUME_MOUNT_COUNT: '1',
});
afterEach(() => {
    for (const root of roots.splice(0))
        fs.rmSync(root, { recursive: true, force: true });
});
function fixture(mode = ORIGINAL_MODE) {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'shopify-mode-repair-'));
    fs.chmodSync(root, 0o700);
    roots.push(root);
    const databasePath = path.join(root, 'ebaysync.db');
    fs.writeFileSync(databasePath, CONTENT, { mode });
    fs.chmodSync(databasePath, mode);
    return Object.freeze({ root, databasePath });
}
function mapPath(loaded, value) {
    const text = String(value);
    if (text === FIXED_PATH)
        return loaded.databasePath;
    if (text === path.dirname(FIXED_PATH))
        return loaded.root;
    if (text.startsWith(FIXED_PATH))
        return `${loaded.databasePath}${text.slice(FIXED_PATH.length)}`;
    throw Object.assign(new Error('unexpected fixed path'), { code: 'EPERM' });
}
function dependencies(loaded) {
    return {
        filesystem: {
            lstatSync: ((value) => fs.lstatSync(mapPath(loaded, value))),
            openSync: ((value, flags) => fs.openSync(mapPath(loaded, value), flags)),
            fstatSync: fs.fstatSync,
            readSync: fs.readSync,
            fchmodSync: fs.fchmodSync,
            fsyncSync: fs.fsyncSync,
            closeSync: fs.closeSync,
        },
        getEffectiveUid: () => PRODUCT_PIPELINE_PRODUCTION_RUNTIME
            .databasePermissionRepairEffectiveUid,
    };
}
function run(loaded, dependencyOverrides = {}, environment = REPAIR_ENVIRONMENT) {
    const base = dependencies(loaded);
    return repairFixedProductionShopifyDatabasePermissions(environment, {
        ...base,
        ...dependencyOverrides,
        filesystem: {
            ...base.filesystem,
            ...dependencyOverrides.filesystem,
        },
    });
}
describe('fixed Production Shopify database permission repair', () => {
    it('changes only the bound inode mode to 0600 and proves content, mtime, topology, and sidecars', () => {
        const loaded = fixture();
        const beforeBytes = fs.readFileSync(loaded.databasePath);
        const before = fs.statSync(loaded.databasePath);
        const beforeEntries = fs.readdirSync(loaded.root).sort();
        const result = run(loaded);
        expect(result).toMatchObject({
            status: 'permission_repair_verified',
            stage: 'verified',
            permissionMetadataWritesPerformed: 1,
            databaseContentWritesPerformed: 0,
            providerNetworkRequestsPerformed: 0,
            credentialWritesPerformed: 0,
            providerCredentialMutationsPerformed: 0,
            externalCommerceWritesPerformed: 0,
            checks: {
                runtimeBindingVerified: true,
                singleReplicaTopologyVerified: true,
                singleVolumeTopologyVerified: true,
                processEffectiveUidAvailable: true,
                runtimeEffectiveUidContractVerified: true,
                fileOwnerCompatibleWithProcess: true,
                descriptorPermissionChangeInvoked: true,
                mode0600VerifiedAfterRepair: true,
                databaseDescriptorSynced: true,
                parentDescriptorSynced: true,
                contentDigestUnchangedAfterRepair: true,
                mtimeUnchangedAfterRepair: true,
                pathIdentityStableAfterRepair: true,
                sqliteSidecarsAbsentAfterRepair: true,
                databaseDescriptorClosed: true,
                parentDescriptorClosed: true,
            },
        });
        expect(Object.isFrozen(result)).toBe(true);
        expect(Object.isFrozen(result.checks)).toBe(true);
        expect(result).not.toHaveProperty('rollbackStage');
        expect(result).not.toHaveProperty('rollbackApplied');
        expect(fs.statSync(loaded.databasePath).mode & 0o777).toBe(0o600);
        expect(fs.readFileSync(loaded.databasePath)).toEqual(beforeBytes);
        expect(fs.statSync(loaded.databasePath).mtimeMs).toBe(before.mtimeMs);
        expect(fs.readdirSync(loaded.root).sort()).toEqual(beforeEntries);
        const serialized = JSON.stringify(result);
        expect(serialized).not.toContain(loaded.databasePath);
        expect(serialized).not.toContain(FIXED_PATH);
        expect(serialized).not.toContain(CONTENT.toString('utf8'));
    });
    it.each([
        ['wrong project', { RAILWAY_PROJECT_ID: 'wrong' }],
        ['listing ACK present', { LISTING_CONTROL_SINGLE_WRITER_ACK: '' }],
        ['rotation ACK present', { SHOPIFY_CREDENTIAL_ROTATION_SINGLE_WRITER_ACK: '' }],
        ['rotation expiry present', { SHOPIFY_CREDENTIAL_ROTATION_SINGLE_WRITER_ACK_EXPIRES_AT_UTC: '' }],
        ['refresh token present', { SHOPIFY_ROTATION_REFRESH_TOKEN: '' }],
        ['replica proof absent', { SHOPIFY_DATABASE_PERMISSION_REPAIR_REPLICA_COUNT: undefined }],
        ['multiple replicas', { SHOPIFY_DATABASE_PERMISSION_REPAIR_REPLICA_COUNT: '2' }],
        ['volume proof absent', { SHOPIFY_DATABASE_PERMISSION_REPAIR_VOLUME_MOUNT_COUNT: undefined }],
        ['multiple mounts', { SHOPIFY_DATABASE_PERMISSION_REPAIR_VOLUME_MOUNT_COUNT: '2' }],
    ])('fails before filesystem access when %s', (_label, overrides) => {
        const loaded = fixture();
        const lstatSync = vi.fn();
        const result = run(loaded, {
            filesystem: { lstatSync },
        }, { ...REPAIR_ENVIRONMENT, ...overrides });
        expect(result).toMatchObject({
            status: 'permission_repair_failed_closed',
            stage: 'configuration-denied',
            permissionMetadataWritesPerformed: 0,
        });
        expect(lstatSync).not.toHaveBeenCalled();
    });
    it('fails closed before metadata change for canonical mode, unsafe parent, sidecar, or owner', () => {
        const canonical = fixture(0o600);
        expect(run(canonical)).toMatchObject({
            stage: 'file-mode-already-0600',
            permissionMetadataWritesPerformed: 0,
            checks: { descriptorPermissionChangeInvoked: false },
        });
        const parent = fixture();
        fs.chmodSync(parent.root, 0o720);
        expect(run(parent)).toMatchObject({
            stage: 'parent-permissions-denied',
            permissionMetadataWritesPerformed: 0,
        });
        const sidecar = fixture();
        fs.writeFileSync(`${sidecar.databasePath}-wal`, 'test-only-sidecar');
        expect(run(sidecar)).toMatchObject({
            stage: 'sidecar-present',
            permissionMetadataWritesPerformed: 0,
        });
        const owner = fixture();
        const actualUid = fs.statSync(owner.databasePath).uid;
        expect(run(owner, { getEffectiveUid: () => actualUid })).toMatchObject({
            stage: 'owner-compatibility-denied',
            permissionMetadataWritesPerformed: 0,
            checks: {
                runtimeEffectiveUidContractVerified: false,
                fileOwnerCompatibleWithProcess: false,
            },
        });
        expect(fs.statSync(owner.databasePath).mode & 0o777).toBe(ORIGINAL_MODE);
    });
    it('accepts the exact root runtime contract without emitting either uid', () => {
        const loaded = fixture();
        const base = dependencies(loaded);
        const filesystem = base.filesystem;
        const differentOwner = (stat) => new Proxy(stat, {
            get(target, property, receiver) {
                if (property === 'uid')
                    return target.uid + 1000;
                return Reflect.get(target, property, receiver);
            },
        });
        const result = run(loaded, {
            getEffectiveUid: () => 0,
            filesystem: {
                lstatSync: ((value) => differentOwner(fs.lstatSync(mapPath(loaded, value)))),
                fstatSync: ((descriptor) => differentOwner(fs.fstatSync(descriptor))),
            },
        });
        expect(result.status).toBe('permission_repair_verified');
        expect(JSON.stringify(result)).not.toContain(String(fs.statSync(loaded.databasePath).uid));
    });
    it('detects atomic target substitution before fchmod and leaves the held inode unchanged', () => {
        const loaded = fixture();
        const replacement = fixture();
        const base = dependencies(loaded);
        let databaseLstats = 0;
        const fchmodSync = vi.fn(fs.fchmodSync);
        const result = run(loaded, {
            filesystem: {
                lstatSync: ((value) => {
                    if (String(value) === FIXED_PATH) {
                        databaseLstats += 1;
                        if (databaseLstats === 2) {
                            fs.renameSync(loaded.databasePath, `${loaded.databasePath}.held`);
                            fs.copyFileSync(replacement.databasePath, loaded.databasePath);
                            fs.chmodSync(loaded.databasePath, ORIGINAL_MODE);
                        }
                    }
                    return fs.lstatSync(mapPath(loaded, value));
                }),
                fchmodSync,
            },
        });
        expect(result).toMatchObject({
            stage: 'prechange-path-identity-denied',
            permissionMetadataWritesPerformed: 0,
            checks: { descriptorPermissionChangeInvoked: false },
        });
        expect(fchmodSync).not.toHaveBeenCalled();
        expect(fs.statSync(`${loaded.databasePath}.held`).mode & 0o777).toBe(ORIGINAL_MODE);
        expect(base.filesystem).toBeDefined();
    });
    it('reports parent descriptor open, inspection, and identity failures before fchmod', () => {
        const open = fixture();
        const openResult = run(open, {
            filesystem: {
                openSync: ((value, flags) => {
                    if (String(value) === path.dirname(FIXED_PATH)) {
                        throw Object.assign(new Error('private detail'), { code: 'EIO' });
                    }
                    return fs.openSync(mapPath(open, value), flags);
                }),
            },
        });
        expect(openResult).toMatchObject({
            stage: 'parent-descriptor-open-denied',
            permissionMetadataWritesPerformed: 0,
            checks: { databaseDescriptorClosed: true },
        });
        const inspect = fixture();
        let parentDescriptor = null;
        const inspectResult = run(inspect, {
            filesystem: {
                openSync: ((value, flags) => {
                    const descriptor = fs.openSync(mapPath(inspect, value), flags);
                    if (String(value) === path.dirname(FIXED_PATH))
                        parentDescriptor = descriptor;
                    return descriptor;
                }),
                fstatSync: ((descriptor) => {
                    if (descriptor === parentDescriptor) {
                        throw Object.assign(new Error('private detail'), { code: 'EIO' });
                    }
                    return fs.fstatSync(descriptor);
                }),
            },
        });
        expect(inspectResult).toMatchObject({
            stage: 'parent-descriptor-inspection-denied',
            permissionMetadataWritesPerformed: 0,
            checks: { databaseDescriptorClosed: true, parentDescriptorClosed: true },
        });
        const identity = fixture();
        let identityParentDescriptor = null;
        const identityResult = run(identity, {
            filesystem: {
                openSync: ((value, flags) => {
                    const descriptor = fs.openSync(mapPath(identity, value), flags);
                    if (String(value) === path.dirname(FIXED_PATH))
                        identityParentDescriptor = descriptor;
                    return descriptor;
                }),
                fstatSync: ((descriptor) => {
                    const actual = fs.fstatSync(descriptor);
                    if (descriptor !== identityParentDescriptor)
                        return actual;
                    return new Proxy(actual, {
                        get(target, property, receiver) {
                            if (property === 'ino')
                                return target.ino + 1;
                            return Reflect.get(target, property, receiver);
                        },
                    });
                }),
            },
        });
        expect(identityResult).toMatchObject({
            stage: 'parent-descriptor-identity-denied',
            permissionMetadataWritesPerformed: 0,
        });
    });
    it('keeps a pre-fchmod descriptor-close ambiguity failed closed with zero metadata writes', () => {
        const loaded = fixture();
        const result = run(loaded, {
            filesystem: {
                openSync: ((value, flags) => {
                    if (String(value) === path.dirname(FIXED_PATH)) {
                        throw Object.assign(new Error('private detail'), { code: 'EIO' });
                    }
                    return fs.openSync(mapPath(loaded, value), flags);
                }),
                closeSync: ((descriptor) => {
                    fs.closeSync(descriptor);
                    throw Object.assign(new Error('private detail'), { code: 'EIO' });
                }),
            },
        });
        expect(result).toMatchObject({
            status: 'permission_repair_failed_closed',
            stage: 'descriptor-close-ambiguous',
            permissionMetadataWritesPerformed: 0,
            checks: {
                descriptorPermissionChangeInvoked: false,
                databaseDescriptorClosed: false,
            },
        });
    });
    it('stops before fchmod for an early sidecar and reports post-change sidecar drift without another write', () => {
        const before = fixture();
        let beforeSidecarChecks = 0;
        const beforeResult = run(before, {
            filesystem: {
                lstatSync: ((value) => {
                    if (String(value).startsWith(FIXED_PATH) && String(value) !== FIXED_PATH) {
                        beforeSidecarChecks += 1;
                        if (beforeSidecarChecks === 4) {
                            fs.writeFileSync(`${before.databasePath}-wal`, 'test-only-sidecar');
                        }
                    }
                    return fs.lstatSync(mapPath(before, value));
                }),
            },
        });
        expect(beforeResult).toMatchObject({
            stage: 'prechange-sidecar-present',
            permissionMetadataWritesPerformed: 0,
            checks: { descriptorPermissionChangeInvoked: false },
        });
        const after = fixture();
        let afterSidecarChecks = 0;
        const afterResult = run(after, {
            filesystem: {
                lstatSync: ((value) => {
                    if (String(value).startsWith(FIXED_PATH) && String(value) !== FIXED_PATH) {
                        afterSidecarChecks += 1;
                        if (afterSidecarChecks === 7) {
                            fs.writeFileSync(`${after.databasePath}-wal`, 'test-only-sidecar');
                        }
                    }
                    return fs.lstatSync(mapPath(after, value));
                }),
            },
        });
        expect(afterResult).toMatchObject({
            status: 'permission_repair_outcome_unknown',
            stage: 'postchange-sidecar-present',
            permissionMetadataWritesPerformed: 1,
        });
        expect(fs.statSync(after.databasePath).mode & 0o777).toBe(0o600);
    });
    it('reports an unknown outcome without retry when fchmod does not establish mode 0600', () => {
        const loaded = fixture();
        let calls = 0;
        const result = run(loaded, {
            filesystem: {
                fchmodSync: ((descriptor, mode) => {
                    calls += 1;
                    void descriptor;
                    void mode;
                }),
            },
        });
        expect(result).toMatchObject({
            status: 'permission_repair_outcome_unknown',
            stage: 'postchange-mode-denied',
            permissionMetadataWritesPerformed: 'unknown',
        });
        expect(calls).toBe(1);
        expect(fs.statSync(loaded.databasePath).mode & 0o777).toBe(ORIGINAL_MODE);
    });
    it.each([0o666, 0o400])('does not overwrite concurrent same-inode mode drift to %s after repair', (concurrentMode) => {
        const loaded = fixture();
        let fchmodCalls = 0;
        let reads = 0;
        const result = run(loaded, {
            filesystem: {
                fchmodSync: ((descriptor, mode) => {
                    fchmodCalls += 1;
                    fs.fchmodSync(descriptor, mode);
                    if (fchmodCalls === 1)
                        fs.fchmodSync(descriptor, concurrentMode);
                }),
                readSync: ((...args) => {
                    reads += 1;
                    return fs.readSync(...args);
                }),
            },
        });
        expect(result).toMatchObject({
            status: 'permission_repair_outcome_unknown',
            stage: 'postchange-mode-denied',
            permissionMetadataWritesPerformed: 'unknown',
        });
        expect(fchmodCalls).toBe(1);
        expect(reads).toBe(1);
        expect(fs.statSync(loaded.databasePath).mode & 0o777).toBe(concurrentMode);
    });
    it.each(['database', 'parent'])('binds %s gid after fchmod and never writes again after concurrent ownership drift', (target) => {
        const loaded = fixture(0o640);
        let databaseDescriptor = null;
        let parentDescriptor = null;
        let drifted = false;
        let fchmodCalls = 0;
        const result = run(loaded, {
            filesystem: {
                openSync: ((value, flags) => {
                    const descriptor = fs.openSync(mapPath(loaded, value), flags);
                    if (String(value) === FIXED_PATH)
                        databaseDescriptor = descriptor;
                    if (String(value) === path.dirname(FIXED_PATH))
                        parentDescriptor = descriptor;
                    return descriptor;
                }),
                fstatSync: ((descriptor) => {
                    const actual = fs.fstatSync(descriptor);
                    const shouldDrift = drifted && ((target === 'database' && descriptor === databaseDescriptor)
                        || (target === 'parent' && descriptor === parentDescriptor));
                    if (!shouldDrift)
                        return actual;
                    return new Proxy(actual, {
                        get(stat, property, receiver) {
                            if (property === 'gid')
                                return stat.gid + 1;
                            return Reflect.get(stat, property, receiver);
                        },
                    });
                }),
                fchmodSync: ((descriptor, mode) => {
                    fchmodCalls += 1;
                    fs.fchmodSync(descriptor, mode);
                    drifted = true;
                }),
            },
        });
        expect(result).toMatchObject({
            status: 'permission_repair_outcome_unknown',
            stage: target === 'database'
                ? 'postchange-identity-denied'
                : 'postchange-path-identity-denied',
            permissionMetadataWritesPerformed: target === 'database' ? 'unknown' : 1,
        });
        expect(fchmodCalls).toBe(1);
        expect(fs.statSync(loaded.databasePath).mode & 0o777).toBe(0o600);
    });
    it('never scans concurrent growth or writes again after a post-fchmod sync failure', () => {
        const loaded = fixture();
        const initialSize = fs.statSync(loaded.databasePath).size;
        let fchmodCalls = 0;
        let fsyncCalls = 0;
        let reads = 0;
        const result = run(loaded, {
            filesystem: {
                fchmodSync: ((descriptor, mode) => {
                    fchmodCalls += 1;
                    fs.fchmodSync(descriptor, mode);
                }),
                fsyncSync: ((descriptor) => {
                    fsyncCalls += 1;
                    if (fsyncCalls === 1) {
                        fs.appendFileSync(loaded.databasePath, Buffer.from('growth'));
                        throw Object.assign(new Error('private detail'), { code: 'EIO' });
                    }
                    fs.fsyncSync(descriptor);
                }),
                readSync: ((...args) => {
                    reads += 1;
                    return fs.readSync(...args);
                }),
            },
        });
        expect(result).toMatchObject({
            status: 'permission_repair_outcome_unknown',
            stage: 'file-sync-denied',
            permissionMetadataWritesPerformed: 1,
        });
        expect(fchmodCalls).toBe(1);
        expect(reads).toBe(1);
        expect(fs.statSync(loaded.databasePath).size).toBeGreaterThan(initialSize);
        expect(fs.statSync(loaded.databasePath).mode & 0o777).toBe(0o600);
    });
    it('detects post-fchmod content drift with masked mtime and never writes again', () => {
        const loaded = fixture();
        const initialMtime = fs.statSync(loaded.databasePath).mtimeMs;
        let databaseDescriptor = null;
        let drifted = false;
        let fchmodCalls = 0;
        let reads = 0;
        const stableMtime = (stat) => new Proxy(stat, {
            get(target, property, receiver) {
                if (drifted && property === 'mtimeMs')
                    return initialMtime;
                return Reflect.get(target, property, receiver);
            },
        });
        const result = run(loaded, {
            filesystem: {
                openSync: ((value, flags) => {
                    const descriptor = fs.openSync(mapPath(loaded, value), flags);
                    if (String(value) === FIXED_PATH)
                        databaseDescriptor = descriptor;
                    return descriptor;
                }),
                lstatSync: ((value) => {
                    const actual = fs.lstatSync(mapPath(loaded, value));
                    return String(value) === FIXED_PATH ? stableMtime(actual) : actual;
                }),
                fstatSync: ((descriptor) => {
                    const actual = fs.fstatSync(descriptor);
                    return descriptor === databaseDescriptor ? stableMtime(actual) : actual;
                }),
                fchmodSync: ((descriptor, mode) => {
                    fchmodCalls += 1;
                    fs.fchmodSync(descriptor, mode);
                }),
                readSync: ((...args) => {
                    reads += 1;
                    if (reads === 2) {
                        const writer = fs.openSync(loaded.databasePath, fs.constants.O_WRONLY);
                        fs.writeSync(writer, Buffer.from('X'), 0, 1, 0);
                        fs.closeSync(writer);
                        drifted = true;
                    }
                    return fs.readSync(...args);
                }),
            },
        });
        expect(result).toMatchObject({
            status: 'permission_repair_outcome_unknown',
            stage: 'postchange-content-changed',
            permissionMetadataWritesPerformed: 1,
        });
        expect(fchmodCalls).toBe(1);
        expect(fs.statSync(loaded.databasePath).mode & 0o777).toBe(0o600);
    });
    it('reports post-fchmod path substitution and leaves both modes untouched afterward', () => {
        const loaded = fixture();
        const replacement = fixture(0o660);
        let syncCalls = 0;
        const result = run(loaded, {
            filesystem: {
                fsyncSync: ((descriptor) => {
                    syncCalls += 1;
                    fs.fsyncSync(descriptor);
                    if (syncCalls === 1) {
                        fs.renameSync(loaded.databasePath, `${loaded.databasePath}.held`);
                        fs.copyFileSync(replacement.databasePath, loaded.databasePath);
                        fs.chmodSync(loaded.databasePath, 0o660);
                    }
                }),
            },
        });
        expect(result).toMatchObject({
            status: 'permission_repair_outcome_unknown',
            stage: 'postchange-path-identity-denied',
            permissionMetadataWritesPerformed: 1,
        });
        expect(fs.statSync(`${loaded.databasePath}.held`).mode & 0o777).toBe(0o600);
        expect(fs.statSync(loaded.databasePath).mode & 0o777).toBe(0o660);
    });
    it('does not retry after an apply-then-throw fchmod ambiguity', () => {
        const loaded = fixture();
        let calls = 0;
        const result = run(loaded, {
            filesystem: {
                fchmodSync: ((descriptor, mode) => {
                    calls += 1;
                    fs.fchmodSync(descriptor, mode);
                    if (calls === 1)
                        throw Object.assign(new Error('private detail'), { code: 'EIO' });
                }),
            },
        });
        expect(result).toMatchObject({
            status: 'permission_repair_outcome_unknown',
            stage: 'permission-change-denied',
            permissionMetadataWritesPerformed: 'unknown',
        });
        expect(calls).toBe(1);
        expect(fs.statSync(loaded.databasePath).mode & 0o777).toBe(0o600);
    });
    it.each([
        ['database fsync', 'file-sync-denied', 1],
        ['parent fsync', 'parent-sync-denied', 2],
    ])('reports unknown without another metadata write after %s failure', (_label, stage, failingCall) => {
        const loaded = fixture();
        let calls = 0;
        let fchmodCalls = 0;
        const result = run(loaded, {
            filesystem: {
                fchmodSync: ((descriptor, mode) => {
                    fchmodCalls += 1;
                    fs.fchmodSync(descriptor, mode);
                }),
                fsyncSync: ((descriptor) => {
                    calls += 1;
                    if (calls === failingCall)
                        throw Object.assign(new Error('private detail'), { code: 'EIO' });
                    fs.fsyncSync(descriptor);
                }),
            },
        });
        expect(result).toMatchObject({
            status: 'permission_repair_outcome_unknown',
            stage,
            permissionMetadataWritesPerformed: 1,
        });
        expect(fchmodCalls).toBe(1);
        expect(fs.statSync(loaded.databasePath).mode & 0o777).toBe(0o600);
    });
    it('reports a post-fstat ambiguity without another metadata write', () => {
        const loaded = fixture();
        const base = dependencies(loaded);
        let databaseDescriptor = null;
        let databaseFstats = 0;
        const result = run(loaded, {
            filesystem: {
                openSync: ((value, flags) => {
                    const descriptor = fs.openSync(mapPath(loaded, value), flags);
                    if (String(value) === FIXED_PATH)
                        databaseDescriptor = descriptor;
                    return descriptor;
                }),
                fstatSync: ((descriptor) => {
                    if (descriptor === databaseDescriptor) {
                        databaseFstats += 1;
                        if (databaseFstats === 3) {
                            throw Object.assign(new Error('private detail'), { code: 'EIO' });
                        }
                    }
                    return fs.fstatSync(descriptor);
                }),
            },
        });
        expect(result).toMatchObject({
            status: 'permission_repair_outcome_unknown',
            stage: 'postchange-inspection-denied',
            permissionMetadataWritesPerformed: 'unknown',
        });
        expect(fs.statSync(loaded.databasePath).mode & 0o777).toBe(0o600);
        expect(base.filesystem).toBeDefined();
    });
    it('fails before fchmod on an initial read error and reports unknown after a postchange read error', () => {
        const before = fixture();
        expect(run(before, {
            filesystem: {
                readSync: (() => {
                    throw Object.assign(new Error('private detail'), { code: 'EIO' });
                }),
            },
        })).toMatchObject({
            stage: 'content-proof-denied',
            permissionMetadataWritesPerformed: 0,
        });
        const after = fixture();
        let reads = 0;
        const result = run(after, {
            filesystem: {
                readSync: ((...args) => {
                    reads += 1;
                    if (reads === 2)
                        throw Object.assign(new Error('private detail'), { code: 'EIO' });
                    return fs.readSync(...args);
                }),
            },
        });
        expect(result).toMatchObject({
            status: 'permission_repair_outcome_unknown',
            stage: 'postchange-content-proof-denied',
            permissionMetadataWritesPerformed: 1,
        });
        expect(fs.statSync(after.databasePath).mode & 0o777).toBe(0o600);
    });
    it('detects changed content or mtime without another metadata write', () => {
        const content = fixture();
        let contentReads = 0;
        const contentResult = run(content, {
            filesystem: {
                readSync: ((...args) => {
                    contentReads += 1;
                    if (contentReads === 2) {
                        const descriptor = fs.openSync(content.databasePath, fs.constants.O_WRONLY);
                        fs.writeSync(descriptor, Buffer.from('X'), 0, 1, 0);
                        fs.closeSync(descriptor);
                    }
                    return fs.readSync(...args);
                }),
            },
        });
        expect(contentResult).toMatchObject({
            status: 'permission_repair_outcome_unknown',
            stage: 'postchange-content-changed',
            permissionMetadataWritesPerformed: 1,
        });
        const mtime = fixture();
        let mtimeReads = 0;
        const mtimeResult = run(mtime, {
            filesystem: {
                readSync: ((...args) => {
                    mtimeReads += 1;
                    if (mtimeReads === 2) {
                        const next = new Date(fs.statSync(mtime.databasePath).mtimeMs + 2_000);
                        fs.utimesSync(mtime.databasePath, next, next);
                    }
                    return fs.readSync(...args);
                }),
            },
        });
        expect(mtimeResult).toMatchObject({
            status: 'permission_repair_outcome_unknown',
            stage: 'postchange-mtime-changed',
            permissionMetadataWritesPerformed: 1,
        });
    });
    it('never overwrites a concurrent third mode after the sole repair fchmod', () => {
        const loaded = fixture();
        let candidateFchmodCalls = 0;
        let syncCalls = 0;
        const result = run(loaded, {
            filesystem: {
                fchmodSync: ((descriptor, mode) => {
                    candidateFchmodCalls += 1;
                    fs.fchmodSync(descriptor, mode);
                }),
                fsyncSync: ((descriptor) => {
                    syncCalls += 1;
                    if (syncCalls === 1) {
                        fs.fchmodSync(descriptor, 0o400);
                        throw Object.assign(new Error('private detail'), { code: 'EIO' });
                    }
                    fs.fsyncSync(descriptor);
                }),
            },
        });
        expect(result).toMatchObject({
            status: 'permission_repair_outcome_unknown',
            stage: 'file-sync-denied',
            permissionMetadataWritesPerformed: 1,
        });
        expect(candidateFchmodCalls).toBe(1);
        expect(fs.statSync(loaded.databasePath).mode & 0o777).toBe(0o400);
    });
    it('reports post-change descriptor-close ambiguity without a retry claim', () => {
        const close = fixture();
        let closeCalls = 0;
        let fchmodCalls = 0;
        const closeResult = run(close, {
            filesystem: {
                fchmodSync: ((descriptor, mode) => {
                    fchmodCalls += 1;
                    fs.fchmodSync(descriptor, mode);
                }),
                closeSync: ((descriptor) => {
                    closeCalls += 1;
                    fs.closeSync(descriptor);
                    if (closeCalls === 1)
                        throw Object.assign(new Error('private detail'), { code: 'EIO' });
                }),
            },
        });
        expect(closeResult).toMatchObject({
            status: 'permission_repair_outcome_unknown',
            stage: 'descriptor-close-ambiguous',
            permissionMetadataWritesPerformed: 1,
            checks: { databaseDescriptorClosed: false },
        });
        expect(fchmodCalls).toBe(1);
        expect(fs.statSync(close.databasePath).mode & 0o777).toBe(0o600);
    });
    it('keeps stages, output keys, and the runtime implementation frozen and capability-narrow', () => {
        expect(Object.isFrozen(SHOPIFY_DATABASE_PERMISSION_REPAIR_STAGES)).toBe(true);
        expect(new Set(SHOPIFY_DATABASE_PERMISSION_REPAIR_STAGES).size)
            .toBe(SHOPIFY_DATABASE_PERMISSION_REPAIR_STAGES.length);
        const source = fs.readFileSync(new URL('./database-permission-repair.ts', import.meta.url), 'utf8');
        expect(source).not.toMatch(/child_process|spawn|execSync|fetch\s*\(|node:(?:http|https|net|dns)/u);
        expect(source).not.toMatch(/auth_tokens|access_token|refresh_token|SELECT\s|UPDATE\s/iu);
        expect(source).not.toMatch(/\.chmodSync\s*\(/u);
        expect(source).not.toMatch(/Object\.(?:keys|entries)\s*\(\s*(?:process\.)?env/u);
        expect(source.match(/filesystem\.fchmodSync\s*\(/gu)).toHaveLength(1);
        expect(source).toContain('filesystem.fchmodSync(descriptor, REQUIRED_DATABASE_MODE)');
        expect(source).not.toMatch(/rollback|restore/iu);
        const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
        const dockerfile = fs.readFileSync(path.join(repositoryRoot, 'Dockerfile'), 'utf8');
        const railway = fs.readFileSync(path.join(repositoryRoot, 'railway.json'), 'utf8');
        expect(dockerfile).toMatch(/^FROM node:20$/mu);
        expect(dockerfile).not.toMatch(/^\s*USER\b/mu);
        expect(dockerfile).toContain('CMD ["node", "dist/server/index.js"]');
        expect(railway).toContain('"startCommand": "node dist/server/index.js"');
        expect(PRODUCT_PIPELINE_PRODUCTION_RUNTIME.databasePermissionRepairEffectiveUid).toBe(0);
    });
});
