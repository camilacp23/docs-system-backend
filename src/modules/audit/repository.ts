/**
 * Queries of the audit history (Module 8: FR-20, FR-21; SDD Table 6, Tables 39 and 41). Read only: `docs_app` has only
 * SELECT on `audit_log`, and nothing here writes.
 *
 * One list is one snapshot: the total and the page are read in a `REPEATABLE READ` transaction opened `READ ONLY`,
 * one statement after the other on the connection of the transaction (never in parallel), so they agree even if the
 * trigger writes new records in between. Every value reaches PostgreSQL as a bound parameter; the only text composed
 * is the list of conditions, built from constant fragments. The order is `created_at DESC, id DESC`.
 *
 * Indexes (Table 41): `(application_id, created_at)`, `(entity_type, entity_id, created_at)`,
 * `(actor_user_id, created_at)` and `(created_at DESC)`.
 *
 * @module modules/audit/repository
 */
import { Prisma } from '../../generated/prisma/client.js';
import type { Database } from '../../db/prisma.js';
import type { AuditRow } from './representation.js';

/** How many records the recent activity of an application holds (D-106 e). */
export const RECENT_ACTIVITY_LIMIT = 10;

/** The filters of the list, already validated. `from` and `to` are the ISO 8601 text of the request. */
export type AuditFilters = {
  applicationId?: number | undefined;
  entityType?: string | undefined;
  entityId?: string | undefined;
  actorUserId?: number | undefined;
  action?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
};

/** A page of the list and the number of records that match the filters. */
export type AuditPage = { rows: AuditRow[]; total: number };

/** What a read needs from a transaction; the caller of `readRecent` may pass its own. */
export type AuditReadClient = Pick<Prisma.TransactionClient, '$queryRaw'>;

/** Hooks of the repository; production passes none. */
export type AuditHooks = {
  /** Runs inside the snapshot, after the total was read and before the page is (tests only). */
  afterCount?: () => Promise<void>;
};

/** The reads of the audit history. */
export type AuditRepository = {
  /** The total and the page of the records that match `filters`, in one snapshot. */
  readPage(filters: AuditFilters, skip: number, take: number): Promise<AuditPage>;
  /**
   * The newest records of an application. With `client` the read runs in the transaction of the caller (its isolation
   * is the caller's); without it, in a snapshot of its own.
   */
  readRecent(applicationId: number, client?: AuditReadClient): Promise<AuditRow[]>;
};

type Tx = Prisma.TransactionClient;

/** The columns of a record with its actor; the actor is resolved whatever its status (LEFT JOIN, no filter). */
const SELECT_ROW = Prisma.sql`
  SELECT a.id AS "id", a.action AS "action", a.event_name AS "eventName", a.entity_type AS "entityType",
         a.entity_id AS "entityId", a.entity_label AS "entityLabel", a.application_id AS "applicationId",
         a.actor_user_id AS "actorId", u.name AS "actorName", a.db_role AS "dbRole",
         a.changed_fields AS "changedFields", a.old_value AS "oldValue", a.new_value AS "newValue",
         a.created_at AS "createdAt"
    FROM audit_log a
    LEFT JOIN app_user u ON u.id = a.actor_user_id`;

/** The WHERE clause of the filters; each value is a bound parameter. */
function whereOf(filters: AuditFilters): Prisma.Sql {
  const conditions: Prisma.Sql[] = [];
  if (filters.applicationId !== undefined) conditions.push(Prisma.sql`a.application_id = ${filters.applicationId}`);
  if (filters.entityType !== undefined) conditions.push(Prisma.sql`a.entity_type = ${filters.entityType}`);
  if (filters.entityId !== undefined) conditions.push(Prisma.sql`a.entity_id = ${filters.entityId}`);
  if (filters.actorUserId !== undefined) conditions.push(Prisma.sql`a.actor_user_id = ${filters.actorUserId}`);
  if (filters.action !== undefined) conditions.push(Prisma.sql`a.action = ${filters.action}`);
  if (filters.from !== undefined) conditions.push(Prisma.sql`a.created_at >= ${filters.from}::timestamptz`);
  if (filters.to !== undefined) conditions.push(Prisma.sql`a.created_at <= ${filters.to}::timestamptz`);
  return conditions.length === 0 ? Prisma.empty : Prisma.sql`WHERE ${Prisma.join(conditions, ' AND ')}`;
}

/**
 * The statement that counts the records that match `filters`. Exported so a test can ask PostgreSQL for its plan.
 *
 * @param filters - The filters of the list.
 */
export function countStatement(filters: AuditFilters): Prisma.Sql {
  return Prisma.sql`SELECT count(*) AS total FROM audit_log a ${whereOf(filters)}`;
}

/**
 * The statement that reads one page of the list. Exported so a test can ask PostgreSQL for its plan.
 *
 * @param filters - The filters of the list.
 * @param skip - Records to skip.
 * @param take - Records in the page.
 */
export function pageStatement(filters: AuditFilters, skip: number, take: number): Prisma.Sql {
  return Prisma.sql`${SELECT_ROW}
    ${whereOf(filters)}
    ORDER BY a.created_at DESC, a.id DESC
    LIMIT ${take} OFFSET ${skip}`;
}

/** The statement of the recent activity of an application. */
export function recentStatement(applicationId: number): Prisma.Sql {
  return Prisma.sql`${SELECT_ROW}
    WHERE a.application_id = ${applicationId}
    ORDER BY a.created_at DESC, a.id DESC
    LIMIT ${RECENT_ACTIVITY_LIMIT}`;
}

/** The newest `RECENT_ACTIVITY_LIMIT` records of an application, on the given connection. */
function recentOn(client: AuditReadClient, applicationId: number): Promise<AuditRow[]> {
  return client.$queryRaw<AuditRow[]>(recentStatement(applicationId));
}

/**
 * Creates the repository.
 *
 * @param db - Database connected as docs_app (only the plain client is used).
 * @param hooks - Test hooks; omit in production.
 */
export function createAuditRepository(db: Pick<Database, 'base'>, hooks: AuditHooks = {}): AuditRepository {
  /** A snapshot: REPEATABLE READ and READ ONLY. */
  const snapshot = <T>(read: (tx: Tx) => Promise<T>): Promise<T> =>
    db.base.$transaction(
      async (tx) => {
        await tx.$executeRaw`SET TRANSACTION READ ONLY`;
        return read(tx);
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );

  return {
    readPage: (filters, skip, take) =>
      snapshot(async (tx) => {
        const counted = await tx.$queryRaw<{ total: bigint }[]>(countStatement(filters));
        await hooks.afterCount?.();
        const rows = await tx.$queryRaw<AuditRow[]>(pageStatement(filters, skip, take));
        return { rows, total: Number(counted[0]?.total ?? 0n) };
      }),

    readRecent: (applicationId, client) =>
      client === undefined ? snapshot((tx) => recentOn(tx, applicationId)) : recentOn(client, applicationId),
  };
}
