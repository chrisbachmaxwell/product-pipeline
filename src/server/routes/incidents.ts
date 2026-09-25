import { Router, type Request, type Response } from 'express';
import { apiPrincipal } from '../middleware/auth.js';
import { getIncidents } from '../incident-watchdog.js';

/** Read-only incident feed for the UI banner (L76). */
export function createIncidentsRouter(): Router {
  const router = Router();
  router.get('/api/incidents', (req: Request, res: Response) => {
    const principal = apiPrincipal(req);
    if (principal?.kind !== 'shopify_session'
      || principal.shopifyStoreDomain !== 'usedcameragear.myshopify.com') {
      res.status(403).json({ error: 'Requires a signed-in Shopify session' });
      return;
    }
    res.json({ schemaVersion: 1, incidents: getIncidents() });
  });
  return router;
}

export default createIncidentsRouter();
