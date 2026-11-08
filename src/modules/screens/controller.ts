/**
 * HTTP layer of the screens module: reads the request, calls the service and writes status, headers and body.
 * No rules here. Authorization (x-roles) already ran in the middleware generated from the contract.
 *
 * @module modules/screens/controller
 */
import type { Request, Response } from 'express';
import type { DocumentationStatus } from '../../generated/prisma/client.js';
import { assertScreenIfMatch, screenEtagOf, setEtag, setLocation } from '../../http/etag.js';
import { paged, parsePagination, parseSort } from '../../http/pagination.js';
import type { JiraTicketInput, JiraTicketService } from './jiraTickets.js';
import type { JiraTreeService } from './jiraTree.js';
import type { JiraWebhookService } from './jiraWebhook.js';
import type { ScreenListQuery, ScreenView } from './repository.js';
import type { RequestedStatus, ReviewInput, ScreenService } from './service.js';

const ELEMENT = 'screen';
/** `X-Atlassian-Webhook-Identifier` is logged only if it looks like an opaque identifier (at most 100 characters). */
const SAFE_DELIVERY_ID = /^[A-Za-z0-9._:-]{1,100}$/;
const DEFAULT_SORT: ScreenListQuery['sort'] = { field: 'name', direction: 'asc' };

const idOf = (req: Request): number => Number(req.params.id);
const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
/** The request validator may leave a numeric query value as a string or as a number. */
const integer = (value: unknown): number | undefined =>
  typeof value === 'string' || typeof value === 'number' ? Number(value) : undefined;

/** Sends a single screen with its ETag (D-101: `updatedAt` and the two counters the response already carries). */
function sendScreen(res: Response, screen: ScreenView, status = 200): void {
  setEtag(res, screenEtagOf(screen));
  res.status(status).json({ data: screen });
}

/**
 * Creates the handlers of the screens operations that exist so far.
 *
 * @param service - Screens service.
 * @param tickets - Jira tickets service (creation of the "future to do" items).
 * @param tree - Jira tree service (reading, with optional refresh).
 * @param webhook - Jira webhook service (the raw body was already verified by the gate).
 */
export function createScreensController(
  service: ScreenService,
  tickets: JiraTicketService,
  tree: JiraTreeService,
  webhook: JiraWebhookService,
) {
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
    /** GET /screens/:id */
    get: async (req: Request, res: Response): Promise<void> => {
      sendScreen(res, await service.get(idOf(req)));
    },
    /** POST /screens */
    create: async (req: Request, res: Response): Promise<void> => {
      const screen = await service.create(req.user!.id, req.body as Parameters<ScreenService['create']>[1]);
      setLocation(res, '/screens', screen.id);
      sendScreen(res, screen, 201);
    },
    /** PUT /screens/:id */
    update: async (req: Request, res: Response): Promise<void> => {
      const screen = await service.update(
        idOf(req),
        req.body as Parameters<ScreenService['update']>[1],
        (currentETag) => assertScreenIfMatch(req, ELEMENT, currentETag),
      );
      sendScreen(res, screen);
    },
    /** PUT /screens/:id/status */
    changeStatus: async (req: Request, res: Response): Promise<void> => {
      const body = req.body as { status: RequestedStatus };
      const screen = await service.changeStatus(
        { id: req.user!.id, role: req.user!.role },
        idOf(req),
        body.status,
        (currentETag) => assertScreenIfMatch(req, ELEMENT, currentETag),
      );
      sendScreen(res, screen);
    },
    /** POST /screens/:id/review */
    review: async (req: Request, res: Response): Promise<void> => {
      const screen = await service.review(
        { id: req.user!.id, role: req.user!.role },
        idOf(req),
        req.body as ReviewInput,
      );
      sendScreen(res, screen);
    },
    /** POST /screens/:id/jira-ticket (the contract declares no Location or ETag for it) */
    createJiraTicket: async (req: Request, res: Response): Promise<void> => {
      const created = await tickets.create(req.user!.id, idOf(req), req.body as JiraTicketInput);
      res.status(201).json({ data: created });
    },
    /** GET /screens/:id/jira-tickets (the ETag is the weak hash of the body that Express adds, D-72) */
    listJiraTickets: async (req: Request, res: Response): Promise<void> => {
      const raw: unknown = req.query.refresh;
      const refresh = raw === true || raw === 'true';
      res.json({ data: await tree.tree(idOf(req), { refresh }) });
    },
    /** POST /integrations/jira/webhook: always 204 when processed or ignored (Table 53) */
    receiveJiraWebhook: async (req: Request, res: Response): Promise<void> => {
      const identifier = req.get('x-atlassian-webhook-identifier');
      // Only for tracing: logged as a value, and only when it is short and harmless (no log injection).
      const deliveryId = identifier !== undefined && SAFE_DELIVERY_ID.test(identifier) ? identifier : undefined;
      await webhook.receive(req.body as Buffer, deliveryId);
      res.status(204).end();
    },
    /** DELETE /screens/:id */
    remove: async (req: Request, res: Response): Promise<void> => {
      await service.remove(idOf(req));
      res.status(204).end();
    },
  };
}
