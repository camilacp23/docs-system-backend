/**
 * HTTP layer of the screens module: reads the request, calls the service and writes status, headers and body.
 * No rules here. Authorization (x-roles) already ran in the middleware generated from the contract.
 *
 * @module modules/screens/controller
 */
import type { Request, Response } from 'express';
import type { DocumentationStatus } from '../../generated/prisma/client.js';
import { paged, parsePagination, parseSort } from '../../http/pagination.js';
import type { ScreenListQuery } from './repository.js';
import type { ScreenService } from './service.js';

const DEFAULT_SORT: ScreenListQuery['sort'] = { field: 'name', direction: 'asc' };

const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
/** The request validator may leave a numeric query value as a string or as a number. */
const integer = (value: unknown): number | undefined =>
  typeof value === 'string' || typeof value === 'number' ? Number(value) : undefined;

/**
 * Creates the handlers of the screens operations that exist so far.
 *
 * @param service - Screens service.
 */
export function createScreensController(service: ScreenService) {
  return {
    /** GET /screens */
    list: async (req: Request, res: Response): Promise<void> => {
      const page = parsePagination(req.query);
      const sort = parseSort(req.query.sort, req.policy?.sort?.allowed ?? [], DEFAULT_SORT) as ScreenListQuery['sort'];
      const { data, total } = await service.list({
        applicationId: Number(req.query.applicationId),
        q: text(req.query.q),
        documentationStatus: text(req.query.documentationStatus) as DocumentationStatus | undefined,
        authorId: integer(req.query.authorId),
        sort,
        skip: page.skip,
        take: page.take,
      });
      res.json(paged(data, page, total));
    },
  };
}
