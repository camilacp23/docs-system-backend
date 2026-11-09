/**
 * HTTP layer of the audit history: reads the request, calls the service and writes the body. No rules here.
 * Authorization (x-roles) already ran in the middleware generated from the contract; `DEVELOPER_OWN_ACTIONS` is the
 * service's. The ETag is the weak hash of the body that Express adds to every GET, and `If-None-Match` answers 304
 * (D-72); the order of the body is deterministic, so the same data gives the same ETag.
 *
 * @module modules/audit/controller
 */
import type { Request, Response } from 'express';
import { paged, parsePagination } from '../../http/pagination.js';
import type { AuditService } from './service.js';

const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const whole = (value: unknown): number | undefined => (value === undefined ? undefined : Number(value));

/**
 * Creates the handlers of the /audit-log operations.
 *
 * @param service - Audit service.
 */
export function createAuditController(service: AuditService) {
  return {
    /** GET /audit-log */
    list: async (req: Request, res: Response): Promise<void> => {
      const page = parsePagination(req.query);
      const { data, total } = await service.list(req.user!, {
        applicationId: whole(req.query.applicationId),
        entityType: text(req.query.entityType),
        entityId: text(req.query.entityId),
        actorUserId: whole(req.query.actorUserId),
        action: text(req.query.action),
        from: text(req.query.from),
        to: text(req.query.to),
        skip: page.skip,
        take: page.take,
      });
      res.json(paged(data, page, total));
    },
  };
}
