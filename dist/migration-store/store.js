import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { CURRENT_SCHEMA_VERSION, initializeSchema, upgradeSchemaToCurrent, verifiedStoredSchemaVersion, verifySchema, } from './schema.js';
import { INTENT_ACTIONS, INTENT_ACTION_RESPONSIBILITY, MIGRATION_RESPONSIBILITIES, WRITER_RESPONSIBILITIES, } from './types.js';
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const GENESIS_HASH = 'GENESIS';
const MAX_APPROVAL_TTL_MS = 15 * 60 * 1000;
export class MigrationStoreError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.name = 'MigrationStoreError';
        this.code = code;
    }
}
function stableJson(value) {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') {
        return JSON.stringify(value);
    }
    if (typeof value === 'number') {
        if (!Number.isFinite(value))
            throw new MigrationStoreError('INVALID_INPUT', 'Non-finite number');
        return JSON.stringify(value);
    }
    if (Array.isArray(value))
        return `[${value.map(stableJson).join(',')}]`;
    if (typeof value === 'object') {
        const entries = Object.entries(value)
            .filter(([, entry]) => entry !== undefined)
            .sort(([left], [right]) => left.localeCompare(right));
        return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`).join(',')}}`;
    }
    throw new MigrationStoreError('INVALID_INPUT', 'Unsupported value in canonical payload');
}
export function sha256Digest(value) {
    const input = typeof value === 'string' ? value : stableJson(value);
    return `sha256:${createHash('sha256').update(input, 'utf8').digest('hex')}`;
}
function assertDigest(value, name) {
    if (!DIGEST_PATTERN.test(value)) {
        throw new MigrationStoreError('INVALID_INPUT', `${name} must be a sha256 digest`);
    }
    return value;
}
function safeText(value, name, maximumLength = 256) {
    if (typeof value !== 'string' ||
        value.length === 0 ||
        value.length > maximumLength ||
        value.trim() !== value ||
        /[\u0000-\u001f\u007f]/.test(value)) {
        throw new MigrationStoreError('INVALID_INPUT', `${name} is invalid`);
    }
    return value;
}
function identifier(value, name) {
    const checked = safeText(value, name, 160);
    if (!/^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/.test(checked)) {
        throw new MigrationStoreError('INVALID_INPUT', `${name} contains unsupported characters`);
    }
    return checked;
}
function timestamp(value, name) {
    if (typeof value !== 'string') {
        throw new MigrationStoreError('INVALID_INPUT', `${name} must be a canonical UTC instant`);
    }
    const epochMs = Date.parse(value);
    if (!Number.isSafeInteger(epochMs) || new Date(epochMs).toISOString() !== value) {
        throw new MigrationStoreError('INVALID_INPUT', `${name} must be a canonical UTC instant`);
    }
    return { utc: value, epochMs };
}
function canonicalScope(input) {
    const shopifyStoreDomain = safeText(input.shopifyStoreDomain.toLowerCase(), 'shopifyStoreDomain');
    if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shopifyStoreDomain)) {
        throw new MigrationStoreError('INVALID_INPUT', 'shopifyStoreDomain must be the canonical myshopify.com host');
    }
    if (!['sandbox', 'production'].includes(input.ebayEnvironment)) {
        throw new MigrationStoreError('INVALID_INPUT', 'ebayEnvironment is invalid');
    }
    const ebaySellerId = safeText(input.ebaySellerId, 'ebaySellerId');
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(ebaySellerId)) {
        throw new MigrationStoreError('INVALID_INPUT', 'ebaySellerId is invalid');
    }
    const ebayMarketplaceId = safeText(input.ebayMarketplaceId.toUpperCase(), 'ebayMarketplaceId');
    if (ebayMarketplaceId !== 'EBAY_US') {
        throw new MigrationStoreError('INVALID_INPUT', 'Only the explicit EBAY_US marketplace is supported');
    }
    return {
        shopifyStoreDomain,
        ebayEnvironment: input.ebayEnvironment,
        ebaySellerId,
        ebayMarketplaceId,
    };
}
export function deriveScopeKey(input) {
    const scope = canonicalScope(input);
    return sha256Digest({ schemaVersion: 1, type: 'integration_scope', ...scope });
}
function normalizeExactPath(databasePath, mustExist) {
    if (typeof databasePath !== 'string' ||
        databasePath.length === 0 ||
        databasePath.includes('\u0000') ||
        databasePath.startsWith('file:') ||
        databasePath === ':memory:' ||
        !path.isAbsolute(databasePath) ||
        path.resolve(databasePath) !== databasePath) {
        throw new MigrationStoreError('PATH_REJECTED', 'Migration store path must be an exact normalized absolute filesystem path');
    }
    const parent = path.dirname(databasePath);
    if (!fs.existsSync(parent) || !fs.statSync(parent).isDirectory()) {
        throw new MigrationStoreError('PATH_REJECTED', 'Migration store parent directory is missing');
    }
    if (mustExist) {
        if (!fs.existsSync(databasePath)) {
            throw new MigrationStoreError('PATH_REJECTED', 'Migration store file does not exist');
        }
        const stat = fs.lstatSync(databasePath);
        if (!stat.isFile() || stat.isSymbolicLink()) {
            throw new MigrationStoreError('PATH_REJECTED', 'Migration store path is not a regular file');
        }
        if (stat.nlink !== 1) {
            throw new MigrationStoreError('PATH_REJECTED', 'Migration store must not be hard-linked');
        }
        if ((stat.mode & 0o777) !== 0o600) {
            throw new MigrationStoreError('PATH_REJECTED', 'Migration store permissions must be exactly 0600');
        }
        const descriptor = fs.openSync(databasePath, 'r');
        try {
            const header = Buffer.alloc(20);
            if (fs.readSync(descriptor, header, 0, header.length, 0) === header.length) {
                const sqliteMagic = header.subarray(0, 16).toString('utf8') === 'SQLite format 3\u0000';
                if (sqliteMagic && (header[18] !== 1 || header[19] !== 1)) {
                    throw new MigrationStoreError('PATH_REJECTED', 'Migration store must use rollback journaling before any SQLite open');
                }
            }
        }
        finally {
            fs.closeSync(descriptor);
        }
    }
    else if (fs.existsSync(databasePath)) {
        throw new MigrationStoreError('PATH_REJECTED', 'Refusing to replace an existing migration store');
    }
    return databasePath;
}
function configureWritable(database) {
    database.pragma('foreign_keys = ON');
    database.pragma('recursive_triggers = ON');
    database.pragma('busy_timeout = 5000');
    const journalMode = database.pragma('journal_mode = DELETE', { simple: true });
    if (String(journalMode).toLowerCase() !== 'delete') {
        throw new Error('DELETE journal mode could not be enforced');
    }
    database.pragma('synchronous = FULL');
    if (database.pragma('foreign_keys', { simple: true }) !== 1) {
        throw new Error('SQLite foreign keys could not be enforced');
    }
    if (database.pragma('recursive_triggers', { simple: true }) !== 1) {
        throw new Error('SQLite recursive triggers could not be enforced');
    }
}
function configureReadOnly(database) {
    database.pragma('busy_timeout = 5000');
    database.pragma('foreign_keys = ON');
    database.pragma('query_only = ON');
    if (database.pragma('query_only', { simple: true }) !== 1) {
        throw new Error('SQLite query_only could not be enforced');
    }
}
function readScope(database) {
    const row = database
        .prepare(`SELECT scope_key, shopify_store_domain, ebay_environment,
        ebay_seller_id, ebay_marketplace_id
       FROM integration_scope WHERE singleton = 1`)
        .get();
    if (!row)
        throw new Error('Migration store has no integration scope');
    return {
        scopeKey: assertDigest(row.scope_key, 'stored scope key'),
        shopifyStoreDomain: row.shopify_store_domain,
        ebayEnvironment: row.ebay_environment,
        ebaySellerId: row.ebay_seller_id,
        ebayMarketplaceId: row.ebay_marketplace_id,
    };
}
function verifyExpectedScope(database, input) {
    const expected = canonicalScope(input);
    const expectedKey = deriveScopeKey(expected);
    const actual = readScope(database);
    if (actual.scopeKey !== expectedKey ||
        actual.shopifyStoreDomain !== expected.shopifyStoreDomain ||
        actual.ebayEnvironment !== expected.ebayEnvironment ||
        actual.ebaySellerId !== expected.ebaySellerId ||
        actual.ebayMarketplaceId !== expected.ebayMarketplaceId) {
        throw new MigrationStoreError('ACCOUNT_DRIFT', 'Migration store belongs to a different Shopify/eBay account scope');
    }
    return actual;
}
function translateOpenError(error) {
    if (error instanceof MigrationStoreError)
        throw error;
    throw new MigrationStoreError('SCHEMA_MISMATCH', error instanceof Error ? error.message : 'Migration store verification failed');
}
export function createMigrationStore(input) {
    const databasePath = normalizeExactPath(input.databasePath, false);
    const scope = canonicalScope(input.scope);
    const scopeKey = deriveScopeKey(scope);
    const created = timestamp(input.createdAtUtc, 'createdAtUtc');
    const temporaryPath = path.join(path.dirname(databasePath), `.${path.basename(databasePath)}.${randomUUID()}.creating`);
    const temporarySidecars = [
        `${temporaryPath}-journal`,
        `${temporaryPath}-wal`,
        `${temporaryPath}-shm`,
    ];
    const finalSidecars = [`${databasePath}-journal`, `${databasePath}-wal`, `${databasePath}-shm`];
    let database = null;
    let published = false;
    try {
        const writableDatabase = new Database(temporaryPath);
        database = writableDatabase;
        fs.chmodSync(temporaryPath, 0o600);
        configureWritable(writableDatabase);
        initializeSchema(writableDatabase, created.utc);
        const establishScope = writableDatabase.transaction(() => {
            writableDatabase
                .prepare(`INSERT INTO integration_scope (
            singleton, scope_key, shopify_store_domain, ebay_environment,
            ebay_seller_id, ebay_marketplace_id, created_at_utc, created_epoch_ms
          ) VALUES (1, ?, ?, ?, ?, ?, ?, ?)`)
                .run(scopeKey, scope.shopifyStoreDomain, scope.ebayEnvironment, scope.ebaySellerId, scope.ebayMarketplaceId, created.utc, created.epochMs);
            appendAuditRow(writableDatabase, scopeKey, {
                eventId: `scope:${scopeKey}`,
                occurredAtUtc: created.utc,
            }, 'scope.established', { scopeKey });
        });
        establishScope.immediate();
        verifySchema(writableDatabase);
        verifyDatabaseIntegrity(writableDatabase, scopeKey);
        writableDatabase.close();
        database = null;
        fs.chmodSync(temporaryPath, 0o600);
        // A hard-link publication is atomic and fails if a competing file appeared;
        // unlike rename, it can never replace that file. The temporary name is in
        // the same directory, so cross-device publication is impossible.
        fs.linkSync(temporaryPath, databasePath);
        published = true;
        fs.unlinkSync(temporaryPath);
        fs.chmodSync(databasePath, 0o600);
        for (const sidecar of temporarySidecars) {
            if (fs.existsSync(sidecar))
                fs.unlinkSync(sidecar);
        }
        return openMigrationStore({ databasePath, expectedScope: scope });
    }
    catch (error) {
        if (database?.open)
            database.close();
        for (const candidate of [temporaryPath, ...temporarySidecars]) {
            if (fs.existsSync(candidate))
                fs.unlinkSync(candidate);
        }
        if (published) {
            for (const candidate of [databasePath, ...finalSidecars]) {
                if (fs.existsSync(candidate))
                    fs.unlinkSync(candidate);
            }
        }
        translateOpenError(error);
    }
}
export function openMigrationStore(input) {
    const databasePath = normalizeExactPath(input.databasePath, true);
    // Verify the application marker, complete schema catalog, and account scope
    // through a query-only handle before any persistent journal pragma can touch
    // the file. A legacy ProductPipeline DB therefore fails without mutation.
    const preflight = new Database(databasePath, { readonly: true, fileMustExist: true });
    try {
        configureReadOnly(preflight);
        verifySchema(preflight);
        const scope = verifyExpectedScope(preflight, input.expectedScope);
        verifyDatabaseIntegrity(preflight, scope.scopeKey);
    }
    catch (error) {
        preflight.close();
        translateOpenError(error);
    }
    preflight.close();
    const database = new Database(databasePath, { fileMustExist: true });
    try {
        database.pragma('foreign_keys = ON');
        database.pragma('recursive_triggers = ON');
        database.pragma('busy_timeout = 5000');
        verifySchema(database);
        const scope = verifyExpectedScope(database, input.expectedScope);
        verifyDatabaseIntegrity(database, scope.scopeKey);
        configureWritable(database);
        return new MigrationStoreImpl(database, databasePath, scope, true);
    }
    catch (error) {
        database.close();
        translateOpenError(error);
    }
}
/**
 * Explicit operator-run schema upgrade. Runtime code never calls this: a
 * store at an older verified schema version fails every ordinary open until
 * an operator deliberately upgrades it. The stored version is only trusted
 * after its complete migration history and catalog digest verify, and the
 * pending migrations apply inside one immediate transaction followed by a
 * full current-version verification.
 */
export function upgradeMigrationStore(input) {
    const databasePath = normalizeExactPath(input.databasePath, true);
    const applied = timestamp(input.appliedAtUtc, 'appliedAtUtc');
    const preflight = new Database(databasePath, { readonly: true, fileMustExist: true });
    try {
        configureReadOnly(preflight);
        const storedVersion = verifiedStoredSchemaVersion(preflight);
        const scope = verifyExpectedScope(preflight, input.expectedScope);
        verifyDatabaseIntegrity(preflight, scope.scopeKey);
        if (storedVersion === CURRENT_SCHEMA_VERSION) {
            return { fromVersion: storedVersion, toVersion: CURRENT_SCHEMA_VERSION };
        }
    }
    catch (error) {
        preflight.close();
        translateOpenError(error);
    }
    preflight.close();
    const database = new Database(databasePath, { fileMustExist: true });
    try {
        configureWritable(database);
        const scope = verifyExpectedScope(database, input.expectedScope);
        const result = upgradeSchemaToCurrent(database, applied.utc);
        verifySchema(database);
        verifyDatabaseIntegrity(database, scope.scopeKey);
        database.close();
        return result;
    }
    catch (error) {
        database.close();
        translateOpenError(error);
    }
}
export function openMigrationStoreReadOnly(input) {
    const databasePath = normalizeExactPath(input.databasePath, true);
    const database = new Database(databasePath, { readonly: true, fileMustExist: true });
    try {
        configureReadOnly(database);
        verifySchema(database);
        const scope = verifyExpectedScope(database, input.expectedScope);
        verifyDatabaseIntegrity(database, scope.scopeKey);
        return new MigrationStoreImpl(database, databasePath, scope, false);
    }
    catch (error) {
        database.close();
        translateOpenError(error);
    }
}
function appendAuditRow(database, scopeKey, context, eventType, payload) {
    const eventId = identifier(context.eventId, 'audit eventId');
    const occurred = timestamp(context.occurredAtUtc, 'audit occurredAtUtc');
    const previous = database
        .prepare('SELECT sequence, event_hash, occurred_epoch_ms FROM audit_events ORDER BY sequence DESC LIMIT 1')
        .get();
    if (previous && occurred.epochMs < previous.occurred_epoch_ms) {
        throw new MigrationStoreError('CONFLICT', 'Audit event time cannot move backward');
    }
    const sequence = (previous?.sequence ?? 0) + 1;
    const previousHash = previous?.event_hash ?? GENESIS_HASH;
    const payloadDigest = sha256Digest(payload);
    const eventHash = sha256Digest({
        schemaVersion: 1,
        sequence,
        scopeKey,
        eventId,
        eventType,
        occurredAtUtc: occurred.utc,
        payloadDigest,
        previousHash,
    });
    database
        .prepare(`INSERT INTO audit_events (
        sequence, scope_key, event_id, event_type, occurred_at_utc, occurred_epoch_ms,
        payload_digest, previous_hash, event_hash
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(sequence, scopeKey, eventId, eventType, occurred.utc, occurred.epochMs, payloadDigest, previousHash, eventHash);
    return eventHash;
}
function verifyAuditRows(database, scopeKey) {
    const rows = database
        .prepare(`SELECT sequence, scope_key, event_id, event_type, occurred_at_utc,
        payload_digest, previous_hash, event_hash
       FROM audit_events ORDER BY sequence`)
        .all();
    if (rows.length === 0) {
        return {
            valid: false,
            recordCount: 0,
            headHash: null,
            error: 'Audit chain failed: required scope genesis event is missing',
        };
    }
    const storedScope = database
        .prepare('SELECT created_at_utc FROM integration_scope WHERE scope_key = ? AND singleton = 1')
        .get(scopeKey);
    const genesis = rows[0];
    if (!storedScope
        || genesis.sequence !== 1
        || genesis.event_id !== `scope:${scopeKey}`
        || genesis.event_type !== 'scope.established'
        || genesis.occurred_at_utc !== storedScope.created_at_utc
        || genesis.payload_digest !== sha256Digest({ scopeKey })
        || genesis.previous_hash !== GENESIS_HASH) {
        return {
            valid: false,
            recordCount: 0,
            headHash: null,
            error: 'Audit chain failed: scope genesis event is invalid',
        };
    }
    let previousHash = GENESIS_HASH;
    for (let index = 0; index < rows.length; index += 1) {
        const row = rows[index];
        const expectedSequence = index + 1;
        const expectedHash = sha256Digest({
            schemaVersion: 1,
            sequence: row.sequence,
            scopeKey: row.scope_key,
            eventId: row.event_id,
            eventType: row.event_type,
            occurredAtUtc: row.occurred_at_utc,
            payloadDigest: row.payload_digest,
            previousHash: row.previous_hash,
        });
        if (row.sequence !== expectedSequence
            || row.scope_key !== scopeKey
            || !DIGEST_PATTERN.test(row.payload_digest)
            || row.previous_hash !== previousHash
            || row.event_hash !== expectedHash) {
            return {
                valid: false,
                recordCount: index,
                headHash: index === 0 ? null : previousHash,
                error: `Audit chain failed at sequence ${expectedSequence}`,
            };
        }
        previousHash = row.event_hash;
    }
    return {
        valid: true,
        recordCount: rows.length,
        headHash: rows.length === 0 ? null : previousHash,
    };
}
function verifyDatabaseIntegrity(database, scopeKey) {
    if (database.pragma('quick_check', { simple: true }) !== 'ok') {
        throw new Error('Migration store SQLite quick_check failed');
    }
    const foreignKeyProblems = database.pragma('foreign_key_check');
    if (foreignKeyProblems.length !== 0) {
        throw new Error('Migration store foreign-key integrity failed');
    }
    const audit = verifyAuditRows(database, scopeKey);
    if (!audit.valid)
        throw new Error(audit.error ?? 'Migration store audit chain failed');
}
function identityMaterial(input) {
    if (input.platform === 'shopify') {
        return {
            schemaVersion: 1,
            platform: 'shopify',
            storeDomain: input.storeDomain.toLowerCase(),
            resourceKind: input.kind,
            externalId: input.externalGid,
        };
    }
    return {
        schemaVersion: 1,
        platform: 'ebay',
        environment: input.environment,
        sellerId: input.sellerId,
        marketplaceId: input.marketplaceId.toUpperCase(),
        resourceKind: input.kind,
        externalId: input.externalId,
    };
}
export function deriveExternalIdentityKey(input) {
    return sha256Digest(identityMaterial(input));
}
export function deriveIdempotencyKey(input) {
    const scopeKey = assertDigest(input.scopeKey, 'scopeKey');
    const sourceIdentityKey = assertDigest(input.sourceIdentityKey, 'sourceIdentityKey');
    if (!INTENT_ACTIONS.includes(input.action)) {
        throw new MigrationStoreError('INVALID_INPUT', 'action is invalid');
    }
    // The source eBay order is the forever-unique identity of an order-create
    // intent. Ownership, approval, attempt, payload, and time must never make a
    // second Shopify create appear to be a different action.
    if (input.action === 'import_shopify_order') {
        return sha256Digest({
            schemaVersion: 1,
            scopeKey,
            action: input.action,
            sourceIdentityKey,
        });
    }
    const targetIdentityKey = assertDigest(input.targetIdentityKey ?? '', 'targetIdentityKey');
    const desiredStateDigest = assertDigest(input.desiredStateDigest, 'desiredStateDigest');
    return sha256Digest({
        schemaVersion: 1,
        scopeKey,
        action: input.action,
        sourceIdentityKey,
        targetIdentityKey,
        desiredStateDigest,
    });
}
function currentJobState(database, jobId) {
    const row = database
        .prepare(`SELECT sequence, to_state AS state, occurred_epoch_ms AS occurredEpochMs
       FROM job_events WHERE job_id = ? ORDER BY sequence DESC LIMIT 1`)
        .get(jobId);
    if (!row)
        throw new MigrationStoreError('NOT_FOUND', 'Execution job has no state');
    return row;
}
class MigrationStoreImpl {
    database;
    databasePath;
    scope;
    scopeKey;
    writable;
    externallyWired = false;
    externalWritesSupported = false;
    closed = false;
    constructor(database, databasePath, scope, writable) {
        this.database = database;
        this.databasePath = databasePath;
        this.scope = {
            shopifyStoreDomain: scope.shopifyStoreDomain,
            ebayEnvironment: scope.ebayEnvironment,
            ebaySellerId: scope.ebaySellerId,
            ebayMarketplaceId: scope.ebayMarketplaceId,
        };
        this.scopeKey = scope.scopeKey;
        this.writable = writable;
    }
    close() {
        if (!this.closed) {
            this.database.close();
            this.closed = true;
        }
    }
    assertOpen() {
        if (this.closed)
            throw new MigrationStoreError('READ_ONLY', 'Migration store is closed');
    }
    immediate(operation, callback) {
        this.assertOpen();
        if (!this.writable) {
            throw new MigrationStoreError('READ_ONLY', 'Migration store was opened read-only');
        }
        try {
            return this.database.transaction(callback).immediate();
        }
        catch (error) {
            if (error instanceof MigrationStoreError)
                throw error;
            throw new MigrationStoreError('CONFLICT', `${operation} was rejected by durable constraints`);
        }
    }
    registerIdentity(input, audit) {
        const created = timestamp(audit.occurredAtUtc, 'identity createdAtUtc');
        const bindingKey = identifier(input.bindingKey, 'bindingKey');
        let externalId;
        let platform;
        let resourceKind;
        let shopifyStoreDomain = null;
        let ebayEnvironment = null;
        let ebaySellerId = null;
        let ebayMarketplaceId = null;
        if (input.platform === 'shopify') {
            this.assertShopifyScope(input);
            externalId = this.validateShopifyGid(input);
            platform = 'shopify';
            resourceKind = input.kind;
            shopifyStoreDomain = input.storeDomain.toLowerCase();
        }
        else {
            this.assertEbayScope(input);
            externalId = safeText(input.externalId, 'externalId', 512);
            platform = 'ebay';
            resourceKind = input.kind;
            ebayEnvironment = input.environment;
            ebaySellerId = input.sellerId;
            ebayMarketplaceId = input.marketplaceId.toUpperCase();
        }
        const normalizedInput = input.platform === 'shopify'
            ? { ...input, storeDomain: input.storeDomain.toLowerCase(), externalGid: externalId }
            : { ...input, marketplaceId: input.marketplaceId.toUpperCase(), externalId };
        const identityKey = deriveExternalIdentityKey(normalizedInput);
        this.immediate('identity registration', () => {
            this.database
                .prepare(`INSERT INTO external_identities (
            identity_key, scope_key, platform, resource_kind, binding_key, external_id,
            shopify_store_domain, ebay_environment, ebay_seller_id, ebay_marketplace_id,
            created_at_utc, created_epoch_ms
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
                .run(identityKey, this.scopeKey, platform, resourceKind, bindingKey, externalId, shopifyStoreDomain, ebayEnvironment, ebaySellerId, ebayMarketplaceId, created.utc, created.epochMs);
            appendAuditRow(this.database, this.scopeKey, audit, 'identity.registered', {
                identityKey,
                platform,
                resourceKind,
            });
        });
        return {
            identityKey,
            scopeKey: this.scopeKey,
            platform,
            resourceKind: resourceKind,
            bindingKey,
            externalId,
            createdAtUtc: created.utc,
        };
    }
    getIdentity(identityKey) {
        this.assertOpen();
        const key = assertDigest(identityKey, 'identityKey');
        const row = this.database
            .prepare(`SELECT identity_key, scope_key, platform, resource_kind, binding_key,
          external_id, created_at_utc FROM external_identities
         WHERE identity_key = ? AND scope_key = ?`)
            .get(key, this.scopeKey);
        return row
            ? {
                identityKey: row.identity_key,
                scopeKey: row.scope_key,
                platform: row.platform,
                resourceKind: row.resource_kind,
                bindingKey: row.binding_key,
                externalId: row.external_id,
                createdAtUtc: row.created_at_utc,
            }
            : null;
    }
    establishOrderWatermark(input) {
        if (this.scope.ebayEnvironment === 'production') {
            throw new MigrationStoreError('OWNERSHIP_DENIED', 'Production watermark establishment is disabled in this unwired foundation');
        }
        const boundary = timestamp(input.boundaryExclusiveUtc, 'boundaryExclusiveUtc');
        const created = timestamp(input.createdAtUtc, 'createdAtUtc');
        if (boundary.epochMs > created.epochMs) {
            throw new MigrationStoreError('INVALID_INPUT', 'Order watermark cannot be in the future');
        }
        if (input.audit.occurredAtUtc !== input.createdAtUtc) {
            throw new MigrationStoreError('INVALID_INPUT', 'Watermark audit time must equal creation time');
        }
        const ownershipEvidenceDigest = assertDigest(input.ownershipEvidenceDigest, 'ownershipEvidenceDigest');
        const acceptedEvidenceDigest = assertDigest(input.acceptedEvidenceDigest, 'acceptedEvidenceDigest');
        const ownership = this.getCurrentOwnership('orderImport');
        if (!ownership
            || ownership.version !== input.ownershipVersion
            || ownership.owner !== 'marketplace_connect'
            || !ownership.singleWriterVerified
            || ownership.evidenceDigest !== ownershipEvidenceDigest) {
            throw new MigrationStoreError('OWNERSHIP_DENIED', 'Watermark requires the exact accepted Marketplace Connect ownership baseline');
        }
        const watermarkKey = sha256Digest({
            schemaVersion: 1,
            scopeKey: this.scopeKey,
            sourcePlatform: 'ebay',
            responsibility: 'orderImport',
            eventField: 'creationDate',
            boundaryMode: 'exclusive',
        });
        this.immediate('order watermark establishment', () => {
            this.database
                .prepare(`INSERT INTO order_watermarks (
            watermark_key, scope_key, source_platform, responsibility, event_field,
            ownership_version, ownership_evidence_digest, accepted_evidence_digest,
            boundary_mode, boundary_exclusive_utc, boundary_exclusive_epoch_ms,
            created_at_utc, created_epoch_ms
          ) VALUES (?, ?, 'ebay', 'orderImport', 'creationDate', ?, ?, ?, 'exclusive', ?, ?, ?, ?)`)
                .run(watermarkKey, this.scopeKey, input.ownershipVersion, ownershipEvidenceDigest, acceptedEvidenceDigest, boundary.utc, boundary.epochMs, created.utc, created.epochMs);
            appendAuditRow(this.database, this.scopeKey, input.audit, 'order_watermark.established', {
                watermarkKey,
                eventField: 'creationDate',
                boundaryMode: 'exclusive',
                boundaryExclusiveUtc: boundary.utc,
                ownershipVersion: input.ownershipVersion,
                ownershipEvidenceDigest,
                acceptedEvidenceDigest,
            });
        });
        return { watermarkKey, eventField: 'creationDate', boundaryExclusiveUtc: boundary.utc };
    }
    getOrderWatermark() {
        this.assertOpen();
        const row = this.database
            .prepare(`SELECT event_field, boundary_mode, boundary_exclusive_utc, boundary_exclusive_epoch_ms
         FROM order_watermarks WHERE scope_key = ?`)
            .get(this.scopeKey);
        return row
            ? {
                eventField: row.event_field,
                boundaryMode: row.boundary_mode,
                boundaryExclusiveUtc: row.boundary_exclusive_utc,
                boundaryExclusiveEpochMs: row.boundary_exclusive_epoch_ms,
            }
            : null;
    }
    isOrderEligible(sourceCreationDateUtc) {
        const source = timestamp(sourceCreationDateUtc, 'source creationDate');
        const watermark = this.getOrderWatermark();
        if (!watermark) {
            throw new MigrationStoreError('WATERMARK_REQUIRED', 'Order handling is disabled until an immutable watermark exists');
        }
        return source.epochMs > watermark.boundaryExclusiveEpochMs;
    }
    recordOwnershipVersion(input) {
        if (!MIGRATION_RESPONSIBILITIES.includes(input.responsibility)) {
            throw new MigrationStoreError('INVALID_INPUT', 'responsibility is invalid');
        }
        if (!Number.isSafeInteger(input.version) || input.version < 1) {
            throw new MigrationStoreError('INVALID_INPUT', 'ownership version is invalid');
        }
        if (!['marketplace_connect', 'paused', 'product_pipeline'].includes(input.owner)) {
            throw new MigrationStoreError('INVALID_INPUT', 'ownership owner is invalid');
        }
        if (!input.singleWriterVerified) {
            throw new MigrationStoreError('OWNERSHIP_DENIED', 'Ownership versions require verified single-writer or zero-writer evidence');
        }
        const evidenceDigest = assertDigest(input.evidenceDigest, 'evidenceDigest');
        const effective = timestamp(input.effectiveAtUtc, 'effectiveAtUtc');
        const recorded = timestamp(input.recordedAtUtc, 'recordedAtUtc');
        if (effective.epochMs > recorded.epochMs || input.audit.occurredAtUtc !== recorded.utc) {
            throw new MigrationStoreError('INVALID_INPUT', 'ownership timestamps are invalid');
        }
        const current = this.getCurrentOwnership(input.responsibility);
        if (input.version !== (current?.version ?? 0) + 1) {
            throw new MigrationStoreError('CONFLICT', 'Ownership version must advance exactly once');
        }
        // listingRevise has no verified Marketplace Connect incumbent: its truthful
        // genesis is the quarantined 'paused' state, and it may never record a
        // Marketplace Connect owner at any version.
        if (input.responsibility === 'listingRevise' && input.owner === 'marketplace_connect') {
            throw new MigrationStoreError('OWNERSHIP_DENIED', 'listingRevise has no verified Marketplace Connect owner to record');
        }
        const validGenesis = input.responsibility === 'listingRevise'
            ? input.owner === 'paused'
            : input.owner === 'marketplace_connect';
        if (!current && (input.version !== 1 || !validGenesis)) {
            throw new MigrationStoreError('OWNERSHIP_DENIED', 'The first ownership version must record the verified incumbent baseline');
        }
        if (current) {
            const transitionAllowed = (current.owner === 'marketplace_connect' && input.owner === 'paused')
                || (current.owner === 'paused'
                    && ['marketplace_connect', 'product_pipeline'].includes(input.owner))
                || (current.owner === 'product_pipeline' && input.owner === 'paused');
            if (!transitionAllowed) {
                throw new MigrationStoreError('OWNERSHIP_DENIED', 'Ownership transition is not staged safely');
            }
        }
        const productionAllowed = (input.version === 1
            && input.owner === 'marketplace_connect'
            && ['orderImport', 'price', 'inventory'].includes(input.responsibility))
            // The reviewed listing-revise slice: paused genesis plus staged
            // paused <-> product_pipeline transitions only, never Marketplace
            // Connect, and no other responsibility.
            || input.responsibility === 'listingRevise';
        if (this.scope.ebayEnvironment === 'production' && !productionAllowed) {
            throw new MigrationStoreError('OWNERSHIP_DENIED', 'Production ownership transfer is disabled in this unwired foundation');
        }
        const ownershipId = identifier(`${input.responsibility}:v${input.version}`, 'ownershipId');
        this.immediate('ownership version', () => {
            this.database
                .prepare(`INSERT INTO ownership_versions (
            ownership_id, scope_key, responsibility, version, owner, single_writer_verified,
            evidence_digest, effective_at_utc, effective_epoch_ms, recorded_at_utc, recorded_epoch_ms
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
                .run(ownershipId, this.scopeKey, input.responsibility, input.version, input.owner, input.singleWriterVerified ? 1 : 0, evidenceDigest, effective.utc, effective.epochMs, recorded.utc, recorded.epochMs);
            appendAuditRow(this.database, this.scopeKey, input.audit, 'ownership.version_recorded', {
                ownershipId,
                responsibility: input.responsibility,
                version: input.version,
                owner: input.owner,
                singleWriterVerified: input.singleWriterVerified,
                evidenceDigest,
            });
        });
        return ownershipId;
    }
    getCurrentOwnership(responsibility) {
        this.assertOpen();
        if (!MIGRATION_RESPONSIBILITIES.includes(responsibility)) {
            throw new MigrationStoreError('INVALID_INPUT', 'responsibility is invalid');
        }
        const row = this.database
            .prepare(`SELECT version, owner, single_writer_verified, evidence_digest
         FROM ownership_versions WHERE scope_key = ? AND responsibility = ?
         ORDER BY version DESC LIMIT 1`)
            .get(this.scopeKey, responsibility);
        return row
            ? {
                version: row.version,
                owner: row.owner,
                singleWriterVerified: row.single_writer_verified === 1,
                evidenceDigest: row.evidence_digest,
            }
            : null;
    }
    createIdempotencyIntent(input) {
        if (this.scope.ebayEnvironment === 'production' && input.action !== 'revise_ebay_listing') {
            throw new MigrationStoreError('OWNERSHIP_DENIED', 'Production writer intents are disabled in this unwired foundation');
        }
        if (!INTENT_ACTIONS.includes(input.action)) {
            throw new MigrationStoreError('INVALID_INPUT', 'action is invalid');
        }
        const responsibility = INTENT_ACTION_RESPONSIBILITY[input.action];
        const source = this.requireIdentity(input.sourceIdentityKey, 'source identity');
        const target = input.targetIdentityKey
            ? this.requireIdentity(input.targetIdentityKey, 'target identity')
            : null;
        const desiredStateDigest = assertDigest(input.desiredStateDigest, 'desiredStateDigest');
        const created = timestamp(input.createdAtUtc, 'createdAtUtc');
        if (input.audit.occurredAtUtc !== created.utc) {
            throw new MigrationStoreError('INVALID_INPUT', 'Intent audit time must equal creation time');
        }
        this.assertActionIdentityShape(input.action, source, target);
        const intentKey = deriveIdempotencyKey({
            scopeKey: this.scopeKey,
            action: input.action,
            sourceIdentityKey: source.identity_key,
            targetIdentityKey: target?.identity_key ?? null,
            desiredStateDigest,
        });
        const approvalTargetIdentityKey = target?.identity_key ?? source.identity_key;
        this.immediate('idempotency intent creation', () => {
            if (input.action === 'import_shopify_order') {
                const eligible = this.database
                    .prepare(`SELECT observation.observation_id
             FROM order_observations observation
             LEFT JOIN order_observation_resolutions resolution
               ON resolution.observation_id = observation.observation_id
             LEFT JOIN order_links link
               ON link.ebay_order_identity_key = observation.ebay_order_identity_key
             WHERE observation.scope_key = ?
               AND observation.ebay_order_identity_key = ?
               AND observation.eligible_after_watermark = 1
               AND resolution.observation_id IS NULL
               AND link.link_id IS NULL
             ORDER BY observation.observed_epoch_ms DESC LIMIT 1`)
                    .get(this.scopeKey, source.identity_key);
                if (!eligible) {
                    throw new MigrationStoreError('WATERMARK_REQUIRED', 'Order import intent requires an eligible unresolved post-watermark observation');
                }
            }
            this.database
                .prepare(`INSERT INTO idempotency_intents (
            intent_key, scope_key, responsibility, action, source_identity_key,
            target_identity_key, approval_target_identity_key, desired_state_digest,
            created_at_utc, created_epoch_ms
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
                .run(intentKey, this.scopeKey, responsibility, input.action, source.identity_key, target?.identity_key ?? null, approvalTargetIdentityKey, desiredStateDigest, created.utc, created.epochMs);
            appendAuditRow(this.database, this.scopeKey, input.audit, 'idempotency.intent_created', {
                intentKey,
                responsibility,
                action: input.action,
                sourceIdentityKey: source.identity_key,
                targetIdentityKey: target?.identity_key ?? null,
            });
        });
        return intentKey;
    }
    getIntent(intentKey) {
        this.assertOpen();
        const key = assertDigest(intentKey, 'intentKey');
        return (this.database
            .prepare(`SELECT intent_key, responsibility, action, source_identity_key,
            target_identity_key, approval_target_identity_key, desired_state_digest
           FROM idempotency_intents WHERE intent_key = ? AND scope_key = ?`)
            .get(key, this.scopeKey) ?? null);
    }
    getJobStatus(jobIdInput) {
        this.assertOpen();
        const jobId = identifier(jobIdInput, 'jobId');
        const row = this.database
            .prepare(`SELECT job.job_id, job.intent_key, job.responsibility, job.ownership_version,
          event.to_state AS state,
          (SELECT attempt.outcome FROM intent_attempts attempt
           WHERE attempt.job_id = job.job_id ORDER BY attempt.ordinal DESC LIMIT 1) AS attempt_outcome
         FROM execution_jobs job
         JOIN job_events event ON event.job_id = job.job_id
         WHERE job.job_id = ? AND job.scope_key = ?
           AND event.sequence = (
             SELECT MAX(latest.sequence) FROM job_events latest WHERE latest.job_id = job.job_id
           )`)
            .get(jobId, this.scopeKey);
        return row
            ? {
                jobId: row.job_id,
                intentKey: row.intent_key,
                responsibility: row.responsibility,
                ownershipVersion: row.ownership_version,
                state: row.state,
                attemptOutcome: row.attempt_outcome,
            }
            : null;
    }
    issueActionApproval(input) {
        if (!WRITER_RESPONSIBILITIES.includes(input.responsibility)) {
            throw new MigrationStoreError('INVALID_INPUT', 'Approval responsibility is not a writer');
        }
        const approvalToken = safeText(input.approvalToken, 'approvalToken', 512);
        if (approvalToken.length < 16) {
            throw new MigrationStoreError('INVALID_INPUT', 'approvalToken is too short');
        }
        const approvalDigest = sha256Digest(approvalToken);
        const intent = this.requireIntent(input.intentKey);
        const targetIdentityKey = assertDigest(input.targetIdentityKey, 'targetIdentityKey');
        if (intent.responsibility !== input.responsibility ||
            intent.approval_target_identity_key !== targetIdentityKey) {
            throw new MigrationStoreError('APPROVAL_DENIED', 'Approval responsibility or target does not match the intent');
        }
        const ownership = this.getCurrentOwnership(input.responsibility);
        if (!ownership ||
            ownership.version !== input.ownershipVersion ||
            ownership.owner !== 'product_pipeline' ||
            !ownership.singleWriterVerified) {
            throw new MigrationStoreError('OWNERSHIP_DENIED', 'Approval requires exact active ProductPipeline single-writer ownership');
        }
        const issued = timestamp(input.issuedAtUtc, 'issuedAtUtc');
        const expires = timestamp(input.expiresAtUtc, 'expiresAtUtc');
        if (expires.epochMs <= issued.epochMs ||
            expires.epochMs - issued.epochMs > MAX_APPROVAL_TTL_MS ||
            input.audit.occurredAtUtc !== issued.utc) {
            throw new MigrationStoreError('APPROVAL_DENIED', 'Approval expiry window is invalid');
        }
        const evidenceDigest = assertDigest(input.evidenceDigest, 'evidenceDigest');
        this.immediate('approval issuance', () => {
            this.database
                .prepare(`INSERT INTO action_approvals (
            approval_digest, scope_key, intent_key, responsibility, target_identity_key,
            ownership_version, issued_at_utc, issued_epoch_ms, expires_at_utc,
            expires_epoch_ms, evidence_digest
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
                .run(approvalDigest, this.scopeKey, intent.intent_key, input.responsibility, targetIdentityKey, input.ownershipVersion, issued.utc, issued.epochMs, expires.utc, expires.epochMs, evidenceDigest);
            appendAuditRow(this.database, this.scopeKey, input.audit, 'approval.issued', {
                approvalDigest,
                intentKey: intent.intent_key,
                responsibility: input.responsibility,
                targetIdentityKey,
                ownershipVersion: input.ownershipVersion,
                expiresAtUtc: expires.utc,
            });
        });
        return approvalDigest;
    }
    reserveExecutionJob(input) {
        if (!WRITER_RESPONSIBILITIES.includes(input.responsibility)) {
            throw new MigrationStoreError('INVALID_INPUT', 'Job responsibility is not a writer');
        }
        const jobId = identifier(input.jobId, 'jobId');
        const approvalDigest = sha256Digest(safeText(input.approvalToken, 'approvalToken', 512));
        const intentKey = assertDigest(input.intentKey, 'intentKey');
        const targetIdentityKey = assertDigest(input.targetIdentityKey, 'targetIdentityKey');
        const approvalEvidenceDigest = assertDigest(input.approvalEvidenceDigest, 'approvalEvidenceDigest');
        const orderObservationId = input.orderObservationId == null
            ? null
            : identifier(input.orderObservationId, 'orderObservationId');
        const reserved = timestamp(input.reservedAtUtc, 'reservedAtUtc');
        if (input.audit.occurredAtUtc !== reserved.utc) {
            throw new MigrationStoreError('INVALID_INPUT', 'Reservation audit time must equal reservation time');
        }
        const evidenceDigest = assertDigest(input.evidenceDigest, 'evidenceDigest');
        return this.immediate('execution job reservation', () => {
            const intent = this.requireIntent(intentKey);
            const approval = this.database
                .prepare(`SELECT approval_digest, intent_key, responsibility, target_identity_key,
            ownership_version, issued_epoch_ms, expires_epoch_ms, evidence_digest
           FROM action_approvals WHERE approval_digest = ? AND scope_key = ?`)
                .get(approvalDigest, this.scopeKey);
            if (!approval ||
                approval.intent_key !== intent.intent_key ||
                approval.responsibility !== input.responsibility ||
                approval.target_identity_key !== targetIdentityKey ||
                approval.ownership_version !== input.ownershipVersion ||
                approval.evidence_digest !== approvalEvidenceDigest ||
                intent.responsibility !== input.responsibility ||
                intent.approval_target_identity_key !== targetIdentityKey) {
                throw new MigrationStoreError('APPROVAL_DENIED', 'Approval does not exactly match this responsibility, target, intent, and ownership version');
            }
            if (reserved.epochMs < approval.issued_epoch_ms ||
                reserved.epochMs >= approval.expires_epoch_ms) {
                throw new MigrationStoreError('APPROVAL_DENIED', 'Approval is not active at reservation time');
            }
            const ownership = this.getCurrentOwnership(input.responsibility);
            if (!ownership ||
                ownership.version !== input.ownershipVersion ||
                ownership.owner !== 'product_pipeline' ||
                !ownership.singleWriterVerified) {
                throw new MigrationStoreError('OWNERSHIP_DENIED', 'Job reservation requires exact active ProductPipeline single-writer ownership');
            }
            if (input.responsibility === 'orderImport') {
                if (!orderObservationId || intent.action !== 'import_shopify_order') {
                    throw new MigrationStoreError('WATERMARK_REQUIRED', 'Order import reservation requires the exact eligible observation');
                }
                const observation = this.database
                    .prepare(`SELECT observation.observation_id
             FROM order_observations observation
             LEFT JOIN order_observation_resolutions resolution
               ON resolution.observation_id = observation.observation_id
             LEFT JOIN order_links link
               ON link.ebay_order_identity_key = observation.ebay_order_identity_key
             WHERE observation.observation_id = ?
               AND observation.scope_key = ?
               AND observation.ebay_order_identity_key = ?
               AND observation.eligible_after_watermark = 1
               AND resolution.observation_id IS NULL
               AND link.link_id IS NULL`)
                    .get(orderObservationId, this.scopeKey, intent.source_identity_key);
                if (!observation) {
                    throw new MigrationStoreError('WATERMARK_REQUIRED', 'Order observation is historical, resolved, linked, or outside this scope');
                }
            }
            else if (orderObservationId !== null) {
                throw new MigrationStoreError('INVALID_INPUT', 'Only orderImport jobs can claim an order observation');
            }
            this.database
                .prepare(`INSERT INTO approval_consumptions (
            approval_digest, scope_key, intent_key, responsibility, target_identity_key,
            ownership_version, approval_evidence_digest, consumed_at_utc, consumed_epoch_ms
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
                .run(approvalDigest, this.scopeKey, intent.intent_key, input.responsibility, targetIdentityKey, input.ownershipVersion, approvalEvidenceDigest, reserved.utc, reserved.epochMs);
            this.database
                .prepare(`INSERT INTO execution_jobs (
            job_id, scope_key, intent_key, approval_digest, responsibility,
            target_identity_key, ownership_version, approval_evidence_digest,
            order_observation_id, reserved_at_utc, reserved_epoch_ms
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
                .run(jobId, this.scopeKey, intent.intent_key, approvalDigest, input.responsibility, targetIdentityKey, input.ownershipVersion, approvalEvidenceDigest, orderObservationId, reserved.utc, reserved.epochMs);
            this.insertJobEvent({
                jobEventId: `${jobId}:1`,
                jobId,
                sequence: 1,
                fromState: null,
                toState: 'reserved',
                evidenceDigest,
                occurred: reserved,
            });
            if (orderObservationId) {
                this.database
                    .prepare(`INSERT INTO order_observation_resolutions (
              resolution_id, observation_id, disposition, reference_key,
              evidence_digest, resolved_at_utc, resolved_epoch_ms
            ) VALUES (?, ?, 'reserved_job', ?, ?, ?, ?)`)
                    .run(`${orderObservationId}:reserved`, orderObservationId, jobId, evidenceDigest, reserved.utc, reserved.epochMs);
            }
            appendAuditRow(this.database, this.scopeKey, input.audit, 'execution_job.reserved', {
                jobId,
                intentKey: intent.intent_key,
                approvalDigest,
                responsibility: input.responsibility,
                targetIdentityKey,
                ownershipVersion: input.ownershipVersion,
                approvalEvidenceDigest,
                orderObservationId,
            });
            return jobId;
        });
    }
    markDispatchingOutcomeUnknown(input) {
        const jobId = identifier(input.jobId, 'jobId');
        const attemptId = identifier(input.attemptId, 'attemptId');
        const approvalDigest = sha256Digest(safeText(input.approvalToken, 'approvalToken', 512));
        const approvalEvidenceDigest = assertDigest(input.approvalEvidenceDigest, 'approvalEvidenceDigest');
        const occurred = timestamp(input.occurredAtUtc, 'occurredAtUtc');
        const evidenceDigest = assertDigest(input.evidenceDigest, 'evidenceDigest');
        if (input.audit.occurredAtUtc !== occurred.utc) {
            throw new MigrationStoreError('INVALID_INPUT', 'Dispatch audit time must equal dispatch time');
        }
        return this.immediate('dispatch marker', () => {
            const job = this.requireJob(jobId);
            const state = currentJobState(this.database, jobId);
            if (state.state !== 'reserved') {
                throw new MigrationStoreError('CONFLICT', 'Only a reserved job can begin dispatch');
            }
            const approval = this.database
                .prepare(`SELECT expires_epoch_ms, evidence_digest FROM action_approvals
           WHERE approval_digest = ? AND scope_key = ?`)
                .get(approvalDigest, this.scopeKey);
            if (approvalDigest !== job.approval_digest
                || approvalEvidenceDigest !== job.approval_evidence_digest
                || !approval
                || approval.evidence_digest !== approvalEvidenceDigest
                || occurred.epochMs >= approval.expires_epoch_ms) {
                throw new MigrationStoreError('APPROVAL_DENIED', 'Dispatch requires the same unexpired approval token and evidence');
            }
            const ownership = this.getCurrentOwnership(job.responsibility);
            if (!ownership ||
                ownership.version !== job.ownership_version ||
                ownership.owner !== 'product_pipeline' ||
                !ownership.singleWriterVerified) {
                throw new MigrationStoreError('OWNERSHIP_DENIED', 'Dispatch marker requires unchanged ProductPipeline single-writer ownership');
            }
            if (job.responsibility === 'orderImport') {
                const existingLink = this.database
                    .prepare(`SELECT link.link_id
             FROM idempotency_intents intent
             JOIN order_links link ON link.ebay_order_identity_key = intent.source_identity_key
             WHERE intent.intent_key = ? AND intent.action = 'import_shopify_order'
               AND link.scope_key = ? LIMIT 1`)
                    .get(job.intent_key, this.scopeKey);
                if (existingLink) {
                    throw new MigrationStoreError('CONFLICT', 'Order dispatch is denied because the eBay order is already linked');
                }
            }
            this.insertJobEvent({
                jobEventId: `${jobId}:${state.sequence + 1}`,
                jobId,
                sequence: state.sequence + 1,
                fromState: state.state,
                toState: 'dispatching',
                evidenceDigest,
                occurred,
            });
            this.database
                .prepare(`INSERT INTO intent_attempts (
            attempt_id, job_id, intent_key, approval_digest, ownership_version, ordinal, outcome,
            evidence_digest, recorded_at_utc, recorded_epoch_ms
          ) VALUES (?, ?, ?, ?, ?, 1, 'outcome_unknown', ?, ?, ?)`)
                .run(attemptId, job.job_id, job.intent_key, job.approval_digest, job.ownership_version, evidenceDigest, occurred.utc, occurred.epochMs);
            appendAuditRow(this.database, this.scopeKey, input.audit, 'execution_job.dispatching', {
                jobId,
                attemptId,
                outcome: 'outcome_unknown',
                evidenceDigest,
                approvalEvidenceDigest,
            });
            return attemptId;
        });
    }
    requirePostDispatchReconciliation(input) {
        const jobId = identifier(input.jobId, 'jobId');
        const attemptId = identifier(input.attemptId, 'attemptId');
        const occurred = timestamp(input.occurredAtUtc, 'occurredAtUtc');
        const evidenceDigest = assertDigest(input.evidenceDigest, 'evidenceDigest');
        if (input.audit.occurredAtUtc !== occurred.utc) {
            throw new MigrationStoreError('INVALID_INPUT', 'Result audit time must equal result time');
        }
        this.immediate('post-dispatch reconciliation requirement', () => {
            const job = this.requireJob(jobId);
            const attempt = this.database
                .prepare('SELECT attempt_id, recorded_epoch_ms FROM intent_attempts WHERE attempt_id = ? AND job_id = ?')
                .get(attemptId, jobId);
            if (!attempt)
                throw new MigrationStoreError('NOT_FOUND', 'Dispatch attempt was not found');
            const state = currentJobState(this.database, jobId);
            if (state.state !== 'dispatching') {
                throw new MigrationStoreError('CONFLICT', 'Only a dispatching job can require reconciliation');
            }
            this.insertJobEvent({
                jobEventId: `${jobId}:${state.sequence + 1}`,
                jobId: job.job_id,
                sequence: state.sequence + 1,
                fromState: state.state,
                toState: 'reconciliation_required',
                evidenceDigest,
                occurred,
            });
            appendAuditRow(this.database, this.scopeKey, input.audit, 'execution_job.reconciliation_required', {
                jobId,
                attemptId,
                outcome: 'outcome_unknown',
                evidenceDigest,
            });
        });
    }
    resolveUnknownAttempt(input) {
        const jobId = identifier(input.jobId, 'jobId');
        const attemptId = identifier(input.attemptId, 'attemptId');
        const reconciliationRunId = identifier(input.reconciliationRunId, 'reconciliationRunId');
        const reconciliationResultDigest = assertDigest(input.reconciliationResultDigest, 'reconciliationResultDigest');
        const reconciled = timestamp(input.reconciledAtUtc, 'reconciledAtUtc');
        if (input.audit.occurredAtUtc !== reconciled.utc) {
            throw new MigrationStoreError('INVALID_INPUT', 'Reconciliation audit time must equal result time');
        }
        this.immediate('unknown attempt resolution', () => {
            const job = this.requireJob(jobId);
            if (!['orderImport', 'listingRevise'].includes(job.responsibility)) {
                throw new MigrationStoreError('CONFLICT', 'This foundation resolves only orderImport and listingRevise uncertainty');
            }
            const intent = this.requireIntent(job.intent_key);
            const attempt = this.database
                .prepare('SELECT attempt_id, recorded_epoch_ms FROM intent_attempts WHERE attempt_id = ? AND job_id = ?')
                .get(attemptId, jobId);
            if (!attempt)
                throw new MigrationStoreError('NOT_FOUND', 'Dispatch attempt was not found');
            const state = currentJobState(this.database, jobId);
            if (state.state !== 'reconciliation_required') {
                throw new MigrationStoreError('CONFLICT', 'Unknown attempt resolution requires reconciliation_required state');
            }
            const run = this.database
                .prepare(`SELECT run_id, target_identity_key, result_digest,
             started_epoch_ms, completed_epoch_ms
           FROM reconciliation_runs run
           WHERE run.run_id = ? AND run.scope_key = ?
             AND run.responsibility = ? AND run.status = 'passed'
             AND run.authoritative = 1
             AND run.mode IN ('test_lane', 'production_canary')
             AND run.external_writes_observed = 0
             AND NOT EXISTS (
               SELECT 1 FROM reconciliation_exceptions exception
               WHERE exception.run_id = run.run_id AND exception.severity = 'critical'
             )`)
                .get(reconciliationRunId, this.scopeKey, job.responsibility);
            if (!run
                || run.target_identity_key !== intent.approval_target_identity_key
                || run.result_digest !== reconciliationResultDigest
                || run.started_epoch_ms < state.occurredEpochMs
                || reconciled.epochMs < run.completed_epoch_ms) {
                throw new MigrationStoreError('CONFLICT', 'Unknown outcome requires an exact passed authoritative target reconciliation');
            }
            if (job.responsibility === 'listingRevise') {
                if (input.shopifyOrderIdentityKey != null || input.orderLinkId != null) {
                    throw new MigrationStoreError('INVALID_INPUT', 'A listing revise resolution cannot include a Shopify order link');
                }
                const recordedObservation = this.database
                    .prepare(`SELECT effect FROM listing_revise_observations
             WHERE run_id = ? AND intent_key = ?`)
                    .get(run.run_id, intent.intent_key);
                const expectedEffect = input.resolution === 'resolved_existing'
                    ? 'revised_state_observed'
                    : 'revised_state_absent';
                if (!recordedObservation || recordedObservation.effect !== expectedEffect) {
                    throw new MigrationStoreError('CONFLICT', 'A listing revise resolution requires the exact recorded target observation');
                }
            }
            let orderLinkId = null;
            if (job.responsibility === 'orderImport' && input.resolution === 'resolved_existing') {
                orderLinkId = identifier(input.orderLinkId ?? '', 'orderLinkId');
                const shopifyOrder = this.requireIdentity(input.shopifyOrderIdentityKey ?? '', 'Shopify order identity');
                if (shopifyOrder.platform !== 'shopify' || shopifyOrder.resource_kind !== 'order') {
                    throw new MigrationStoreError('INVALID_INPUT', 'Resolved order target is not a Shopify order');
                }
                this.database
                    .prepare(`INSERT INTO order_links (
              link_id, scope_key, ebay_order_identity_key, shopify_order_identity_key,
              link_kind, idempotency_intent_key, evidence_digest, linked_at_utc, linked_epoch_ms
            ) VALUES (?, ?, ?, ?, 'product_pipeline_created', ?, ?, ?, ?)`)
                    .run(orderLinkId, this.scopeKey, intent.source_identity_key, shopifyOrder.identity_key, intent.intent_key, reconciliationResultDigest, reconciled.utc, reconciled.epochMs);
            }
            else if (input.shopifyOrderIdentityKey != null || input.orderLinkId != null) {
                throw new MigrationStoreError('INVALID_INPUT', 'confirmed_missing cannot include a Shopify order link');
            }
            this.insertAttemptResolution(`${attemptId}:reconciled`, attemptId, input.resolution, reconciliationRunId, reconciliationResultDigest, reconciled);
            this.insertJobEvent({
                jobEventId: `${jobId}:${state.sequence + 1}`,
                jobId: job.job_id,
                sequence: state.sequence + 1,
                fromState: state.state,
                toState: input.resolution,
                evidenceDigest: reconciliationResultDigest,
                occurred: reconciled,
            });
            appendAuditRow(this.database, this.scopeKey, input.audit, 'execution_job.reconciled', {
                jobId,
                attemptId,
                resolution: input.resolution,
                reconciliationRunId,
                reconciliationResultDigest,
                orderLinkId,
            });
        });
    }
    linkObservedExistingOrder(input) {
        const linkId = identifier(input.linkId, 'linkId');
        const ebayOrder = this.requireIdentity(input.ebayOrderIdentityKey, 'eBay order identity');
        const shopifyOrder = this.requireIdentity(input.shopifyOrderIdentityKey, 'Shopify order identity');
        if (ebayOrder.platform !== 'ebay' || ebayOrder.resource_kind !== 'order') {
            throw new MigrationStoreError('INVALID_INPUT', 'Source identity is not an eBay order');
        }
        if (shopifyOrder.platform !== 'shopify' || shopifyOrder.resource_kind !== 'order') {
            throw new MigrationStoreError('INVALID_INPUT', 'Target identity is not a Shopify order');
        }
        const linked = timestamp(input.linkedAtUtc, 'linkedAtUtc');
        const evidenceDigest = assertDigest(input.evidenceDigest, 'evidenceDigest');
        if (input.audit.occurredAtUtc !== linked.utc) {
            throw new MigrationStoreError('INVALID_INPUT', 'Link audit time must equal link time');
        }
        this.immediate('order link', () => {
            this.database
                .prepare(`INSERT INTO order_links (
            link_id, scope_key, ebay_order_identity_key, shopify_order_identity_key,
            link_kind, idempotency_intent_key, evidence_digest, linked_at_utc, linked_epoch_ms
          ) VALUES (?, ?, ?, ?, 'observed_existing', NULL, ?, ?, ?)`)
                .run(linkId, this.scopeKey, ebayOrder.identity_key, shopifyOrder.identity_key, evidenceDigest, linked.utc, linked.epochMs);
            appendAuditRow(this.database, this.scopeKey, input.audit, 'order.linked', {
                linkId,
                ebayOrderIdentityKey: ebayOrder.identity_key,
                shopifyOrderIdentityKey: shopifyOrder.identity_key,
                linkKind: 'observed_existing',
                intentKey: null,
                evidenceDigest,
            });
        });
        return linkId;
    }
    recordOrderPage(input) {
        const pageId = identifier(input.pageId, 'pageId');
        const cursorBefore = input.cursorBefore === null
            ? null
            : safeText(input.cursorBefore, 'cursorBefore', 4096);
        const cursorAfter = safeText(input.cursorAfter, 'cursorAfter', 4096);
        const observed = timestamp(input.observedAtUtc, 'observedAtUtc');
        const snapshotDigest = assertDigest(input.snapshotDigest, 'snapshotDigest');
        if (input.audit.occurredAtUtc !== observed.utc) {
            throw new MigrationStoreError('INVALID_INPUT', 'Page audit time must equal observation time');
        }
        const watermark = this.getOrderWatermark();
        if (!watermark) {
            throw new MigrationStoreError('WATERMARK_REQUIRED', 'Order pages cannot be recorded before the immutable watermark exists');
        }
        const seenObservationIds = new Set();
        const seenOrders = new Set();
        const orders = input.orders.map((order) => {
            const observationId = identifier(order.observationId, 'observationId');
            const identity = this.requireIdentity(order.ebayOrderIdentityKey, 'eBay order identity');
            if (identity.platform !== 'ebay' || identity.resource_kind !== 'order') {
                throw new MigrationStoreError('INVALID_INPUT', 'Page identity is not an eBay order');
            }
            const sourceCreated = timestamp(order.sourceCreationDateUtc, 'source creationDate');
            if (sourceCreated.epochMs > observed.epochMs) {
                throw new MigrationStoreError('INVALID_INPUT', 'Order creationDate is after page observation');
            }
            if (seenObservationIds.has(observationId) || seenOrders.has(identity.identity_key)) {
                throw new MigrationStoreError('CONFLICT', 'Order page contains duplicate observations');
            }
            seenObservationIds.add(observationId);
            seenOrders.add(identity.identity_key);
            return { observationId, identity, sourceCreated };
        });
        return this.immediate('order page observation', () => {
            const unadvanced = this.database
                .prepare(`SELECT page.page_id FROM order_pages page
           LEFT JOIN cursor_advances advance ON advance.page_id = page.page_id
           WHERE page.scope_key = ? AND advance.page_id IS NULL LIMIT 1`)
                .get(this.scopeKey);
            if (unadvanced) {
                throw new MigrationStoreError('CONFLICT', 'Previous order page must be fully resolved and advanced first');
            }
            const current = this.database
                .prepare(`SELECT cursor_value FROM cursor_advances WHERE scope_key = ?
           ORDER BY ordinal DESC LIMIT 1`)
                .get(this.scopeKey);
            if ((current?.cursor_value ?? null) !== cursorBefore) {
                throw new MigrationStoreError('CONFLICT', 'Order page cursor does not match durable cursor');
            }
            this.database
                .prepare(`INSERT INTO order_pages (
            page_id, scope_key, cursor_before, cursor_before_digest, cursor_after,
            cursor_after_digest, observed_at_utc, observed_epoch_ms, snapshot_digest
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
                .run(pageId, this.scopeKey, cursorBefore, cursorBefore === null ? null : sha256Digest(cursorBefore), cursorAfter, sha256Digest(cursorAfter), observed.utc, observed.epochMs, snapshotDigest);
            const insertObservation = this.database.prepare(`INSERT INTO order_observations (
          observation_id, page_id, scope_key, ebay_order_identity_key,
          source_created_at_utc, source_created_epoch_ms, watermark_epoch_ms,
          eligible_after_watermark, observed_at_utc, observed_epoch_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
            for (const order of orders) {
                insertObservation.run(order.observationId, pageId, this.scopeKey, order.identity.identity_key, order.sourceCreated.utc, order.sourceCreated.epochMs, watermark.boundaryExclusiveEpochMs, order.sourceCreated.epochMs > watermark.boundaryExclusiveEpochMs ? 1 : 0, observed.utc, observed.epochMs);
            }
            appendAuditRow(this.database, this.scopeKey, input.audit, 'order_page.observed', {
                pageId,
                cursorBeforeDigest: cursorBefore === null ? null : sha256Digest(cursorBefore),
                cursorAfterDigest: sha256Digest(cursorAfter),
                snapshotDigest,
                observationCount: orders.length,
                eligibleCount: orders.filter((order) => order.sourceCreated.epochMs > watermark.boundaryExclusiveEpochMs).length,
            });
            return pageId;
        });
    }
    resolveOrderObservation(input) {
        const resolutionId = identifier(input.resolutionId, 'resolutionId');
        const observationId = identifier(input.observationId, 'observationId');
        const resolved = timestamp(input.resolvedAtUtc, 'resolvedAtUtc');
        const evidenceDigest = assertDigest(input.evidenceDigest, 'evidenceDigest');
        if (input.audit.occurredAtUtc !== resolved.utc) {
            throw new MigrationStoreError('INVALID_INPUT', 'Resolution audit time must equal resolution time');
        }
        return this.immediate('order observation resolution', () => {
            const observation = this.database
                .prepare(`SELECT ebay_order_identity_key, eligible_after_watermark, observed_epoch_ms
           FROM order_observations WHERE observation_id = ? AND scope_key = ?`)
                .get(observationId, this.scopeKey);
            if (!observation)
                throw new MigrationStoreError('NOT_FOUND', 'Order observation was not found');
            if (resolved.epochMs < observation.observed_epoch_ms) {
                throw new MigrationStoreError('INVALID_INPUT', 'Resolution precedes its observation');
            }
            let referenceKey = null;
            if (input.disposition === 'excluded_by_watermark') {
                if (observation.eligible_after_watermark !== 0 || input.referenceKey != null) {
                    throw new MigrationStoreError('CONFLICT', 'Only orders at or before the watermark can be excluded');
                }
            }
            else if (input.disposition === 'linked_existing') {
                if (observation.eligible_after_watermark !== 1) {
                    throw new MigrationStoreError('CONFLICT', 'Historical orders must remain watermark-excluded');
                }
                referenceKey = identifier(input.referenceKey ?? '', 'order link reference');
                const link = this.database
                    .prepare('SELECT link_id FROM order_links WHERE link_id = ? AND ebay_order_identity_key = ?')
                    .get(referenceKey, observation.ebay_order_identity_key);
                if (!link)
                    throw new MigrationStoreError('CONFLICT', 'Order link evidence does not match');
            }
            this.database
                .prepare(`INSERT INTO order_observation_resolutions (
            resolution_id, observation_id, disposition, reference_key, evidence_digest,
            resolved_at_utc, resolved_epoch_ms
          ) VALUES (?, ?, ?, ?, ?, ?, ?)`)
                .run(resolutionId, observationId, input.disposition, referenceKey, evidenceDigest, resolved.utc, resolved.epochMs);
            appendAuditRow(this.database, this.scopeKey, input.audit, 'order_observation.resolved', {
                resolutionId,
                observationId,
                disposition: input.disposition,
                referenceKey,
                evidenceDigest,
            });
            return resolutionId;
        });
    }
    advanceOrderCursor(input) {
        const cursorAdvanceId = identifier(input.cursorAdvanceId, 'cursorAdvanceId');
        const pageId = identifier(input.pageId, 'pageId');
        const cursorValue = safeText(input.cursorValue, 'cursorValue', 4096);
        const advanced = timestamp(input.advancedAtUtc, 'advancedAtUtc');
        if (!Number.isSafeInteger(input.ordinal) || input.ordinal < 1) {
            throw new MigrationStoreError('INVALID_INPUT', 'cursor ordinal is invalid');
        }
        if (input.audit.occurredAtUtc !== advanced.utc) {
            throw new MigrationStoreError('INVALID_INPUT', 'Cursor audit time must equal advance time');
        }
        return this.immediate('cursor advancement', () => {
            const page = this.database
                .prepare(`SELECT cursor_before, cursor_after, cursor_after_digest, observed_epoch_ms
           FROM order_pages WHERE page_id = ? AND scope_key = ?`)
                .get(pageId, this.scopeKey);
            if (!page)
                throw new MigrationStoreError('NOT_FOUND', 'Order page was not found');
            if (page.cursor_after !== cursorValue ||
                page.cursor_after_digest !== sha256Digest(cursorValue) ||
                advanced.epochMs < page.observed_epoch_ms) {
                throw new MigrationStoreError('CONFLICT', 'Cursor does not match the observed page');
            }
            const current = this.database
                .prepare(`SELECT ordinal, cursor_value FROM cursor_advances WHERE scope_key = ?
           ORDER BY ordinal DESC LIMIT 1`)
                .get(this.scopeKey);
            if (input.ordinal !== (current?.ordinal ?? 0) + 1 ||
                page.cursor_before !== (current?.cursor_value ?? null)) {
                throw new MigrationStoreError('CONFLICT', 'Cursor regression, gap, or page mismatch');
            }
            const counts = this.database
                .prepare(`SELECT COUNT(*) AS observed,
            SUM(CASE WHEN resolution.observation_id IS NOT NULL THEN 1 ELSE 0 END) AS resolved
           FROM order_observations observation
           LEFT JOIN order_observation_resolutions resolution
             ON resolution.observation_id = observation.observation_id
           WHERE observation.page_id = ?`)
                .get(pageId);
            if (counts.observed !== (counts.resolved ?? 0)) {
                throw new MigrationStoreError('CONFLICT', 'Cursor cannot advance until every page observation is durably resolved');
            }
            this.database
                .prepare(`INSERT INTO cursor_advances (
            cursor_advance_id, scope_key, source_platform, responsibility, ordinal,
            cursor_value, cursor_digest, page_id, advanced_at_utc, advanced_epoch_ms
          ) VALUES (?, ?, 'ebay', 'orderImport', ?, ?, ?, ?, ?, ?)`)
                .run(cursorAdvanceId, this.scopeKey, input.ordinal, cursorValue, page.cursor_after_digest, pageId, advanced.utc, advanced.epochMs);
            appendAuditRow(this.database, this.scopeKey, input.audit, 'order_cursor.advanced', {
                cursorAdvanceId,
                pageId,
                ordinal: input.ordinal,
                cursorDigest: page.cursor_after_digest,
                observedCount: counts.observed,
            });
            return input.ordinal;
        });
    }
    recordReconciliationRun(input) {
        const productionRunAllowed = (input.mode === 'shadow' && !input.authoritative && input.externalWritesObserved === 0)
            // The reviewed listing-revise slice: an exact-target post-dispatch
            // production canary reconciliation that itself performs zero writes.
            || (input.mode === 'production_canary'
                && input.responsibility === 'listingRevise'
                && input.externalWritesObserved === 0);
        if (this.scope.ebayEnvironment === 'production' && !productionRunAllowed) {
            throw new MigrationStoreError('OWNERSHIP_DENIED', 'Production reconciliation is shadow-only, non-authoritative, and zero-write');
        }
        const runId = identifier(input.runId, 'runId');
        if (!MIGRATION_RESPONSIBILITIES.includes(input.responsibility)) {
            throw new MigrationStoreError('INVALID_INPUT', 'responsibility is invalid');
        }
        if (!['shadow', 'test_lane', 'production_canary'].includes(input.mode)) {
            throw new MigrationStoreError('INVALID_INPUT', 'reconciliation mode is invalid');
        }
        if (!['passed', 'blocked', 'failed'].includes(input.status)) {
            throw new MigrationStoreError('INVALID_INPUT', 'reconciliation status is invalid');
        }
        if (!Number.isSafeInteger(input.externalWritesObserved) ||
            input.externalWritesObserved < 0 ||
            (input.mode === 'shadow' && input.externalWritesObserved !== 0) ||
            (input.authoritative && input.externalWritesObserved !== 0)) {
            throw new MigrationStoreError('INVALID_INPUT', 'external write observation count is invalid');
        }
        const sourceSnapshotDigest = assertDigest(input.sourceSnapshotDigest, 'sourceSnapshotDigest');
        const targetSnapshotDigest = assertDigest(input.targetSnapshotDigest, 'targetSnapshotDigest');
        const resultDigest = assertDigest(input.resultDigest, 'resultDigest');
        const authorityEvidenceDigest = assertDigest(input.authorityEvidenceDigest, 'authorityEvidenceDigest');
        const targetIdentityKey = this.requireIdentity(input.targetIdentityKey, 'reconciliation target').identity_key;
        if (input.authoritative
            && (input.status !== 'passed' || input.mode === 'shadow')) {
            throw new MigrationStoreError('INVALID_INPUT', 'Authoritative reconciliation must be passed and non-shadow');
        }
        const started = timestamp(input.startedAtUtc, 'startedAtUtc');
        const completed = timestamp(input.completedAtUtc, 'completedAtUtc');
        if (completed.epochMs < started.epochMs || input.audit.occurredAtUtc !== completed.utc) {
            throw new MigrationStoreError('INVALID_INPUT', 'reconciliation timestamps are invalid');
        }
        const observationInput = input.listingReviseObservation ?? null;
        if (observationInput !== null
            && (input.responsibility !== 'listingRevise' || input.mode === 'shadow')) {
            throw new MigrationStoreError('INVALID_INPUT', 'A listing revise observation requires a non-shadow listingRevise run');
        }
        const observation = observationInput === null ? null : {
            observationId: identifier(observationInput.observationId, 'observationId'),
            intentKey: assertDigest(observationInput.intentKey, 'observation intentKey'),
            effect: observationInput.effect,
            observedDigest: assertDigest(observationInput.observedDigest, 'observedDigest'),
        };
        if (observation !== null
            && !['revised_state_observed', 'revised_state_absent'].includes(observation.effect)) {
            throw new MigrationStoreError('INVALID_INPUT', 'listing revise effect is invalid');
        }
        const seenExceptions = new Set();
        const exceptions = input.exceptions.map((exception) => {
            const exceptionId = identifier(exception.exceptionId, 'exceptionId');
            if (seenExceptions.has(exceptionId)) {
                throw new MigrationStoreError('CONFLICT', 'reconciliation exception ID is duplicated');
            }
            seenExceptions.add(exceptionId);
            const code = identifier(exception.code, 'exception code');
            if (!['info', 'warning', 'critical'].includes(exception.severity)) {
                throw new MigrationStoreError('INVALID_INPUT', 'exception severity is invalid');
            }
            const subjectIdentityKey = exception.subjectIdentityKey
                ? this.requireIdentity(exception.subjectIdentityKey, 'exception subject').identity_key
                : null;
            return {
                exceptionId,
                code,
                severity: exception.severity,
                subjectIdentityKey,
                detailsDigest: assertDigest(exception.detailsDigest, 'exception detailsDigest'),
            };
        });
        return this.immediate('reconciliation run', () => {
            this.database
                .prepare(`INSERT INTO reconciliation_runs (
            run_id, scope_key, responsibility, target_identity_key, mode, status,
            source_snapshot_digest, target_snapshot_digest, result_digest,
            authoritative, authority_evidence_digest, external_writes_observed,
            started_at_utc, started_epoch_ms, completed_at_utc, completed_epoch_ms
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
                .run(runId, this.scopeKey, input.responsibility, targetIdentityKey, input.mode, input.status, sourceSnapshotDigest, targetSnapshotDigest, resultDigest, input.authoritative ? 1 : 0, authorityEvidenceDigest, input.externalWritesObserved, started.utc, started.epochMs, completed.utc, completed.epochMs);
            const insertException = this.database.prepare(`INSERT INTO reconciliation_exceptions (
          exception_id, run_id, code, severity, subject_identity_key,
          details_digest, created_at_utc, created_epoch_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
            for (const exception of exceptions) {
                insertException.run(exception.exceptionId, runId, exception.code, exception.severity, exception.subjectIdentityKey, exception.detailsDigest, completed.utc, completed.epochMs);
            }
            if (observation !== null) {
                this.database
                    .prepare(`INSERT INTO listing_revise_observations (
              observation_id, run_id, intent_key, target_identity_key,
              effect, observed_digest, created_at_utc, created_epoch_ms
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
                    .run(observation.observationId, runId, observation.intentKey, targetIdentityKey, observation.effect, observation.observedDigest, completed.utc, completed.epochMs);
            }
            appendAuditRow(this.database, this.scopeKey, input.audit, 'reconciliation.recorded', {
                runId,
                responsibility: input.responsibility,
                targetIdentityKey,
                mode: input.mode,
                status: input.status,
                sourceSnapshotDigest,
                targetSnapshotDigest,
                resultDigest,
                authoritative: input.authoritative,
                authorityEvidenceDigest,
                externalWritesObserved: input.externalWritesObserved,
                exceptionIds: exceptions.map((exception) => exception.exceptionId).sort(),
                listingReviseObservation: observation === null ? null : {
                    observationId: observation.observationId,
                    intentKey: observation.intentKey,
                    effect: observation.effect,
                    observedDigest: observation.observedDigest,
                },
            });
            return runId;
        });
    }
    verifyAuditChain() {
        this.assertOpen();
        return verifyAuditRows(this.database, this.scopeKey);
    }
    getCounts() {
        this.assertOpen();
        const tableNames = [
            'external_identities',
            'order_watermarks',
            'order_links',
            'order_pages',
            'order_observations',
            'order_observation_resolutions',
            'cursor_advances',
            'ownership_versions',
            'idempotency_intents',
            'action_approvals',
            'approval_consumptions',
            'execution_jobs',
            'intent_attempts',
            'attempt_resolutions',
            'reconciliation_runs',
            'reconciliation_exceptions',
            'listing_revise_observations',
            'audit_events',
        ];
        return Object.fromEntries(tableNames.map((tableName) => {
            const row = this.database.prepare(`SELECT COUNT(*) AS count FROM ${tableName}`).get();
            return [tableName, row.count];
        }));
    }
    /**
     * Counts every execution-authority row (intent, approval, consumption, job,
     * event, attempt, resolution) whose responsibility is not the given one.
     * The read-only projection uses this to prove a production store's
     * execution state is scoped exclusively to the reviewed slice.
     */
    countExecutionRowsOutsideResponsibility(responsibility) {
        this.assertOpen();
        if (!MIGRATION_RESPONSIBILITIES.includes(responsibility)) {
            throw new MigrationStoreError('INVALID_INPUT', 'responsibility is invalid');
        }
        const row = this.database
            .prepare(`SELECT
          (SELECT COUNT(*) FROM idempotency_intents WHERE responsibility != ?)
          + (SELECT COUNT(*) FROM action_approvals WHERE responsibility != ?)
          + (SELECT COUNT(*) FROM approval_consumptions consumption
             JOIN action_approvals approval
               ON approval.approval_digest = consumption.approval_digest
             WHERE approval.responsibility != ?)
          + (SELECT COUNT(*) FROM execution_jobs WHERE responsibility != ?)
          + (SELECT COUNT(*) FROM job_events event
             JOIN execution_jobs job ON job.job_id = event.job_id
             WHERE job.responsibility != ?)
          + (SELECT COUNT(*) FROM intent_attempts attempt
             JOIN execution_jobs job ON job.job_id = attempt.job_id
             WHERE job.responsibility != ?)
          + (SELECT COUNT(*) FROM attempt_resolutions resolution
             JOIN intent_attempts attempt ON attempt.attempt_id = resolution.attempt_id
             JOIN execution_jobs job ON job.job_id = attempt.job_id
             WHERE job.responsibility != ?)
          AS foreign_rows`)
            .get(responsibility, responsibility, responsibility, responsibility, responsibility, responsibility, responsibility);
        return row.foreign_rows;
    }
    assertShopifyScope(input) {
        if (input.storeDomain.toLowerCase() !== this.scope.shopifyStoreDomain) {
            throw new MigrationStoreError('ACCOUNT_DRIFT', 'Shopify identity belongs to another store');
        }
    }
    assertEbayScope(input) {
        if (input.environment !== this.scope.ebayEnvironment ||
            input.sellerId !== this.scope.ebaySellerId ||
            input.marketplaceId.toUpperCase() !== this.scope.ebayMarketplaceId) {
            throw new MigrationStoreError('ACCOUNT_DRIFT', 'eBay identity belongs to another account scope');
        }
    }
    validateShopifyGid(input) {
        const resourceName = {
            product: 'Product',
            variant: 'ProductVariant',
            order: 'Order',
        }[input.kind];
        const externalGid = safeText(input.externalGid, 'externalGid', 512);
        if (!new RegExp(`^gid://shopify/${resourceName}/[^/\\s]+$`).test(externalGid)) {
            throw new MigrationStoreError('INVALID_INPUT', `Shopify ${input.kind} identity must use its canonical GID`);
        }
        return externalGid;
    }
    requireIdentity(identityKey, name) {
        const key = assertDigest(identityKey, name);
        const row = this.database
            .prepare(`SELECT identity_key, scope_key, platform, resource_kind, binding_key,
          external_id, created_at_utc FROM external_identities
         WHERE identity_key = ? AND scope_key = ?`)
            .get(key, this.scopeKey);
        if (!row)
            throw new MigrationStoreError('NOT_FOUND', `${name} was not registered`);
        return row;
    }
    requireIntent(intentKey) {
        const key = assertDigest(intentKey, 'intentKey');
        const row = this.database
            .prepare(`SELECT intent_key, responsibility, action, source_identity_key,
          target_identity_key, approval_target_identity_key, desired_state_digest
         FROM idempotency_intents WHERE intent_key = ? AND scope_key = ?`)
            .get(key, this.scopeKey);
        if (!row)
            throw new MigrationStoreError('NOT_FOUND', 'Idempotency intent was not found');
        return row;
    }
    requireJob(jobId) {
        const row = this.database
            .prepare(`SELECT job_id, intent_key, approval_digest, responsibility,
          target_identity_key, ownership_version, approval_evidence_digest
         FROM execution_jobs WHERE job_id = ? AND scope_key = ?`)
            .get(jobId, this.scopeKey);
        if (!row)
            throw new MigrationStoreError('NOT_FOUND', 'Execution job was not found');
        return row;
    }
    assertActionIdentityShape(action, source, target) {
        if (action === 'import_shopify_order') {
            if (source.platform !== 'ebay' || source.resource_kind !== 'order' || target !== null) {
                throw new MigrationStoreError('INVALID_INPUT', 'Shopify order-create intent must be keyed only to one eBay order');
            }
            return;
        }
        if (!target || target.platform !== 'ebay') {
            throw new MigrationStoreError('INVALID_INPUT', 'eBay mutation intents require an eBay target');
        }
        if (action === 'update_ebay_price') {
            if (source.platform !== 'shopify' || !['product', 'variant'].includes(source.resource_kind)) {
                throw new MigrationStoreError('INVALID_INPUT', 'Price source must be a Shopify product or variant');
            }
            if (!['offer', 'listing'].includes(target.resource_kind)) {
                throw new MigrationStoreError('INVALID_INPUT', 'Price target must be an eBay offer or listing');
            }
        }
        else if (action === 'update_ebay_inventory') {
            if (source.platform !== 'shopify' || source.resource_kind !== 'variant') {
                throw new MigrationStoreError('INVALID_INPUT', 'Inventory source must be a Shopify variant');
            }
            if (target.resource_kind !== 'inventory_sku') {
                throw new MigrationStoreError('INVALID_INPUT', 'Inventory target must be an eBay inventory SKU');
            }
        }
        else if (action === 'create_ebay_listing') {
            if (source.platform !== 'shopify' || !['product', 'variant'].includes(source.resource_kind)) {
                throw new MigrationStoreError('INVALID_INPUT', 'Listing source must be a Shopify product or variant');
            }
            if (target.resource_kind !== 'inventory_sku') {
                throw new MigrationStoreError('INVALID_INPUT', 'Listing-create target must be an eBay inventory SKU');
            }
        }
        else if (['revise_ebay_listing', 'end_or_relist_ebay_listing'].includes(action)) {
            if (source.platform !== 'shopify' || !['product', 'variant'].includes(source.resource_kind)) {
                throw new MigrationStoreError('INVALID_INPUT', 'Listing source must be a Shopify product or variant');
            }
            if (target.resource_kind !== 'listing') {
                throw new MigrationStoreError('INVALID_INPUT', 'Listing target must be an eBay listing');
            }
        }
        else if (action === 'update_mapping') {
            if (source.platform !== 'shopify' || !['product', 'variant'].includes(source.resource_kind)) {
                throw new MigrationStoreError('INVALID_INPUT', 'Mapping source must be a Shopify product or variant');
            }
            if (!['inventory_sku', 'offer', 'listing'].includes(target.resource_kind)) {
                throw new MigrationStoreError('INVALID_INPUT', 'Mapping target must be an eBay commerce identity');
            }
        }
        else if (['sync_fulfillment', 'sync_feedback'].includes(action)) {
            if (source.platform !== 'shopify' ||
                source.resource_kind !== 'order' ||
                target.resource_kind !== 'order') {
                throw new MigrationStoreError('INVALID_INPUT', 'Fulfillment intent requires a Shopify order and eBay order');
            }
        }
    }
    insertJobEvent(input) {
        this.database
            .prepare(`INSERT INTO job_events (
          job_event_id, job_id, sequence, from_state, to_state, evidence_digest,
          occurred_at_utc, occurred_epoch_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(input.jobEventId, input.jobId, input.sequence, input.fromState, input.toState, input.evidenceDigest, input.occurred.utc, input.occurred.epochMs);
    }
    insertAttemptResolution(resolutionId, attemptId, resolution, reconciliationRunId, evidenceDigest, reconciled) {
        this.database
            .prepare(`INSERT INTO attempt_resolutions (
          resolution_id, attempt_id, resolution, reconciliation_run_id, evidence_digest,
          reconciled_at_utc, reconciled_epoch_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`)
            .run(resolutionId, attemptId, resolution, reconciliationRunId, evidenceDigest, reconciled.utc, reconciled.epochMs);
    }
}
