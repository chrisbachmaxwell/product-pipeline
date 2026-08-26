import { Router } from 'express';
import { getMigrationPolicyStatus } from '../../safety/writer-quarantine.js';
import {
  getCachedOperationalHealth,
  type CachedOperationalHealthProjection,
} from '../operational-monitoring.js';

export function createHealthRouter(
  cachedMonitoringReader: () => CachedOperationalHealthProjection = getCachedOperationalHealth,
): Router {
  const router = Router();
  router.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
      buildCommit: process.env.RAILWAY_GIT_COMMIT_SHA || process.env.GIT_COMMIT_SHA || null,
      migration: getMigrationPolicyStatus(),
      monitoring: cachedMonitoringReader(),
    });
  });

  return router;
}

export default createHealthRouter();
