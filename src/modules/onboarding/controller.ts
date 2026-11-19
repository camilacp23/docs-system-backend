/**
 * HTTP layer of the onboarding (the summary and the progress of the user): reads the request, calls the service and writes the body. No rules here.
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
    /** GET /onboarding/progress (the user is the one of the token) */
    progress: async (req: Request, res: Response): Promise<void> => {
      res.json({ data: await service.progress(req.user!.id, Number(req.query.applicationId)) });
    },
    /** PUT /onboarding/progress/steps/:step */
    completeStep: async (req: Request, res: Response): Promise<void> => {
      const progress = await service.completeStep(
        req.user!.id,
        Number(req.query.applicationId),
        Number(req.params.step),
      );
      res.json({ data: progress });
    },
    /** DELETE /onboarding/progress */
    resetProgress: async (req: Request, res: Response): Promise<void> => {
      await service.resetProgress(req.user!.id, Number(req.query.applicationId));
      res.status(204).end();
    },
  };
}
