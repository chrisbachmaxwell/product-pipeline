import { createHash, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import { assertShopifyCredentialDatabasePermissionRepairRuntimeBinding, PRODUCT_PIPELINE_PRODUCTION_RUNTIME, } from './config.js';
const MAXIMUM_DATABASE_BYTES = 512 * 1_024 * 1_024;
const REQUIRED_DATABASE_MODE = 0o600;
const MODE_BITS = 0o7777;
const SPECIAL_MODE_BITS = 0o7000;
const SIDECAR_SUFFIXES = Object.freeze(['-journal', '-wal', '-shm']);
export const SHOPIFY_DATABASE_PERMISSION_REPAIR_STAGES = Object.freeze([
    'configuration-denied',
    'file-missing',
    'file-inspection-denied',
    'file-type-denied',
    'file-link-denied',
    'file-empty-denied',
    'file-size-denied',
    'file-mode-already-0600',
    'file-mode-denied',
    'parent-inspection-denied',
    'parent-type-denied',
    'parent-permissions-denied',
    'sidecar-inspection-denied',
    'sidecar-present',
    'descriptor-open-denied',
    'descriptor-inspection-denied',
    'descriptor-identity-denied',
    'owner-compatibility-denied',
    'parent-descriptor-open-denied',
    'parent-descriptor-inspection-denied',
    'parent-descriptor-identity-denied',
    'content-proof-denied',
    'prechange-inspection-denied',
    'prechange-identity-denied',
    'prechange-path-inspection-denied',
    'prechange-path-identity-denied',
    'prechange-sidecar-inspection-denied',
    'prechange-sidecar-present',
    'permission-change-denied',
    'postchange-inspection-denied',
    'postchange-identity-denied',
    'postchange-mode-denied',
    'file-sync-denied',
    'parent-sync-denied',
    'postchange-content-proof-denied',
    'postchange-content-changed',
    'postchange-mtime-changed',
    'postchange-path-inspection-denied',
    'postchange-path-identity-denied',
    'postchange-sidecar-inspection-denied',
    'postchange-sidecar-present',
    'descriptor-close-ambiguous',
    'verified',
]);
function initialChecks() {
    return {
        runtimeBindingVerified: false,
        fixedDatabaseTargetVerified: false,
        listingWriterAckAbsent: false,
        rotationAuthorityAbsent: false,
        singleReplicaTopologyVerified: false,
        singleVolumeTopologyVerified: false,
        filePresent: false,
        fileRegular: false,
        fileSymlinkAbsent: false,
        fileSingleLink: false,
        fileNonEmpty: false,
        fileWithinSizeLimit: false,
        repairRequired: false,
        originalModeSafe: false,
        parentDirectory: false,
        parentSymlinkAbsent: false,
        parentGroupWorldWritableAbsent: false,
        sqliteSidecarsAbsentBeforeRepair: false,
        descriptorOpenedReadOnlyNoFollow: false,
        descriptorInspectedBeforeRepair: false,
        descriptorIdentityStableBeforeRepair: false,
        processEffectiveUidAvailable: false,
        runtimeEffectiveUidContractVerified: false,
        fileOwnerCompatibleWithProcess: false,
        parentDescriptorOpenedReadOnlyNoFollow: false,
        parentDescriptorIdentityStable: false,
        parentOwnerCompatibleWithProcess: false,
        contentDigestCapturedBeforeRepair: false,
        mtimeCapturedBeforeRepair: false,
        descriptorStableImmediatelyBeforeRepair: false,
        parentDescriptorStableImmediatelyBeforeRepair: false,
        pathStableImmediatelyBeforeRepair: false,
        parentPathStableImmediatelyBeforeRepair: false,
        sqliteSidecarsAbsentImmediatelyBeforeRepair: false,
        descriptorPermissionChangeInvoked: false,
        mode0600VerifiedAfterRepair: false,
        databaseDescriptorSynced: false,
        parentDescriptorSynced: false,
        descriptorIdentityStableAfterRepair: false,
        fileOwnerStableAfterRepair: false,
        fileSizeStableAfterRepair: false,
        contentDigestUnchangedAfterRepair: false,
        mtimeUnchangedAfterRepair: false,
        pathIdentityStableAfterRepair: false,
        parentIdentityStableAfterRepair: false,
        sqliteSidecarsAbsentAfterRepair: false,
        databaseDescriptorClosed: false,
        parentDescriptorClosed: false,
    };
}
function errorCode(error) {
    if (error === null || typeof error !== 'object' || !('code' in error))
        return null;
    return typeof error.code === 'string' ? error.code : null;
}
function modeOf(stat) {
    return stat.mode & MODE_BITS;
}
function safeNonnegativeInteger(value) {
    return Number.isSafeInteger(value) && value >= 0;
}
function fileMetadataRepresentable(stat) {
    return safeNonnegativeInteger(stat.dev)
        && safeNonnegativeInteger(stat.ino)
        && safeNonnegativeInteger(stat.uid)
        && safeNonnegativeInteger(stat.gid)
        && safeNonnegativeInteger(stat.mode)
        && safeNonnegativeInteger(stat.nlink)
        && safeNonnegativeInteger(stat.size)
        && Number.isFinite(stat.mtimeMs);
}
function sameFileIdentity(left, right) {
    return fileMetadataRepresentable(left)
        && fileMetadataRepresentable(right)
        && right.isFile()
        && !right.isSymbolicLink()
        && right.nlink === 1
        && right.dev === left.dev
        && right.ino === left.ino
        && right.uid === left.uid
        && right.gid === left.gid
        && right.size === left.size;
}
function sameOwnerAndMtime(left, right) {
    return right.uid === left.uid
        && right.gid === left.gid
        && right.mtimeMs === left.mtimeMs;
}
function sameDirectoryIdentity(left, right) {
    return fileMetadataRepresentable(left)
        && fileMetadataRepresentable(right)
        && right.isDirectory()
        && !right.isSymbolicLink()
        && right.dev === left.dev
        && right.ino === left.ino
        && right.uid === left.uid
        && right.gid === left.gid
        && right.nlink === left.nlink
        && right.size === left.size
        && right.mtimeMs === left.mtimeMs
        && modeOf(right) === modeOf(left)
        && (right.mode & 0o022) === 0;
}
function ownerCompatible(ownerUid, effectiveUid) {
    return effectiveUid === PRODUCT_PIPELINE_PRODUCTION_RUNTIME.databasePermissionRepairEffectiveUid
        && (effectiveUid === 0 || ownerUid === effectiveUid);
}
function inspectSidecars(filesystem, databasePath) {
    for (const suffix of SIDECAR_SUFFIXES) {
        try {
            filesystem.lstatSync(`${databasePath}${suffix}`);
            return 'present';
        }
        catch (error) {
            if (errorCode(error) !== 'ENOENT')
                return 'denied';
        }
    }
    return 'absent';
}
function digestDescriptor(filesystem, descriptor, size) {
    const digest = createHash('sha256');
    const chunk = Buffer.allocUnsafe(Math.min(size, 1024 * 1024));
    let offset = 0;
    try {
        while (offset < size) {
            const length = Math.min(chunk.length, size - offset);
            const read = filesystem.readSync(descriptor, chunk, 0, length, offset);
            if (!Number.isSafeInteger(read) || read <= 0 || read > length) {
                throw new Error('descriptor read denied');
            }
            digest.update(chunk.subarray(0, read));
            offset += read;
        }
        return digest.digest();
    }
    finally {
        chunk.fill(0);
    }
}
function frozenReport(input) {
    let status;
    if (input.stage === 'verified')
        status = 'permission_repair_verified';
    else if (input.checks.descriptorPermissionChangeInvoked) {
        status = 'permission_repair_outcome_unknown';
    }
    else
        status = 'permission_repair_failed_closed';
    return Object.freeze({
        status,
        stage: input.stage,
        checks: Object.freeze({ ...input.checks }),
        permissionMetadataWritesPerformed: input.permissionMetadataWritesPerformed,
        databaseContentWritesPerformed: 0,
        providerNetworkRequestsPerformed: 0,
        credentialWritesPerformed: 0,
        providerCredentialMutationsPerformed: 0,
        externalCommerceWritesPerformed: 0,
    });
}
export function repairFixedProductionShopifyDatabasePermissions(environment = process.env, dependencies = {}) {
    const checks = initialChecks();
    const filesystem = dependencies.filesystem ?? fs;
    const getEffectiveUid = dependencies.getEffectiveUid ?? process.geteuid?.bind(process);
    const databasePath = PRODUCT_PIPELINE_PRODUCTION_RUNTIME.databasePath;
    const parentPath = path.dirname(databasePath);
    let descriptor = null;
    let parentDescriptor = null;
    let initial = null;
    let parentInitial = null;
    let originalMode = null;
    let beforeDigest = null;
    let permissionMetadataWritesPerformed = 0;
    const closeDescriptors = () => {
        let closed = true;
        if (descriptor !== null) {
            try {
                filesystem.closeSync(descriptor);
                checks.databaseDescriptorClosed = true;
            }
            catch {
                closed = false;
            }
            descriptor = null;
        }
        if (parentDescriptor !== null) {
            try {
                filesystem.closeSync(parentDescriptor);
                checks.parentDescriptorClosed = true;
            }
            catch {
                closed = false;
            }
            parentDescriptor = null;
        }
        return closed;
    };
    const finish = (stage) => {
        const closed = closeDescriptors();
        beforeDigest?.fill(0);
        beforeDigest = null;
        const finalStage = !closed ? 'descriptor-close-ambiguous' : stage;
        return frozenReport({
            stage: finalStage,
            checks,
            permissionMetadataWritesPerformed,
        });
    };
    try {
        assertShopifyCredentialDatabasePermissionRepairRuntimeBinding(environment);
    }
    catch {
        return finish('configuration-denied');
    }
    checks.runtimeBindingVerified = true;
    checks.fixedDatabaseTargetVerified = true;
    checks.listingWriterAckAbsent = true;
    checks.rotationAuthorityAbsent = true;
    checks.singleReplicaTopologyVerified = true;
    checks.singleVolumeTopologyVerified = true;
    try {
        initial = filesystem.lstatSync(databasePath);
        checks.filePresent = true;
    }
    catch (error) {
        return finish(errorCode(error) === 'ENOENT' ? 'file-missing' : 'file-inspection-denied');
    }
    checks.fileSymlinkAbsent = !initial.isSymbolicLink();
    checks.fileRegular = initial.isFile();
    if (!checks.fileRegular || !checks.fileSymlinkAbsent)
        return finish('file-type-denied');
    if (!fileMetadataRepresentable(initial))
        return finish('file-inspection-denied');
    checks.fileSingleLink = initial.nlink === 1;
    if (!checks.fileSingleLink)
        return finish('file-link-denied');
    checks.fileNonEmpty = initial.size > 0;
    if (!checks.fileNonEmpty)
        return finish('file-empty-denied');
    checks.fileWithinSizeLimit = Number.isSafeInteger(initial.size)
        && initial.size <= MAXIMUM_DATABASE_BYTES;
    if (!checks.fileWithinSizeLimit)
        return finish('file-size-denied');
    originalMode = modeOf(initial);
    checks.repairRequired = originalMode !== REQUIRED_DATABASE_MODE;
    if (!checks.repairRequired)
        return finish('file-mode-already-0600');
    checks.originalModeSafe = (originalMode & SPECIAL_MODE_BITS) === 0;
    if (!checks.originalModeSafe)
        return finish('file-mode-denied');
    try {
        parentInitial = filesystem.lstatSync(parentPath);
    }
    catch {
        return finish('parent-inspection-denied');
    }
    checks.parentDirectory = parentInitial.isDirectory();
    checks.parentSymlinkAbsent = !parentInitial.isSymbolicLink();
    if (!checks.parentDirectory || !checks.parentSymlinkAbsent)
        return finish('parent-type-denied');
    if (!fileMetadataRepresentable(parentInitial))
        return finish('parent-inspection-denied');
    checks.parentGroupWorldWritableAbsent = (parentInitial.mode & 0o022) === 0;
    if (!checks.parentGroupWorldWritableAbsent)
        return finish('parent-permissions-denied');
    const beforeSidecars = inspectSidecars(filesystem, databasePath);
    if (beforeSidecars === 'denied')
        return finish('sidecar-inspection-denied');
    checks.sqliteSidecarsAbsentBeforeRepair = beforeSidecars === 'absent';
    if (!checks.sqliteSidecarsAbsentBeforeRepair)
        return finish('sidecar-present');
    try {
        descriptor = filesystem.openSync(databasePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
        checks.descriptorOpenedReadOnlyNoFollow = true;
    }
    catch {
        return finish('descriptor-open-denied');
    }
    let opened;
    try {
        opened = filesystem.fstatSync(descriptor);
        checks.descriptorInspectedBeforeRepair = true;
    }
    catch {
        return finish('descriptor-inspection-denied');
    }
    checks.descriptorIdentityStableBeforeRepair = sameFileIdentity(initial, opened)
        && opened.uid === initial.uid
        && opened.gid === initial.gid
        && modeOf(opened) === originalMode;
    if (!checks.descriptorIdentityStableBeforeRepair)
        return finish('descriptor-identity-denied');
    let effectiveUid;
    try {
        effectiveUid = getEffectiveUid?.() ?? Number.NaN;
    }
    catch {
        effectiveUid = Number.NaN;
    }
    checks.processEffectiveUidAvailable = Number.isSafeInteger(effectiveUid) && effectiveUid >= 0;
    checks.runtimeEffectiveUidContractVerified = checks.processEffectiveUidAvailable
        && effectiveUid === PRODUCT_PIPELINE_PRODUCTION_RUNTIME.databasePermissionRepairEffectiveUid;
    checks.fileOwnerCompatibleWithProcess = checks.runtimeEffectiveUidContractVerified
        && ownerCompatible(opened.uid, effectiveUid);
    if (!checks.fileOwnerCompatibleWithProcess)
        return finish('owner-compatibility-denied');
    try {
        parentDescriptor = filesystem.openSync(parentPath, fsConstants.O_RDONLY
            | (fsConstants.O_DIRECTORY ?? 0)
            | (fsConstants.O_NOFOLLOW ?? 0));
        checks.parentDescriptorOpenedReadOnlyNoFollow = true;
    }
    catch {
        return finish('parent-descriptor-open-denied');
    }
    let openedParent;
    try {
        openedParent = filesystem.fstatSync(parentDescriptor);
    }
    catch {
        return finish('parent-descriptor-inspection-denied');
    }
    checks.parentDescriptorIdentityStable = sameDirectoryIdentity(parentInitial, openedParent);
    if (!checks.parentDescriptorIdentityStable)
        return finish('parent-descriptor-identity-denied');
    checks.parentOwnerCompatibleWithProcess = ownerCompatible(openedParent.uid, effectiveUid);
    if (!checks.parentOwnerCompatibleWithProcess)
        return finish('owner-compatibility-denied');
    try {
        beforeDigest = digestDescriptor(filesystem, descriptor, opened.size);
        checks.contentDigestCapturedBeforeRepair = true;
        checks.mtimeCapturedBeforeRepair = Number.isFinite(opened.mtimeMs);
    }
    catch {
        return finish('content-proof-denied');
    }
    if (!checks.mtimeCapturedBeforeRepair)
        return finish('content-proof-denied');
    let immediatelyBefore;
    try {
        immediatelyBefore = filesystem.fstatSync(descriptor);
    }
    catch {
        return finish('prechange-inspection-denied');
    }
    checks.descriptorStableImmediatelyBeforeRepair = sameFileIdentity(opened, immediatelyBefore)
        && sameOwnerAndMtime(opened, immediatelyBefore)
        && modeOf(immediatelyBefore) === originalMode;
    if (!checks.descriptorStableImmediatelyBeforeRepair)
        return finish('prechange-identity-denied');
    let parentImmediatelyBefore;
    try {
        parentImmediatelyBefore = filesystem.fstatSync(parentDescriptor);
    }
    catch {
        return finish('prechange-inspection-denied');
    }
    checks.parentDescriptorStableImmediatelyBeforeRepair = sameDirectoryIdentity(openedParent, parentImmediatelyBefore);
    if (!checks.parentDescriptorStableImmediatelyBeforeRepair) {
        return finish('prechange-identity-denied');
    }
    let pathImmediatelyBefore;
    try {
        pathImmediatelyBefore = filesystem.lstatSync(databasePath);
    }
    catch {
        return finish('prechange-path-inspection-denied');
    }
    checks.pathStableImmediatelyBeforeRepair = sameFileIdentity(opened, pathImmediatelyBefore)
        && sameOwnerAndMtime(opened, pathImmediatelyBefore)
        && modeOf(pathImmediatelyBefore) === originalMode;
    if (!checks.pathStableImmediatelyBeforeRepair)
        return finish('prechange-path-identity-denied');
    let parentPathImmediatelyBefore;
    try {
        parentPathImmediatelyBefore = filesystem.lstatSync(parentPath);
    }
    catch {
        return finish('prechange-path-inspection-denied');
    }
    checks.parentPathStableImmediatelyBeforeRepair = sameDirectoryIdentity(openedParent, parentPathImmediatelyBefore);
    if (!checks.parentPathStableImmediatelyBeforeRepair) {
        return finish('prechange-path-identity-denied');
    }
    const prechangeSidecars = inspectSidecars(filesystem, databasePath);
    if (prechangeSidecars === 'denied')
        return finish('prechange-sidecar-inspection-denied');
    checks.sqliteSidecarsAbsentImmediatelyBeforeRepair = prechangeSidecars === 'absent';
    if (!checks.sqliteSidecarsAbsentImmediatelyBeforeRepair) {
        return finish('prechange-sidecar-present');
    }
    checks.descriptorPermissionChangeInvoked = true;
    permissionMetadataWritesPerformed = 'unknown';
    try {
        filesystem.fchmodSync(descriptor, REQUIRED_DATABASE_MODE);
    }
    catch {
        return finish('permission-change-denied');
    }
    let afterModeChange;
    try {
        afterModeChange = filesystem.fstatSync(descriptor);
    }
    catch {
        return finish('postchange-inspection-denied');
    }
    checks.descriptorIdentityStableAfterRepair = sameFileIdentity(opened, afterModeChange);
    checks.fileOwnerStableAfterRepair = afterModeChange.uid === opened.uid
        && afterModeChange.gid === opened.gid;
    checks.fileSizeStableAfterRepair = afterModeChange.size === opened.size;
    if (!checks.descriptorIdentityStableAfterRepair
        || !checks.fileOwnerStableAfterRepair
        || !checks.fileSizeStableAfterRepair)
        return finish('postchange-identity-denied');
    checks.mode0600VerifiedAfterRepair = modeOf(afterModeChange) === REQUIRED_DATABASE_MODE;
    if (!checks.mode0600VerifiedAfterRepair)
        return finish('postchange-mode-denied');
    permissionMetadataWritesPerformed = 1;
    try {
        filesystem.fsyncSync(descriptor);
        checks.databaseDescriptorSynced = true;
    }
    catch {
        return finish('file-sync-denied');
    }
    try {
        filesystem.fsyncSync(parentDescriptor);
        checks.parentDescriptorSynced = true;
    }
    catch {
        return finish('parent-sync-denied');
    }
    let afterDigest;
    let postDigestStat;
    try {
        afterDigest = digestDescriptor(filesystem, descriptor, opened.size);
        postDigestStat = filesystem.fstatSync(descriptor);
    }
    catch {
        return finish('postchange-content-proof-denied');
    }
    checks.contentDigestUnchangedAfterRepair = beforeDigest !== null
        && beforeDigest.length === afterDigest.length
        && timingSafeEqual(beforeDigest, afterDigest);
    afterDigest.fill(0);
    if (!checks.contentDigestUnchangedAfterRepair) {
        return finish('postchange-content-changed');
    }
    checks.mtimeUnchangedAfterRepair = postDigestStat.mtimeMs === opened.mtimeMs;
    if (!checks.mtimeUnchangedAfterRepair)
        return finish('postchange-mtime-changed');
    checks.descriptorIdentityStableAfterRepair = sameFileIdentity(opened, postDigestStat);
    checks.fileOwnerStableAfterRepair = postDigestStat.uid === opened.uid
        && postDigestStat.gid === opened.gid;
    checks.fileSizeStableAfterRepair = postDigestStat.size === opened.size;
    if (!checks.descriptorIdentityStableAfterRepair
        || !checks.fileOwnerStableAfterRepair
        || !checks.fileSizeStableAfterRepair
        || modeOf(postDigestStat) !== REQUIRED_DATABASE_MODE)
        return finish('postchange-identity-denied');
    let afterPath;
    try {
        afterPath = filesystem.lstatSync(databasePath);
    }
    catch {
        return finish('postchange-path-inspection-denied');
    }
    checks.pathIdentityStableAfterRepair = sameFileIdentity(opened, afterPath)
        && afterPath.uid === opened.uid
        && afterPath.gid === opened.gid
        && modeOf(afterPath) === REQUIRED_DATABASE_MODE
        && afterPath.mtimeMs === opened.mtimeMs;
    if (!checks.pathIdentityStableAfterRepair)
        return finish('postchange-path-identity-denied');
    let afterParentDescriptor;
    let afterParentPath;
    try {
        afterParentDescriptor = filesystem.fstatSync(parentDescriptor);
        afterParentPath = filesystem.lstatSync(parentPath);
    }
    catch {
        return finish('postchange-path-inspection-denied');
    }
    checks.parentIdentityStableAfterRepair = sameDirectoryIdentity(openedParent, afterParentDescriptor) && sameDirectoryIdentity(openedParent, afterParentPath);
    if (!checks.parentIdentityStableAfterRepair) {
        return finish('postchange-path-identity-denied');
    }
    const afterSidecars = inspectSidecars(filesystem, databasePath);
    if (afterSidecars === 'denied')
        return finish('postchange-sidecar-inspection-denied');
    checks.sqliteSidecarsAbsentAfterRepair = afterSidecars === 'absent';
    if (!checks.sqliteSidecarsAbsentAfterRepair)
        return finish('postchange-sidecar-present');
    return finish('verified');
}
