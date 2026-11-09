/**
 * Queries of the indicator dashboard (Module 7: FR-19; SDD Table 6, Table 41). Read only: nothing here writes.
 *
 * One read is one snapshot: a `REPEATABLE READ` transaction opened `READ ONLY`, one statement after the other on the
 * connection of the transaction (never in parallel). The indicators are ONE statement: it starts from the application
 * (no row means it does not exist) and adds the counts of screens, variables, collections and Jira tickets with
 * `count(*) FILTER`, one lateral subquery per table, so each table is read once. The recent activity is read by the
 * audit service on the client of the same transaction (`snapshot.client`), so the figures and the activity agree.
 *
 * Indexes (Table 41): `screen (application_id, documentation_status)`, `variable (application_id)`,
 * `screen_collection (collection_id)`, `jira_ticket (screen_id, hierarchy_level, status_category)`.
 *
 * @module modules/dashboard/repository
 */
import { Prisma } from '../../generated/prisma/client.js';
import type { Database } from '../../db/prisma.js';
import type { IndicatorRow } from './representation.js';

/** What a snapshot lets the service do: read the indicators, and hand its client to another service's read. */
export type DashboardSnapshot = {
  /** The counts of an application, or `null` when it does not exist. */
  indicators(applicationId: number): Promise<IndicatorRow | null>;
  /** The client of the transaction, for the recent activity that the audit service reads. */
  client: Pick<Prisma.TransactionClient, '$queryRaw'>;
};

/** Hooks of the repository; production passes none. */
export type DashboardHooks = {
  /** Runs inside the snapshot, after the indicators were read and before anything else is (tests only). */
  afterIndicators?: () => Promise<void>;
};

/** The reads of the dashboard. */
export type DashboardRepository = {
  /** Runs `work` in one snapshot: `REPEATABLE READ`, `READ ONLY`. */
  inSnapshot<T>(work: (snapshot: DashboardSnapshot) => Promise<T>): Promise<T>;
};

/** The columns the statement returns (counts are cast to `int`, so Prisma gives numbers). */
type Row = {
  undocumented: number;
  draft: number;
  inProgress: number;
  inReview: number;
  approved: number;
  variablesTotal: number;
  variablesUntraced: number;
  collectionsTotal: number;
  collectionsUndocumented: number;
  pendingSubtasks: number;
  lastSyncedAt: Date | null;
};

/**
 * The statement of the indicators of an application. Exported so a test can ask PostgreSQL for its plan.
 *
 * @param applicationId - The application.
 */
export function indicatorsStatement(applicationId: number): Prisma.Sql {
  return Prisma.sql`
    SELECT s.undocumented, s.draft, s.in_progress AS "inProgress", s.in_review AS "inReview", s.approved,
           v.total AS "variablesTotal", v.untraced AS "variablesUntraced",
           c.total AS "collectionsTotal", c.undocumented AS "collectionsUndocumented",
           j.pending AS "pendingSubtasks", j.last_synced AS "lastSyncedAt"
      FROM application a
     CROSS JOIN LATERAL (
           SELECT count(*) FILTER (WHERE documentation_status = 'UNDOCUMENTED')::int AS undocumented,
                  count(*) FILTER (WHERE documentation_status = 'DRAFT')::int AS draft,
                  count(*) FILTER (WHERE documentation_status = 'IN_PROGRESS')::int AS in_progress,
                  count(*) FILTER (WHERE documentation_status = 'IN_REVIEW')::int AS in_review,
                  count(*) FILTER (WHERE documentation_status = 'APPROVED')::int AS approved
             FROM screen WHERE application_id = a.id) s
     CROSS JOIN LATERAL (
           SELECT count(*)::int AS total,
                  count(*) FILTER (WHERE origin_screen_id IS NULL)::int AS untraced
             FROM variable WHERE application_id = a.id) v
     CROSS JOIN LATERAL (
           SELECT count(*)::int AS total,
                  count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM screen_collection sc WHERE sc.collection_id = col.id))::int
                    AS undocumented
             FROM collection col WHERE col.application_id = a.id) c
     CROSS JOIN LATERAL (
           SELECT count(*) FILTER (WHERE t.hierarchy_level = 'SUBTASK' AND t.status_category <> 'DONE')::int AS pending,
                  max(t.last_synced_at) AS last_synced
             FROM jira_ticket t JOIN screen sc ON sc.id = t.screen_id WHERE sc.application_id = a.id) j
     WHERE a.id = ${applicationId}`;
}

/** The statement's row as the counts of the contract. */
function toIndicatorRow(row: Row): IndicatorRow {
  return {
    byStatus: {
      UNDOCUMENTED: row.undocumented,
      DRAFT: row.draft,
      IN_PROGRESS: row.inProgress,
      IN_REVIEW: row.inReview,
      APPROVED: row.approved,
    },
    variablesTotal: row.variablesTotal,
    variablesUntraced: row.variablesUntraced,
    collectionsTotal: row.collectionsTotal,
    collectionsUndocumented: row.collectionsUndocumented,
    pendingSubtasks: row.pendingSubtasks,
    lastSyncedAt: row.lastSyncedAt,
  };
}

/**
 * Creates the repository.
 *
 * @param db - Database connected as docs_app (only the plain client is used).
 * @param hooks - Test hooks; omit in production.
 */
export function createDashboardRepository(db: Pick<Database, 'base'>, hooks: DashboardHooks = {}): DashboardRepository {
  return {
    inSnapshot: (work) =>
      db.base.$transaction(
        async (tx) => {
          await tx.$executeRaw`SET TRANSACTION READ ONLY`;
          return work({
            client: tx,
            indicators: async (applicationId) => {
              const rows = await tx.$queryRaw<Row[]>(indicatorsStatement(applicationId));
              await hooks.afterIndicators?.();
              return rows[0] === undefined ? null : toIndicatorRow(rows[0]);
            },
          });
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
      ),
  };
}
