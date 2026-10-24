/**
 * Prisma queries of the screens module. No rules live here (SDD Table 6, D-42). Only the listing exists so far
 * (B-09); the rest of Module 4 is added later.
 *
 * The listing uses one SQL statement because it must order by `pendingSubtasks` (Subtasks whose status category is
 * not DONE, D-14) over ALL the screens of the application before paginating, which Prisma cannot express. The sort
 * column and direction come from fixed maps, never from the request text; every value is a bound parameter.
 *
 * @module modules/screens/repository
 */
import { Prisma, type DocumentationStatus, type PrismaClient } from '../../generated/prisma/client.js';
import { escapeLike } from '../../http/like.js';

/** Clients accepted by the queries: the plain client or the transaction client of `auditedTransaction`. */
export type ScreensClient = Pick<PrismaClient, 'screen' | '$queryRaw'>;

/** A screen as the listing returns it (contract schema `ScreenSummary`). */
export type ScreenSummaryView = {
  id: number;
  applicationId: number;
  name: string;
  isAppContext: boolean;
  documentationStatus: DocumentationStatus;
  author: { id: number; name: string };
  pendingSubtasks: number;
  commentCount: number;
  createdAt: Date;
  updatedAt: Date;
};

/** The columns of a screen that other modules need to validate a reference to it. */
export type ScreenRef = { id: number; name: string; applicationId: number; isAppContext: boolean };

/** Fields the contract allows in `sort` of `GET /screens`. */
export type ScreenSortField = 'name' | 'documentationStatus' | 'updatedAt' | 'pendingSubtasks';

/** Filters, order and page of `GET /screens`. The App (OnStart) screen is always first; `id` breaks ties. */
export type ScreenListQuery = {
  applicationId: number;
  q?: string | undefined;
  documentationStatus?: DocumentationStatus | undefined;
  authorId?: number | undefined;
  sort: { field: ScreenSortField; direction: 'asc' | 'desc' };
  skip: number;
  take: number;
};

const SORT_COLUMN: Readonly<Record<ScreenSortField, Prisma.Sql>> = {
  name: Prisma.raw('s.name'),
  documentationStatus: Prisma.raw('s.documentation_status'),
  updatedAt: Prisma.raw('s.updated_at'),
  pendingSubtasks: Prisma.raw('pending_subtasks'),
};

type Row = {
  id: number;
  application_id: number;
  name: string;
  is_app_context: boolean;
  documentation_status: DocumentationStatus;
  author_id: number;
  author_name: string;
  pending_subtasks: number;
  comment_count: number;
  created_at: Date;
  updated_at: Date;
};

const toView = (r: Row): ScreenSummaryView => ({
  id: r.id,
  applicationId: r.application_id,
  name: r.name,
  isAppContext: r.is_app_context,
  documentationStatus: r.documentation_status,
  author: { id: r.author_id, name: r.author_name },
  pendingSubtasks: r.pending_subtasks,
  commentCount: r.comment_count,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

/** A page of screens of one application and the total that matches the filters. */
export async function listScreens(
  client: Pick<ScreensClient, '$queryRaw'>,
  query: ScreenListQuery,
): Promise<[ScreenSummaryView[], number]> {
  const conditions: Prisma.Sql[] = [Prisma.sql`s.application_id = ${query.applicationId}`];
  if (query.q !== undefined) conditions.push(Prisma.sql`s.name ILIKE ${`%${escapeLike(query.q)}%`}`);
  if (query.documentationStatus !== undefined) {
    conditions.push(Prisma.sql`s.documentation_status = ${query.documentationStatus}::documentation_status`);
  }
  if (query.authorId !== undefined) conditions.push(Prisma.sql`s.author_id = ${query.authorId}`);
  const where = Prisma.join(conditions, ' AND ');
  const direction = Prisma.raw(query.sort.direction === 'desc' ? 'DESC' : 'ASC');

  const [rows, count] = await Promise.all([
    client.$queryRaw<Row[]>`
      SELECT s.id, s.application_id, s.name, s.is_app_context, s.documentation_status, s.author_id,
             u.name AS author_name, s.created_at, s.updated_at,
             (SELECT count(*)::int FROM jira_ticket j
               WHERE j.screen_id = s.id AND j.hierarchy_level = 'SUBTASK' AND j.status_category <> 'DONE')
               AS pending_subtasks,
             (SELECT count(*)::int FROM comment c WHERE c.screen_id = s.id) AS comment_count
        FROM screen s
        JOIN app_user u ON u.id = s.author_id
       WHERE ${where}
       ORDER BY s.is_app_context DESC, ${SORT_COLUMN[query.sort.field]} ${direction}, s.id ASC
       LIMIT ${query.take} OFFSET ${query.skip}`,
    client.$queryRaw<{ total: number }[]>`SELECT count(*)::int AS total FROM screen s WHERE ${where}`,
  ]);
  return [rows.map(toView), count[0]?.total ?? 0];
}

/** Reads the columns of a screen that other modules validate (existence, application, App (OnStart) flag). */
export async function findScreenRef(client: Pick<PrismaClient, 'screen'>, id: number): Promise<ScreenRef | null> {
  return client.screen.findUnique({
    where: { id },
    select: { id: true, name: true, applicationId: true, isAppContext: true },
  });
}
