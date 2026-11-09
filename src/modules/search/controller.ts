/**
 * HTTP layer of the advanced search: reads the request, calls the service and writes the body. No rules here.
 * Authorization (x-roles) already ran in the middleware generated from the contract. The ETag is the weak hash of the
 * body that Express adds to every GET, and `If-None-Match` answers 304 (D-72); the order of the body is deterministic,
 * so the same data gives the same ETag.
 *
 * @module modules/search/controller
 */
import type { Request, Response } from 'express';
import { paged, parsePagination } from '../../http/pagination.js';
import type { ElementType } from './repository.js';
import type { SearchService } from './service.js';

const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);

/** `types` as the validator leaves it: an array, or the comma-separated text. */
function typesOf(value: unknown): ElementType[] | undefined {
  if (value === undefined) return undefined;
  const items = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [];
  return items.map((item) => String(item).trim() as ElementType);
}

/**
 * Creates the handlers of the /search operation.
 *
 * @param service - Search service.
 */
export function createSearchController(service: SearchService) {
  return {
    /** GET /search */
    search: async (req: Request, res: Response): Promise<void> => {
      const page = parsePagination(req.query);
      const { data, total } = await service.search({
        applicationId: Number(req.query.applicationId),
        q: text(req.query.q),
        types: typesOf(req.query.types),
        environment: text(req.query.environment),
        documentationStatus: text(req.query.documentationStatus),
        scope: text(req.query.scope),
        skip: page.skip,
        take: page.take,
      });
      res.json(paged(data, page, total));
    },
  };
}
