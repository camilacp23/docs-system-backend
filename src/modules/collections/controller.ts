/**
 * HTTP layer of the collections module: reads the request, calls the service and writes status, headers and body.
 * No rules here. Authorization (x-roles) already ran in the middleware generated from the contract.
 *
 * @module modules/collections/controller
 */
import type { Request, Response } from 'express';
import type { Environment } from '../../generated/prisma/client.js';
import { assertIfMatch, etagOf, setEtag, setLocation } from '../../http/etag.js';
import { paged, parsePagination, parseSort } from '../../http/pagination.js';
import type { CollectionListQuery, CollectionView } from './repository.js';
import type { CollectionService } from './service.js';

const ELEMENT = 'collection';
const DEFAULT_SORT: CollectionListQuery['sort'] = { field: 'name', direction: 'asc' };
/** The contract gives `GET /collections/{id}/fields` a `pageSize` of 100 by default. */
const FIELDS_PAGE_SIZE = 100;

const idOf = (req: Request): number => Number(req.params.id);
const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
/** `true` / `false` as the validator leaves them (boolean or text); anything else is absent. */
const flag = (value: unknown): boolean | undefined =>
  typeof value === 'boolean' ? value : value === 'true' ? true : value === 'false' ? false : undefined;

/** Sends a single collection with its ETag. */
function sendCollection(res: Response, collection: CollectionView, status = 200): void {
  setEtag(res, etagOf(collection));
  res.status(status).json({ data: collection });
}

/**
 * Creates the handlers of the /collections operations.
 *
 * @param service - Collections service.
 */
export function createCollectionsController(service: CollectionService) {
  return {
    /** GET /collections */
    list: async (req: Request, res: Response): Promise<void> => {
      const page = parsePagination(req.query);
      const sort = parseSort(
        req.query.sort,
        req.policy?.sort?.allowed ?? [],
        DEFAULT_SORT,
      ) as CollectionListQuery['sort'];
      const { data, total } = await service.list({
        applicationId: Number(req.query.applicationId),
        q: text(req.query.q),
        environment: text(req.query.environment) as Environment | undefined,
        // undocumented=false is "no filter" (only `true` restricts), as with an absent parameter.
        undocumented: flag(req.query.undocumented),
        sort,
        skip: page.skip,
        take: page.take,
      });
      res.json(paged(data, page, total));
    },
    /** GET /collections/:id */
    get: async (req: Request, res: Response): Promise<void> => {
      sendCollection(res, await service.get(idOf(req)));
    },
    /** GET /collections/:id/fields */
    listFields: async (req: Request, res: Response): Promise<void> => {
      const page = parsePagination(req.query, FIELDS_PAGE_SIZE);
      const { data, total } = await service.listFields(idOf(req), page.skip, page.take);
      res.json(paged(data, page, total));
    },
    /** POST /collections */
    create: async (req: Request, res: Response): Promise<void> => {
      const collection = await service.create(req.body as Parameters<CollectionService['create']>[0]);
      setLocation(res, '/collections', collection.id);
      sendCollection(res, collection, 201);
    },
    /** PUT /collections/:id */
    update: async (req: Request, res: Response): Promise<void> => {
      const collection = await service.update(
        idOf(req),
        req.body as Parameters<CollectionService['update']>[1],
        (currentETag) => assertIfMatch(req, ELEMENT, currentETag),
      );
      sendCollection(res, collection);
    },
    /** DELETE /collections/:id */
    remove: async (req: Request, res: Response): Promise<void> => {
      await service.remove(idOf(req));
      res.status(204).end();
    },
  };
}
