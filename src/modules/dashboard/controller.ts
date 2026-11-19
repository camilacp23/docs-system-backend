/**
 * HTTP layer of the indicator dashboard: reads the request, calls the service and writes the body. No rules here.
 * Authorization (x-roles) already ran in the middleware generated from the contract; `READER_OVERVIEW` is the
 * service's. The ETag is the weak hash of the body that Express adds to every GET, and `If-None-Match` answers 304
 * (D-72).
 *
 * @module modules/dashboard/controller
 */
import type { Request, Response } from 'express';
import type { DashboardService } from './service.js';

/**
 * Creates the handlers of the /dashboard operations.
 *
 * @param service - Dashboard service.
 */
export function createDashboardController(service: DashboardService) {
  return {
    /** GET /dashboard/indicators */
    indicators: async (req: Request, res: Response): Promise<void> => {
      const data = await service.indicators(req.user!, Number(req.query.applicationId));
      res.json({ data });
    },
  };
}
