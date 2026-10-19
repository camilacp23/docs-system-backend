/**
 * HTTP layer of the applications module: reads the request, calls the service and writes status, headers and body.
 * No rules here. Authorization (x-roles) already ran in the middleware generated from the contract.
 *
 * @module modules/applications/controller
 */
import type { Request, Response } from 'express';
import type { ApplicationStatus } from '../../generated/prisma/client.js';
import { assertIfMatch, etagOf, setEtag, setLocation } from '../../http/etag.js';
import { paged, parsePagination } from '../../http/pagination.js';
import type { ApplicationView } from './repository.js';
import type { ApplicationService } from './service.js';

const ELEMENT = 'application';

const idOf = (req: Request): number => Number(req.params.id);
const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);

/** Sends a single application with its ETag. */
function sendApplication(res: Response, application: ApplicationView, status = 200): void {
  setEtag(res, etagOf(application));
  res.status(status).json({ data: application });
}

/**
 * Creates the handlers of the four /applications operations.
 *
 * @param service - Applications service.
 */
export function createApplicationsController(service: ApplicationService) {
  return {
    /** GET /applications */
    list: async (req: Request, res: Response): Promise<void> => {
      const page = parsePagination(req.query);
      const { data, total } = await service.list({
        q: text(req.query.q),
        status: text(req.query.status) as ApplicationStatus | undefined,
        skip: page.skip,
        take: page.take,
      });
      res.json(paged(data, page, total));
    },
    /** POST /applications */
    create: async (req: Request, res: Response): Promise<void> => {
      const application = await service.create(req.user!.id, req.body as Parameters<ApplicationService['create']>[1]);
      setLocation(res, '/applications', application.id);
      sendApplication(res, application, 201);
    },
    /** GET /applications/:id */
    get: async (req: Request, res: Response): Promise<void> => {
      sendApplication(res, await service.get(idOf(req)));
    },
    /** PUT /applications/:id */
    update: async (req: Request, res: Response): Promise<void> => {
      const application = await service.update(
        idOf(req),
        req.body as Parameters<ApplicationService['update']>[1],
        (currentETag) => assertIfMatch(req, ELEMENT, currentETag),
      );
      sendApplication(res, application);
    },
  };
}
