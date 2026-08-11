import { Router } from 'express';
import { getMigrationPolicyStatus } from '../../safety/writer-quarantine.js';
const router = Router();
router.get('/health', (_req, res) => {
    res.json({
        status: 'ok',
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
        buildCommit: process.env.RAILWAY_GIT_COMMIT_SHA || process.env.GIT_COMMIT_SHA || null,
        migration: getMigrationPolicyStatus(),
    });
});
export default router;
