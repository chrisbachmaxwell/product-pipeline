import { ListingControlStoreError, openListingControlStore, } from '../store.js';
const [databasePath, scopeJson, revisionJson] = process.argv.slice(2);
if (!databasePath || !scopeJson || !revisionJson)
    process.exit(2);
const store = openListingControlStore({
    databasePath,
    expectedScope: JSON.parse(scopeJson),
});
process.stdout.write('READY\n');
process.stdin.once('data', () => {
    try {
        const created = store.createRevision(JSON.parse(revisionJson));
        process.stdout.write(`RESULT:${JSON.stringify({ ok: true, digest: created.revisionDigest })}\n`);
    }
    catch (error) {
        process.stdout.write(`RESULT:${JSON.stringify({
            ok: false,
            code: error instanceof ListingControlStoreError ? error.code : 'UNEXPECTED',
        })}\n`);
    }
    finally {
        store.close();
    }
});
