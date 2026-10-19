/**
 * HTTP layer of the users module: reads the request, calls the service and writes status, headers and body. No rules
 * here. Authorization (x-roles, SELF_OR_ROLE) already ran in the middleware generated from the contract.
 *
 * @module modules/users/controller
 */
import type { Request, Response } from 'express';
import type { UserRole, UserStatus } from '../../generated/prisma/client.js';
import { assertIfMatch, etagOf, setEtag, setLocation } from '../../http/etag.js';
import { paged, parsePagination, parseSort } from '../../http/pagination.js';
import type { UserListQuery, UserView } from './repository.js';
import type { UserService } from './service.js';

const ELEMENT = 'user';
const DEFAULT_SORT: UserListQuery['sort'] = { field: 'name', direction: 'asc' };

const idOf = (req: Request): number => Number(req.params.id);
const actorOf = (req: Request): number => req.user!.id;
const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);

/** Sends a single user with its ETag. */
function sendUser(res: Response, user: UserView, status = 200): void {
  setEtag(res, etagOf(user));
  res.status(status).json({ data: user });
}

/**
 * Creates the handlers of the six /users operations.
 *
 * @param service - Users service.
 */
export function createUsersController(service: UserService) {
  return {
    /** GET /users */
    list: async (req: Request, res: Response): Promise<void> => {
      const page = parsePagination(req.query);
      const sort = parseSort(req.query.sort, req.policy?.sort?.allowed ?? [], DEFAULT_SORT) as UserListQuery['sort'];
      const { data, total } = await service.list({
        q: text(req.query.q),
        role: text(req.query.role) as UserRole | undefined,
        status: text(req.query.status) as UserStatus | undefined,
        sort,
        skip: page.skip,
        take: page.take,
      });
      res.json(paged(data, page, total));
    },
    /** POST /users */
    create: async (req: Request, res: Response): Promise<void> => {
      const user = await service.create(req.body as Parameters<UserService['create']>[0]);
      setLocation(res, '/users', user.id);
      sendUser(res, user, 201);
    },
    /** GET /users/:id */
    get: async (req: Request, res: Response): Promise<void> => {
      sendUser(res, await service.get(idOf(req)));
    },
    /** PUT /users/:id */
    update: async (req: Request, res: Response): Promise<void> => {
      const user = await service.update(
        actorOf(req),
        idOf(req),
        req.body as Parameters<UserService['update']>[2],
        (currentETag) => assertIfMatch(req, ELEMENT, currentETag),
      );
      sendUser(res, user);
    },
    /** DELETE /users/:id */
    deactivate: async (req: Request, res: Response): Promise<void> => {
      await service.deactivate(actorOf(req), idOf(req));
      res.status(204).end();
    },
    /** PUT /users/:id/role */
    changeRole: async (req: Request, res: Response): Promise<void> => {
      sendUser(res, await service.changeRole(idOf(req), (req.body as { role: UserRole }).role));
    },
  };
}
