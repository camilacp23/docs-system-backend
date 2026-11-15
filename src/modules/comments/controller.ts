/**
 * HTTP layer of the comments module: reads the request, calls the service and writes status, headers and body.
 * No rules here. Authorization (x-roles) already ran in the middleware generated from the contract.
 *
 * @module modules/comments/controller
 */
import type { Request, Response } from 'express';
import { assertIfMatch, commentEtagOf, setEtag } from '../../http/etag.js';
import { paged, parsePagination } from '../../http/pagination.js';
import type { CommentView } from './repository.js';
import type { CommentService } from './service.js';

const ELEMENT = 'comment';
const idOf = (req: Request): number => Number(req.params.id);
const textOf = (req: Request): string => (req.body as { text: string }).text;

/** Sends a single comment with its ETag (D-123). */
function sendComment(res: Response, comment: CommentView, status: number): void {
  setEtag(res, commentEtagOf(comment));
  res.status(status).json({ data: comment });
}

/**
 * Creates the handlers of the comments operations.
 *
 * @param service - Comments service.
 */
export function createCommentsController(service: CommentService) {
  return {
    /** GET /screens/:id/comments (the ETag is the weak hash of the body that Express adds, D-72) */
    list: async (req: Request, res: Response): Promise<void> => {
      const page = parsePagination(req.query);
      const { data, total } = await service.list(idOf(req), { skip: page.skip, take: page.take });
      res.json(paged(data, page, total));
    },
    /** POST /screens/:id/comments: 201 with the ETag and, by exception (D-123), without Location */
    create: async (req: Request, res: Response): Promise<void> => {
      sendComment(res, await service.create(req.user!.id, idOf(req), textOf(req)), 201);
    },
    /** PUT /comments/:id */
    update: async (req: Request, res: Response): Promise<void> => {
      const comment = await service.update(req.user!.id, idOf(req), textOf(req), (currentETag) =>
        assertIfMatch(req, ELEMENT, currentETag),
      );
      sendComment(res, comment, 200);
    },
  };
}
