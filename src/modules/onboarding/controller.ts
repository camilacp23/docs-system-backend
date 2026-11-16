/**
 * HTTP layer of the onboarding summary: reads the request, calls the service and writes the body. No rules here.
 * Authorization (x-roles) already ran in the middleware generated from the contract. The ETag is the weak hash of the
 * body that Express adds to every GET, and `If-None-Match` answers 304 (D-72); every list has a total order, so the
 * same data gives the same ETag.
 *
 * @module modules/onboarding/controller
 */
import type { Request, Response } from 'express';
import type { OnboardingService } from './service.js';

/**
 * Creates the handlers of the /onboarding operations.
 *
 * @param service - Onboarding service.
 */
export function createOnboardingController(service: OnboardingService) {
  return {
    /** GET /onboarding/summary */
    summary: async (req: Request, res: Response): Promise<void> => {
      res.json({ data: await service.summary(Number(req.query.applicationId)) });
    },
  };
}
