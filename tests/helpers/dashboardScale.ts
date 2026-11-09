/**
 * Bulk data and measurements for the dashboard at the scale of a department (the light test in `npm test` and the
 * performance test in `npm run test:perf` share them). The data is inserted with a few statements on the owner
 * connection of the disposable database; the audit records are written by the trigger (the inserts themselves and some
 * updates of audited rows), never by hand.
 */
import assert from 'node:assert/strict';
import { Prisma } from '../../src/generated/prisma/client.js';
import { indicatorsStatement } from '../../src/modules/dashboard/repository.js';
import type { TestApp } from './app.js';
import { indicatorsOk } from './dashboard.js';

/** How much to insert. Tickets come in groups of seven: an Epic, a Story and five Subtasks. */
export type DashboardScale = {
  screens: number;
  variables: number;
  collections: number;
  tickets: number;
  /** The audit table is topped up with updates of the variables until it holds at least this many records. */
  auditRecords: number;
};

/** The size of the performance test: about the figures of a department. */
export const FULL_SCALE: DashboardScale = {
  screens: 500,
  variables: 1000,
  collections: 300,
  tickets: 2000,
  auditRecords: 5000,
};

/** A light version for `npm test`. */
export const LIGHT_SCALE: DashboardScale = {
  screens: 60,
  variables: 120,
  collections: 40,
  tickets: 210,
  auditRecords: 600,
};

const STATUSES = "ARRAY['UNDOCUMENTED','DRAFT','IN_PROGRESS','IN_REVIEW','APPROVED']";
const CATEGORIES = "ARRAY['TO_DO','IN_PROGRESS','DONE']";

/** What the data holds, computed by the generator and checked against the database. */
export type DashboardTruth = {
  screens: number;
  approved: number;
  variables: number;
  untraced: number;
  collections: number;
  undocumented: number;
  pendingSubtasks: number;
  auditRecords: number;
};

/**
 * Inserts the data in an existing application, in one transaction.
 *
 * @param t - The test app (its owner connection and admin user are used).
 * @param applicationId - An existing application (its App (OnStart) screen exists).
 * @param size - How much to insert.
 */
export async function loadDashboardData(
  t: Pick<TestApp, 'owner' | 'users'>,
  applicationId: number,
  size: DashboardScale,
): Promise<DashboardTruth> {
  const author = t.users.admin.id;
  await t.owner.query('BEGIN');
  try {
    await t.owner.query(
      `WITH e AS (INSERT INTO documented_element (type, application_id)
                  SELECT 'SCREEN'::element_type, $1::int FROM generate_series(1, $2::int) RETURNING id)
       INSERT INTO screen (id, application_id, name, author_id, documentation_status)
       SELECT id, $1::int, 'Perf screen ' || id, $3::int, (${STATUSES})[1 + id % 5]::documentation_status FROM e`,
      [applicationId, size.screens, author],
    );
    const screenIds = (
      await t.owner.query<{ id: number }>(
        `SELECT id FROM screen WHERE application_id = $1 AND NOT is_app_context ORDER BY id`,
        [applicationId],
      )
    ).rows.map((r) => r.id);
    await t.owner.query(
      `WITH e AS (INSERT INTO documented_element (type, application_id)
                  SELECT 'VARIABLE'::element_type, $1::int FROM generate_series(1, $2::int) RETURNING id),
            v AS (INSERT INTO variable (id, application_id, name, data_type, scope, origin_screen_id)
                  SELECT id, $1::int, 'gPerf' || id, 'TEXT'::data_type, 'GLOBAL'::variable_scope,
                         CASE WHEN id % 3 = 0 THEN NULL ELSE ($3::int[])[1 + id % cardinality($3::int[])] END
                    FROM e RETURNING id)
       INSERT INTO element_environment (element_id, element_type, environment)
       SELECT id, 'VARIABLE'::element_type, 'DEV'::environment FROM v`,
      [applicationId, size.variables, screenIds],
    );
    await t.owner.query(
      `WITH e AS (INSERT INTO documented_element (type, application_id)
                  SELECT 'COLLECTION'::element_type, $1::int FROM generate_series(1, $2::int) RETURNING id),
            c AS (INSERT INTO collection (id, application_id, name)
                  SELECT id, $1::int, 'colPerf' || id FROM e RETURNING id)
       INSERT INTO element_environment (element_id, element_type, environment)
       SELECT id, 'COLLECTION'::element_type, 'DEV'::environment FROM c`,
      [applicationId, size.collections],
    );
    // Half of the collections are linked to a screen.
    await t.owner.query(
      `INSERT INTO screen_collection (screen_id, collection_id, access_mode, used_in)
       SELECT ($2::int[])[1 + c.id % cardinality($2::int[])], c.id, 'READ'::access_mode, 'perf'
         FROM collection c WHERE c.application_id = $1 AND c.id % 2 = 0`,
      [applicationId, screenIds],
    );
    const groups = Math.floor(size.tickets / 7);
    assert.ok(groups <= screenIds.length, 'one Epic per screen');
    const columns = `screen_id, jira_issue_id, jira_issue_key, hierarchy_level, issue_type, parent_ticket_id, parent_level,
                     summary, status, status_category, created_by`;
    await t.owner.query(
      `INSERT INTO jira_ticket (${columns})
       SELECT s.id, 'E' || s.id, 'PERF-' || s.id, 'EPIC'::jira_hierarchy_level, 'Epic', NULL, NULL, 'Epic', 'To Do',
              'TO_DO'::jira_status_category, $3::int
         FROM screen s WHERE s.application_id = $1::int AND s.id = ANY(($2::int[])[1:$4::int])`,
      [applicationId, screenIds, author, groups],
    );
    await t.owner.query(
      `INSERT INTO jira_ticket (${columns})
       SELECT e.screen_id, 'S' || e.id, 'PERF-' || (100000 + e.id), 'STANDARD'::jira_hierarchy_level, 'Story', e.id,
              'EPIC'::jira_hierarchy_level, 'Story', 'To Do', 'TO_DO'::jira_status_category, $2::int
         FROM jira_ticket e JOIN screen s ON s.id = e.screen_id
        WHERE s.application_id = $1 AND e.hierarchy_level = 'EPIC'`,
      [applicationId, author],
    );
    await t.owner.query(
      `INSERT INTO jira_ticket (${columns})
       SELECT st.screen_id, 'T' || st.id || 'x' || k, 'PERF-' || (1000000 + st.id * 10 + k), 'SUBTASK'::jira_hierarchy_level,
              'Subtask', st.id, 'STANDARD'::jira_hierarchy_level, 'Subtask', 'Status',
              (${CATEGORIES})[1 + (st.id + k) % 3]::jira_status_category, $2::int
         FROM jira_ticket st CROSS JOIN generate_series(1, 5) k JOIN screen s ON s.id = st.screen_id
        WHERE s.application_id = $1 AND st.hierarchy_level = 'STANDARD'`,
      [applicationId, author],
    );
    await t.owner.query('COMMIT');
  } catch (error) {
    await t.owner.query('ROLLBACK');
    throw error;
  }
  // Top up the audit table with updates of audited rows (the trigger writes the records).
  for (let round = 0; (await auditCount(t, applicationId)) < size.auditRecords; round += 1) {
    await t.owner.query(`UPDATE variable SET description = $2 WHERE application_id = $1`, [
      applicationId,
      `round ${round}`,
    ]);
  }
  const one = async (sql: string): Promise<number> =>
    Number((await t.owner.query<{ n: string }>(sql, [applicationId])).rows[0]!.n);
  return {
    screens: await one(`SELECT count(*) AS n FROM screen WHERE application_id = $1`),
    approved: await one(
      `SELECT count(*) AS n FROM screen WHERE application_id = $1 AND documentation_status = 'APPROVED'`,
    ),
    variables: await one(`SELECT count(*) AS n FROM variable WHERE application_id = $1`),
    untraced: await one(`SELECT count(*) AS n FROM variable WHERE application_id = $1 AND origin_screen_id IS NULL`),
    collections: await one(`SELECT count(*) AS n FROM collection WHERE application_id = $1`),
    undocumented: await one(
      `SELECT count(*) AS n FROM collection c WHERE c.application_id = $1
          AND NOT EXISTS (SELECT 1 FROM screen_collection sc WHERE sc.collection_id = c.id)`,
    ),
    pendingSubtasks: await one(
      `SELECT count(*) AS n FROM jira_ticket t JOIN screen s ON s.id = t.screen_id
        WHERE s.application_id = $1 AND t.hierarchy_level = 'SUBTASK' AND t.status_category <> 'DONE'`,
    ),
    auditRecords: await auditCount(t, applicationId),
  };
}

async function auditCount(t: Pick<TestApp, 'owner'>, applicationId: number): Promise<number> {
  const r = await t.owner.query<{ n: string }>(`SELECT count(*) AS n FROM audit_log WHERE application_id = $1`, [
    applicationId,
  ]);
  return Number(r.rows[0]!.n);
}

/** The median of a list of numbers. */
export const median = (values: number[]): number => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;

/** `median / min / max` of a list of milliseconds, as text. */
export const stats = (values: number[]): string =>
  `median ${median(values).toFixed(1)} ms, min ${Math.min(...values).toFixed(1)} ms, max ${Math.max(...values).toFixed(1)} ms`;

type PlanNode = Record<string, unknown> & { Plans?: PlanNode[] };

/** One line per node of a JSON plan: the node, the relation or index it reads and the rows it produced. */
export function summarizePlan(node: PlanNode, depth = 0): string[] {
  const target = node['Index Name'] ?? node['Relation Name'];
  const on = typeof target === 'string' ? ` on ${target}` : '';
  const line = `${'  '.repeat(depth)}${String(node['Node Type'])}${on} (rows ${String(node['Actual Rows'])})`;
  return [line, ...(node.Plans ?? []).flatMap((child) => summarizePlan(child, depth + 1))];
}

/** Milliseconds one call takes. */
async function timed(run: () => Promise<unknown>): Promise<number> {
  const start = process.hrtime.bigint();
  await run();
  return Number(process.hrtime.bigint() - start) / 1e6;
}

/**
 * The five statements one per table that the single statement of the repository replaces. Used only to measure the
 * difference; production runs the single statement.
 */
export const separateStatements = (applicationId: number): Prisma.Sql[] => [
  Prisma.sql`SELECT id FROM application WHERE id = ${applicationId}`,
  Prisma.sql`SELECT documentation_status, count(*)::int AS n FROM screen WHERE application_id = ${applicationId} GROUP BY 1`,
  Prisma.sql`SELECT count(*)::int AS total, count(*) FILTER (WHERE origin_screen_id IS NULL)::int AS untraced
               FROM variable WHERE application_id = ${applicationId}`,
  Prisma.sql`SELECT count(*)::int AS total,
                    count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM screen_collection sc WHERE sc.collection_id = c.id))::int AS undocumented
               FROM collection c WHERE c.application_id = ${applicationId}`,
  Prisma.sql`SELECT count(*) FILTER (WHERE t.hierarchy_level = 'SUBTASK' AND t.status_category <> 'DONE')::int AS pending,
                    max(t.last_synced_at) AS last_synced
               FROM jira_ticket t JOIN screen s ON s.id = t.screen_id WHERE s.application_id = ${applicationId}`,
];

/**
 * Reads the endpoint and the statements `reads` times, checks the figures against the truth and prints a summary
 * (median, minimum and maximum, the plan, and one statement against five). No time threshold is asserted.
 *
 * @param t - The test app.
 * @param applicationId - The application with the data.
 * @param truth - What the data holds.
 * @param reads - How many times each measurement is repeated.
 * @param label - Prefix of the printed lines.
 */
export async function measureDashboard(
  t: TestApp,
  applicationId: number,
  truth: DashboardTruth,
  reads: number,
  label: string,
): Promise<void> {
  const out = (line: string): void => console.log(`${label} ${line}`);
  const sizes = `${truth.screens} screens, ${truth.variables} variables, ${truth.collections} collections, ${truth.pendingSubtasks} pending Subtasks, ${truth.auditRecords} audit records`;
  out(`data: ${sizes}`);

  // The figures are exact and every role conforms to the contract.
  for (const token of [t.users.admin.token, t.users.developer.token, t.users.reader.token]) {
    const data = await indicatorsOk(t, applicationId, token);
    assert.equal(data.documentation.totalScreens, truth.screens + 0);
    assert.equal(data.documentation.byStatus.APPROVED, truth.approved);
    assert.deepEqual(data.variables, { total: truth.variables, untraced: truth.untraced });
    assert.deepEqual(data.collections, { total: truth.collections, undocumented: truth.undocumented });
    assert.equal(data.jira.pendingSubtasks, truth.pendingSubtasks);
  }

  for (const [role, token] of [
    ['administrator (indicators + 10 records)', t.users.admin.token],
    ['reader (indicators only)', t.users.reader.token],
  ] as const) {
    const times: number[] = [];
    for (let i = 0; i < reads; i += 1) times.push(await timed(() => indicatorsOk(t, applicationId, token)));
    out(`GET /dashboard/indicators as ${role}: ${stats(times)} (${reads} reads, with the contract check)`);
  }

  // One statement against five, in the same kind of snapshot the repository uses.
  const inSnapshot = <T>(work: (tx: Prisma.TransactionClient) => Promise<T>) =>
    t.db.base.$transaction(
      async (tx) => {
        await tx.$executeRaw`SET TRANSACTION READ ONLY`;
        return work(tx);
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  const one: number[] = [];
  const five: number[] = [];
  for (let i = 0; i < reads * 2; i += 1) {
    one.push(await timed(() => inSnapshot((tx) => tx.$queryRaw(indicatorsStatement(applicationId)))));
    five.push(
      await timed(() =>
        inSnapshot(async (tx) => {
          for (const statement of separateStatements(applicationId)) await tx.$queryRaw(statement);
        }),
      ),
    );
  }
  out(`1 statement:  ${stats(one)} (whole snapshot, ${reads * 2} reads)`);
  out(`5 statements: ${stats(five)} (whole snapshot, ${reads * 2} reads)`);

  const statement = indicatorsStatement(applicationId);
  const rows = await t.db.base.$queryRawUnsafe<{ 'QUERY PLAN': { Plan: PlanNode; 'Execution Time': number }[] }[]>(
    `EXPLAIN (ANALYZE, FORMAT JSON) ${statement.text}`,
    ...statement.values,
  );
  const plan = rows[0]!['QUERY PLAN'][0]!;
  out(`EXPLAIN of the indicators statement (execution ${plan['Execution Time'].toFixed(2)} ms):`);
  for (const line of summarizePlan(plan.Plan)) out(`  ${line}`);
}
