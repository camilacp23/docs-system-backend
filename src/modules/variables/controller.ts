/**
 * HTTP layer of the variables module: reads the request, calls the service and writes status, headers and body.
 * No rules here. Authorization (x-roles) already ran in the middleware generated from the contract.
 *
 * @module modules/variables/controller
 */
import type { Request, Response } from 'express';
import type { DataType, Environment, VariableScope } from '../../generated/prisma/client.js';
import { assertIfMatch, etagOf, setEtag, setLocation } from '../../http/etag.js';
import { paged, parsePagination, parseSort } from '../../http/pagination.js';
import type { VariableListQuery, VariableView } from './repository.js';
import type { VariableService } from './service.js';

const ELEMENT = 'variable';
const DEFAULT_SORT: VariableListQuery['sort'] = { field: 'name', direction: 'asc' };

const idOf = (req: Request): number => Number(req.params.id);
const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
/** The request validator may leave a numeric query value as a string or as a number. */
const integer = (value: unknown): number | undefined =>
  typeof value === 'string' || typeof value === 'number' ? Number(value) : undefined;
/** `true` / `false` as the validator leaves them (boolean or text); anything else is absent. */
const flag = (value: unknown): boolean | undefined =>
  typeof value === 'boolean' ? value : value === 'true' ? true : value === 'false' ? false : undefined;

/** Sends a single variable with its ETag. */
function sendVariable(res: Response, variable: VariableView, status = 200): void {
  setEtag(res, etagOf(variable));
  res.status(status).json({ data: variable });
}

/**
 * Creates the handlers of the /variables operations.
 *
 * @param service - Variables service.
 */
export function createVariablesController(service: VariableService) {
  return {
    /** GET /variables */
    list: async (req: Request, res: Response): Promise<void> => {
      const page = parsePagination(req.query);
      const sort = parseSort(
        req.query.sort,
        req.policy?.sort?.allowed ?? [],
        DEFAULT_SORT,
      ) as VariableListQuery['sort'];
      const { data, total } = await service.list({
        applicationId: Number(req.query.applicationId),
        q: text(req.query.q),
        scope: text(req.query.scope) as VariableScope | undefined,
        dataType: text(req.query.dataType) as DataType | undefined,
        environment: text(req.query.environment) as Environment | undefined,
        originScreenId: integer(req.query.originScreenId),
        // untraced=false is "no filter" (only `true` restricts), as with an absent parameter.
        untraced: flag(req.query.untraced),
        sort,
        skip: page.skip,
        take: page.take,
      });
      res.json(paged(data, page, total));
    },
    /** GET /variables/:id */
    get: async (req: Request, res: Response): Promise<void> => {
      sendVariable(res, await service.get(idOf(req)));
    },
    /** POST /variables */
    create: async (req: Request, res: Response): Promise<void> => {
      const variable = await service.create(req.body as Parameters<VariableService['create']>[0]);
      setLocation(res, '/variables', variable.id);
      sendVariable(res, variable, 201);
    },
    /** PUT /variables/:id */
    update: async (req: Request, res: Response): Promise<void> => {
      const variable = await service.update(
        idOf(req),
        req.body as Parameters<VariableService['update']>[1],
        (currentETag) => assertIfMatch(req, ELEMENT, currentETag),
      );
      sendVariable(res, variable);
    },
    /** DELETE /variables/:id */
    remove: async (req: Request, res: Response): Promise<void> => {
      await service.remove(idOf(req));
      res.status(204).end();
    },
    /** GET /variables/:id/dependencies */
    dependencies: async (req: Request, res: Response): Promise<void> => {
      res.json({ data: await service.dependencies(idOf(req)) });
    },
  };
}
