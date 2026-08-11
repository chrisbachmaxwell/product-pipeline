import fs, { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import { deriveScopeKey, sha256Digest } from '../migration-store/store.js';
export const MIGRATION_DATABASE_RELATIVE_PATH = '.local/migration-state/product-pipeline-migration-v1.sqlite';
export class MigrationAdminConfigError extends Error {
    issues;
    constructor(issues) {
        super(`Migration-state configuration denied: ${issues.join('; ')}`);
        this.name = 'MigrationAdminConfigError';
        this.issues = issues;
    }
}
const MAX_CONFIG_BYTES = 32 * 1024;
const STORE_DOMAIN_PATTERN = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;
const SELLER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SENSITIVE_KEY_PATTERN = /(?:token|secret|password|api[_-]?key|client[_-]?secret|access[_-]?token|refresh[_-]?token|private[_-]?key|authorization|cookie)/i;
const SENSITIVE_VALUE_PATTERN = /(?:^Bearer\s+|^shpat_|^shpca_|^shppa_|^gh[pousr]_|^sk-[A-Za-z0-9_-]{10,}|^v\^1\.|-----BEGIN [A-Z ]*PRIVATE KEY-----|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})/i;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;
const ROOT_KEYS = [
    'schemaVersion',
    'project',
    'lane',
    'mode',
    'databasePath',
    'scope',
    'safety',
];
const SCOPE_KEYS = [
    'shopifyStoreDomain',
    'ebayEnvironment',
    'ebaySellerId',
    'ebayMarketplaceId',
];
const SAFETY_KEYS = [
    'externalPlatformAccess',
    'externalWrites',
    'historicalBackfill',
    'cutoverWatermarkUtc',
    'ownershipTransferAllowed',
    'credentialsAllowed',
];
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function requireRecord(value, fieldPath, issues) {
    if (!isRecord(value)) {
        issues.push(`${fieldPath} must be an object`);
        return null;
    }
    return value;
}
function requireExactKeys(value, keys, fieldPath, issues) {
    const allowed = new Set(keys);
    if (Object.keys(value).some((key) => !allowed.has(key))) {
        issues.push(`${fieldPath} contains unsupported fields`);
    }
    for (const key of keys) {
        if (!Object.hasOwn(value, key))
            issues.push(`${fieldPath}.${key} is required`);
    }
}
function findSensitiveMaterial(value, fieldPath, issues) {
    if (typeof value === 'string') {
        if (SENSITIVE_VALUE_PATTERN.test(value.trim())) {
            issues.push(`${fieldPath} contains credential-like or personal material`);
        }
        return;
    }
    if (Array.isArray(value)) {
        value.forEach((entry, index) => findSensitiveMaterial(entry, `${fieldPath}[${index}]`, issues));
        return;
    }
    if (!isRecord(value))
        return;
    for (const [key, child] of Object.entries(value)) {
        const childPath = `${fieldPath}.${key}`;
        if (SENSITIVE_KEY_PATTERN.test(key)) {
            issues.push(`${fieldPath} contains a forbidden credential-like field`);
            continue;
        }
        findSensitiveMaterial(child, childPath, issues);
    }
}
function literal(value, expected, fieldPath, issues) {
    if (value !== expected) {
        issues.push(`${fieldPath} has an unsafe or unsupported value`);
        return undefined;
    }
    return expected;
}
function enumeration(value, allowed, fieldPath, issues) {
    if (typeof value !== 'string' || !allowed.includes(value)) {
        issues.push(`${fieldPath} is missing or unsupported`);
        return undefined;
    }
    return value;
}
function exactIdentity(value, pattern, fieldPath, issues, maximumLength = 256) {
    if (typeof value !== 'string'
        || value.length === 0
        || value.length > maximumLength
        || value.trim() !== value
        || CONTROL_CHARACTER_PATTERN.test(value)
        || /[*?\[\]{}]/.test(value)
        || !pattern.test(value)) {
        issues.push(`${fieldPath} is missing or malformed`);
        return undefined;
    }
    return value;
}
export function parseMigrationAdminConfig(value) {
    const issues = [];
    // credentialsAllowed is the name of a required false safety assertion, not a
    // credential container. Every other credential-shaped key is forbidden.
    if (isRecord(value) && isRecord(value.safety)) {
        const safetyWithoutAssertion = { ...value.safety };
        delete safetyWithoutAssertion.credentialsAllowed;
        findSensitiveMaterial({ ...value, safety: safetyWithoutAssertion }, 'config', issues);
    }
    else {
        findSensitiveMaterial(value, 'config', issues);
    }
    const root = requireRecord(value, 'config', issues);
    if (!root)
        throw new MigrationAdminConfigError(issues);
    requireExactKeys(root, ROOT_KEYS, 'config', issues);
    const schemaVersion = literal(root.schemaVersion, 1, 'config.schemaVersion', issues);
    const project = literal(root.project, 'product-pipeline', 'config.project', issues);
    const lane = enumeration(root.lane, ['development', 'sandbox', 'production-shadow'], 'config.lane', issues);
    const mode = literal(root.mode, 'migration-state-admin', 'config.mode', issues);
    const databasePath = literal(root.databasePath, MIGRATION_DATABASE_RELATIVE_PATH, 'config.databasePath', issues);
    const scopeValue = requireRecord(root.scope, 'config.scope', issues);
    let scope;
    if (scopeValue) {
        requireExactKeys(scopeValue, SCOPE_KEYS, 'config.scope', issues);
        const shopifyStoreDomain = exactIdentity(scopeValue.shopifyStoreDomain, STORE_DOMAIN_PATTERN, 'config.scope.shopifyStoreDomain', issues);
        const ebayEnvironment = enumeration(scopeValue.ebayEnvironment, ['sandbox', 'production'], 'config.scope.ebayEnvironment', issues);
        const ebaySellerId = exactIdentity(scopeValue.ebaySellerId, SELLER_ID_PATTERN, 'config.scope.ebaySellerId', issues, 64);
        const ebayMarketplaceId = literal(scopeValue.ebayMarketplaceId, 'EBAY_US', 'config.scope.ebayMarketplaceId', issues);
        if (shopifyStoreDomain && ebayEnvironment && ebaySellerId && ebayMarketplaceId) {
            scope = { shopifyStoreDomain, ebayEnvironment, ebaySellerId, ebayMarketplaceId };
        }
    }
    const safetyValue = requireRecord(root.safety, 'config.safety', issues);
    let safety;
    if (safetyValue) {
        requireExactKeys(safetyValue, SAFETY_KEYS, 'config.safety', issues);
        const externalPlatformAccess = literal(safetyValue.externalPlatformAccess, false, 'config.safety.externalPlatformAccess', issues);
        const externalWrites = literal(safetyValue.externalWrites, false, 'config.safety.externalWrites', issues);
        const historicalBackfill = literal(safetyValue.historicalBackfill, false, 'config.safety.historicalBackfill', issues);
        const cutoverWatermarkUtc = literal(safetyValue.cutoverWatermarkUtc, null, 'config.safety.cutoverWatermarkUtc', issues);
        const ownershipTransferAllowed = literal(safetyValue.ownershipTransferAllowed, false, 'config.safety.ownershipTransferAllowed', issues);
        const credentialsAllowed = literal(safetyValue.credentialsAllowed, false, 'config.safety.credentialsAllowed', issues);
        if (externalPlatformAccess === false
            && externalWrites === false
            && historicalBackfill === false
            && cutoverWatermarkUtc === null
            && ownershipTransferAllowed === false
            && credentialsAllowed === false) {
            safety = {
                externalPlatformAccess,
                externalWrites,
                historicalBackfill,
                cutoverWatermarkUtc,
                ownershipTransferAllowed,
                credentialsAllowed,
            };
        }
    }
    if (lane && scope) {
        if (/^(?:replace|example|placeholder|changeme|todo)(?:[-_.]|$)/i.test(scope.ebaySellerId)) {
            issues.push('config.scope.ebaySellerId must be an exact real account identifier');
        }
        const expectedEnvironment = lane === 'production-shadow' ? 'production' : 'sandbox';
        if (scope.ebayEnvironment !== expectedEnvironment) {
            issues.push('config scope environment does not match the selected lane');
        }
    }
    if (issues.length > 0 || !schemaVersion || !project || !lane || !mode || !databasePath || !scope || !safety) {
        throw new MigrationAdminConfigError(issues.length > 0 ? issues : ['configuration is incomplete']);
    }
    return {
        schemaVersion,
        project,
        lane,
        mode,
        databasePath,
        scope,
        safety,
    };
}
function insideRoot(root, candidate) {
    const relative = path.relative(root, candidate);
    return relative === ''
        || (relative !== '..'
            && !relative.startsWith(`..${path.sep}`)
            && !path.isAbsolute(relative));
}
function exactAbsoluteInsideRoot(root, requested, label) {
    if (typeof requested !== 'string'
        || requested.length === 0
        || requested.includes('\u0000')
        || requested.startsWith('file:')
        || requested === ':memory:') {
        throw new MigrationAdminConfigError([`${label} is invalid`]);
    }
    const candidate = path.isAbsolute(requested)
        ? path.normalize(requested)
        : path.resolve(root, requested);
    if ((path.isAbsolute(requested) && candidate !== requested)
        || (!path.isAbsolute(requested) && path.normalize(requested) !== requested)) {
        throw new MigrationAdminConfigError([`${label} must use an exact normalized path`]);
    }
    if (!insideRoot(root, candidate)) {
        throw new MigrationAdminConfigError([`${label} must remain inside the repository`]);
    }
    return candidate;
}
function assertNoSymlinkComponents(root, target, label) {
    const relative = path.relative(root, target);
    if (!insideRoot(root, target)) {
        throw new MigrationAdminConfigError([`${label} must remain inside the repository`]);
    }
    let current = root;
    for (const component of relative.split(path.sep).filter(Boolean)) {
        current = path.join(current, component);
        let stat;
        try {
            stat = fs.lstatSync(current);
        }
        catch {
            throw new MigrationAdminConfigError([`${label} parent is missing`]);
        }
        if (stat.isSymbolicLink()) {
            throw new MigrationAdminConfigError([`${label} may not traverse a symbolic link`]);
        }
    }
}
function assertNoSymlinkComponentsIfPresent(root, target, label) {
    const relative = path.relative(root, target);
    if (!insideRoot(root, target)) {
        throw new MigrationAdminConfigError([`${label} must remain inside the repository`]);
    }
    let current = root;
    for (const component of relative.split(path.sep).filter(Boolean)) {
        current = path.join(current, component);
        let stat;
        try {
            stat = fs.lstatSync(current);
        }
        catch (error) {
            if (error.code === 'ENOENT')
                return;
            throw new MigrationAdminConfigError([`${label} could not be inspected safely`]);
        }
        if (stat.isSymbolicLink()) {
            throw new MigrationAdminConfigError([`${label} may not traverse a symbolic link`]);
        }
    }
}
function assertMigrationDirectoryPermissions(repositoryRoot, allowMissing) {
    for (const directory of [
        repositoryRoot,
        path.join(repositoryRoot, '.local'),
        path.join(repositoryRoot, '.local', 'migration-state'),
    ]) {
        let stat;
        try {
            stat = fs.lstatSync(directory);
        }
        catch (error) {
            if (allowMissing && error.code === 'ENOENT')
                return;
            throw new MigrationAdminConfigError(['migration database parent is missing']);
        }
        if (!stat.isDirectory() || stat.isSymbolicLink()) {
            throw new MigrationAdminConfigError([
                'migration database parent must use regular directories',
            ]);
        }
        if ((stat.mode & 0o022) !== 0) {
            throw new MigrationAdminConfigError([
                'migration database parent directories must not be group/world writable',
            ]);
        }
    }
}
export function validateMigrationRepositoryRoot(repoRoot) {
    let resolvedRoot;
    try {
        resolvedRoot = fs.realpathSync(path.resolve(repoRoot));
    }
    catch {
        throw new MigrationAdminConfigError(['repository root does not exist']);
    }
    let packageValue;
    try {
        packageValue = JSON.parse(fs.readFileSync(path.join(resolvedRoot, 'package.json'), 'utf8'));
    }
    catch {
        throw new MigrationAdminConfigError(['repository root package metadata is unavailable']);
    }
    if (!isRecord(packageValue) || packageValue.name !== 'product-pipeline') {
        throw new MigrationAdminConfigError(['repository root is not the product-pipeline package']);
    }
    try {
        const gitStat = fs.lstatSync(path.join(resolvedRoot, '.git'));
        if (!gitStat.isDirectory() && !gitStat.isFile())
            throw new Error('invalid git marker');
    }
    catch {
        throw new MigrationAdminConfigError(['repository root is not a Git checkout']);
    }
    return resolvedRoot;
}
function readConfigFile(repositoryRoot, requestedConfigPath) {
    const candidate = exactAbsoluteInsideRoot(repositoryRoot, requestedConfigPath, 'configuration path');
    assertNoSymlinkComponents(repositoryRoot, path.dirname(candidate), 'configuration path');
    let before;
    try {
        before = fs.lstatSync(candidate);
    }
    catch {
        throw new MigrationAdminConfigError(['configuration file is unavailable']);
    }
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) {
        throw new MigrationAdminConfigError([
            'configuration file must be a regular, non-symlink, non-hard-linked file',
        ]);
    }
    if (before.size > MAX_CONFIG_BYTES) {
        throw new MigrationAdminConfigError(['configuration file exceeds the 32 KiB limit']);
    }
    const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);
    let descriptor = null;
    try {
        descriptor = fs.openSync(candidate, flags);
        const opened = fs.fstatSync(descriptor);
        if (!opened.isFile()
            || opened.nlink !== 1
            || opened.dev !== before.dev
            || opened.ino !== before.ino
            || opened.size > MAX_CONFIG_BYTES) {
            throw new MigrationAdminConfigError(['configuration file changed during validation']);
        }
        const buffer = Buffer.alloc(MAX_CONFIG_BYTES + 1);
        let total = 0;
        while (total < buffer.length) {
            const bytesRead = fs.readSync(descriptor, buffer, total, buffer.length - total, total);
            if (bytesRead === 0)
                break;
            total += bytesRead;
        }
        if (total > MAX_CONFIG_BYTES) {
            throw new MigrationAdminConfigError(['configuration file exceeds the 32 KiB limit']);
        }
        const text = buffer.subarray(0, total).toString('utf8');
        let value;
        try {
            value = JSON.parse(text);
        }
        catch {
            throw new MigrationAdminConfigError(['configuration file is not valid JSON']);
        }
        return { absolutePath: candidate, value };
    }
    catch (error) {
        if (error instanceof MigrationAdminConfigError)
            throw error;
        throw new MigrationAdminConfigError(['configuration file could not be read safely']);
    }
    finally {
        if (descriptor !== null)
            fs.closeSync(descriptor);
    }
}
export function loadMigrationAdminConfig(input) {
    const repositoryRoot = validateMigrationRepositoryRoot(input.repoRoot);
    const loaded = readConfigFile(repositoryRoot, input.requestedConfigPath);
    const config = parseMigrationAdminConfig(loaded.value);
    const databaseAbsolutePath = path.resolve(repositoryRoot, ...MIGRATION_DATABASE_RELATIVE_PATH.split('/'));
    if (!insideRoot(repositoryRoot, databaseAbsolutePath)) {
        throw new MigrationAdminConfigError(['migration database path escaped the repository']);
    }
    assertNoSymlinkComponentsIfPresent(repositoryRoot, path.dirname(databaseAbsolutePath), 'migration database path');
    assertMigrationDirectoryPermissions(repositoryRoot, true);
    try {
        const databaseStat = fs.lstatSync(databaseAbsolutePath);
        if (!databaseStat.isFile() || databaseStat.isSymbolicLink() || databaseStat.nlink !== 1) {
            throw new MigrationAdminConfigError([
                'migration database must be a regular, non-symlink, non-hard-linked file',
            ]);
        }
    }
    catch (error) {
        if (error instanceof MigrationAdminConfigError)
            throw error;
        if (error.code !== 'ENOENT') {
            throw new MigrationAdminConfigError(['migration database path could not be inspected safely']);
        }
    }
    for (const sidecarPath of [
        `${databaseAbsolutePath}-journal`,
        `${databaseAbsolutePath}-wal`,
        `${databaseAbsolutePath}-shm`,
    ]) {
        try {
            fs.lstatSync(sidecarPath);
            throw new MigrationAdminConfigError([
                'migration database has an unexpected journal or shared-memory sidecar',
            ]);
        }
        catch (error) {
            if (error instanceof MigrationAdminConfigError)
                throw error;
            if (error.code !== 'ENOENT') {
                throw new MigrationAdminConfigError([
                    'migration database sidecars could not be inspected safely',
                ]);
            }
        }
    }
    return {
        config,
        repositoryRoot,
        configAbsolutePath: loaded.absolutePath,
        databaseAbsolutePath,
        scopeDigest: deriveScopeKey(config.scope),
        configDigest: sha256Digest(config),
    };
}
export function assertMigrationDatabaseParentForInit(loaded) {
    const expectedParent = path.join(loaded.repositoryRoot, '.local', 'migration-state');
    if (path.dirname(loaded.databaseAbsolutePath) !== expectedParent) {
        throw new MigrationAdminConfigError(['migration database path is outside its fixed directory']);
    }
    assertNoSymlinkComponents(loaded.repositoryRoot, expectedParent, 'migration database path');
    assertMigrationDirectoryPermissions(loaded.repositoryRoot, false);
    for (const candidate of [
        loaded.databaseAbsolutePath,
        `${loaded.databaseAbsolutePath}-journal`,
        `${loaded.databaseAbsolutePath}-wal`,
        `${loaded.databaseAbsolutePath}-shm`,
    ]) {
        let entryExists = false;
        try {
            fs.lstatSync(candidate);
            entryExists = true;
        }
        catch (error) {
            if (error.code !== 'ENOENT') {
                throw new MigrationAdminConfigError(['migration database target could not be inspected safely']);
            }
        }
        if (entryExists) {
            throw new MigrationAdminConfigError(['migration database target already exists']);
        }
    }
}
export function assertMigrationDatabaseTargetAbsent(loaded) {
    try {
        fs.lstatSync(loaded.databaseAbsolutePath);
        throw new MigrationAdminConfigError(['migration database target already exists']);
    }
    catch (error) {
        if (error instanceof MigrationAdminConfigError)
            throw error;
        if (error.code !== 'ENOENT') {
            throw new MigrationAdminConfigError([
                'migration database target could not be inspected safely',
            ]);
        }
    }
}
export function requireCanonicalCreationTime(value, now = Date.now()) {
    if (typeof value !== 'string') {
        throw new MigrationAdminConfigError(['created-at must be a canonical UTC instant']);
    }
    const epochMs = Date.parse(value);
    if (!Number.isSafeInteger(epochMs) || new Date(epochMs).toISOString() !== value || epochMs > now) {
        throw new MigrationAdminConfigError([
            'created-at must be a canonical UTC instant that is not in the future',
        ]);
    }
    return value;
}
