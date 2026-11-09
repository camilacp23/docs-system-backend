/**
 * Module 6, department scale (NFR-10, D-22): one application of about 2000 elements whose screens carry long templates
 * (about 5 KB per field). The test measures four searches end to end (median, minimum and maximum of several reads) and
 * prints a summary of the plan PostgreSQL chooses. It asserts no time threshold (a threshold would make it flaky on a
 * busy machine); it checks the size of the data, the contract and that the answers make sense.
 */
import '../helpers/env.js';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { Prisma } from '../../src/generated/prisma/client.js';
import { startTestApp, type TestApp } from '../helpers/app.js';
import { insertApplication } from '../helpers/fixtures.js';
import { countStatement, pageStatement, type SearchFilters } from '../../src/modules/search/repository.js';
import { normalizeText } from '../../src/modules/search/text.js';
import { searchOk, type SearchBody } from '../helpers/search.js';

const SCREENS = 500;
const VARIABLES = 600;
const COLLECTIONS = 400;
const COMPONENTS = 500;
const FIELDS_PER_COLLECTION = 3;
const LINKS = 800;
const READS = 7;

/** About 5 KB of text, with the common word at the very end so that a scan has to read all of it for 1 of 5 rows. */
const LONG_TEXT = (salt: string) =>
  `repeat('lorem ipsum dolor sit amet ', 180) || '${salt}' || CASE WHEN id % 5 = 0 THEN ' filtro de busqueda' ELSE '' END`;

const median = (values: number[]): number => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;

type PlanNode = { 'Node Type': string; 'Relation Name'?: string; 'Actual Total Time'?: number; Plans?: PlanNode[] };

/** The scans and joins of a plan, one line each, with the time of each node. */
function summarize(node: PlanNode, depth = 0, lines: string[] = []): string[] {
  const interesting = /Scan|Join|Sort|Aggregate|Limit|Unique|Append|Hash$/.test(node['Node Type']);
  if (interesting) {
    const relation = node['Relation Name'] === undefined ? '' : ` on ${node['Relation Name']}`;
    lines.push(`${'  '.repeat(depth)}${node['Node Type']}${relation} (${node['Actual Total Time']?.toFixed(1)} ms)`);
  }
  for (const child of node.Plans ?? []) summarize(child, depth + (interesting ? 1 : 0), lines);
  return lines;
}

describe('search: about 2000 elements with long templates', () => {
  let t: TestApp;
  let applicationId: number;

  before(async () => {
    t = await startTestApp();
    try {
      applicationId = (await insertApplication(t, { name: 'Performance app' })).id;
      const adminId = t.users.admin.id;
      await t.owner.query('BEGIN');
      try {
        const text = LONG_TEXT('');
        await t.owner.query(
          `WITH ins AS (INSERT INTO documented_element (type, application_id)
                        SELECT 'SCREEN'::element_type, $1 FROM generate_series(1, $2::int) RETURNING id)
           INSERT INTO screen (id, application_id, name, author_id, documentation_status,
                               on_start, working_process, architecture, data_model, requirements, known_issues, risks)
           SELECT id, $1, 'perfScreen' || id, $3,
                  (ARRAY['UNDOCUMENTED','DRAFT','IN_PROGRESS','IN_REVIEW','APPROVED'])[1 + id % 5]::documentation_status,
                  ${LONG_TEXT('a')}, ${LONG_TEXT('b')}, ${LONG_TEXT('c')}, ${LONG_TEXT('d')},
                  ${LONG_TEXT('e')}, ${LONG_TEXT('f')}, ${text}
             FROM ins`,
          [applicationId, SCREENS, adminId],
        );
        await t.owner.query(
          `WITH ins AS (INSERT INTO documented_element (type, application_id)
                        SELECT 'VARIABLE'::element_type, $1 FROM generate_series(1, $2::int) RETURNING id),
                v AS (INSERT INTO variable (id, application_id, name, data_type, scope, description)
                      SELECT id, $1, 'gPerf' || id, 'TEXT', 'GLOBAL',
                             repeat('variable description ', 40) || CASE WHEN id % 4 = 0 THEN 'filtro' ELSE '' END
                        FROM ins RETURNING id)
           INSERT INTO element_environment (element_id, element_type, environment)
           SELECT id, 'VARIABLE'::element_type, 'DEV'::environment FROM v
           UNION ALL SELECT id, 'VARIABLE'::element_type, 'PROD'::environment FROM v WHERE id % 2 = 0`,
          [applicationId, VARIABLES],
        );
        await t.owner.query(
          `WITH ins AS (INSERT INTO documented_element (type, application_id)
                        SELECT 'COLLECTION'::element_type, $1 FROM generate_series(1, $2::int) RETURNING id),
                c AS (INSERT INTO collection (id, application_id, name, creation_condition, description)
                      SELECT id, $1, 'colPerf' || id, 'OnStart: ClearCollect(colPerf, Table)',
                             repeat('collection description ', 40) || CASE WHEN id % 4 = 0 THEN 'filtro' ELSE '' END
                        FROM ins RETURNING id),
                f AS (INSERT INTO collection_field (collection_id, name, data_type, position)
                      SELECT c.id, 'field' || g, 'TEXT', g FROM c CROSS JOIN generate_series(1, $3::int) g)
           INSERT INTO element_environment (element_id, element_type, environment)
           SELECT id, 'COLLECTION'::element_type, 'DEV'::environment FROM c`,
          [applicationId, COLLECTIONS, FIELDS_PER_COLLECTION],
        );
        const screens = (
          await t.owner.query<{ id: number }>(`SELECT id FROM screen WHERE application_id = $1 ORDER BY id`, [
            applicationId,
          ])
        ).rows.map((r) => r.id);
        await t.owner.query(
          `WITH ins AS (INSERT INTO documented_element (type, application_id)
                        SELECT 'COMPONENT'::element_type, $1 FROM generate_series(1, $2::int) RETURNING id)
           INSERT INTO component (id, application_id, screen_id, name, type, on_select, description)
           SELECT id, $1, ($3::int[])[1 + id % cardinality($3::int[])], 'cmpPerf' || id, 'Button',
                  'Filter(colPerf, Active = true) ' || repeat('x', 200),
                  repeat('component description ', 20) || CASE WHEN id % 4 = 0 THEN 'filtro' ELSE '' END
             FROM ins`,
          [applicationId, COMPONENTS, screens],
        );
        const variables = (
          await t.owner.query<{ id: number }>(`SELECT id FROM variable WHERE application_id = $1 ORDER BY id`, [
            applicationId,
          ])
        ).rows.map((r) => r.id);
        await t.owner.query(
          `INSERT INTO screen_variable (screen_id, variable_id, access_mode, used_in)
           SELECT ($1::int[])[1 + n % cardinality($1::int[])], ($2::int[])[1 + n % cardinality($2::int[])],
                  'READ', 'perf link ' || n
             FROM generate_series(1, $3::int) n`,
          [screens, variables, LINKS],
        );
        await t.owner.query('COMMIT');
      } catch (error) {
        await t.owner.query('ROLLBACK');
        throw error;
      }
      await t.owner.query('ANALYZE');
    } catch (error) {
      await t.close();
      throw error;
    }
  });
  after(async () => {
    await t.close();
  });

  /** Reads the search `READS` times and returns the first body and the times in milliseconds. */
  async function measure(params: Record<string, string | number>): Promise<{ body: SearchBody; ms: number[] }> {
    const ms: number[] = [];
    let body: SearchBody | undefined;
    for (let i = 0; i < READS; i += 1) {
      const started = performance.now();
      const current = await searchOk(t, { applicationId, ...params });
      ms.push(performance.now() - started);
      body ??= current;
    }
    return { body: body!, ms };
  }
  const report = (label: string, total: number, ms: number[]): void => {
    console.log(
      `PERF search ${label}: total=${total}, median=${median(ms).toFixed(1)} ms, min=${Math.min(...ms).toFixed(1)} ms, max=${Math.max(...ms).toFixed(1)} ms (${ms.length} reads)`,
    );
  };

  it('has about 2000 elements and templates of about 5 KB per field', async () => {
    const counts = await t.owner.query<{ n: string }>(
      `SELECT count(*) AS n FROM documented_element WHERE application_id = $1`,
      [applicationId],
    );
    const size = await t.owner.query<{ avg: string }>(
      `SELECT avg(length(on_start))::int AS avg FROM screen WHERE application_id = $1 AND NOT is_app_context`,
      [applicationId],
    );
    console.log(
      `PERF search data: ${counts.rows[0]!.n} elements, ${SCREENS} screens with 7 template fields of about ${size.rows[0]!.avg} characters each, ${LINKS} links`,
    );
    assert.ok(Number(counts.rows[0]!.n) >= 2000);
    assert.ok(Number(size.rows[0]!.avg) >= 4500);
  });

  it('a common text', async () => {
    const { body, ms } = await measure({ q: 'filtro' });
    report('common text "filtro"', body.total, ms);
    assert.ok(body.total > 100);
    assert.ok(body.data.length > 0);
  });

  it('a text that finds nothing', async () => {
    const { body, ms } = await measure({ q: 'zzqxjk' });
    report('text without results', body.total, ms);
    assert.equal(body.total, 0);
  });

  it('filters only', async () => {
    const { body, ms } = await measure({ types: 'VARIABLE,COLLECTION', environment: 'PROD' });
    report('filters only (types + environment)', body.total, ms);
    assert.equal(body.total, VARIABLES / 2);
  });

  it('a high page of a text that matches almost everything', async () => {
    const first = await searchOk(t, { applicationId, q: 'lorem', pageSize: 20 });
    const lastPage = Math.ceil(first.total / 20);
    const { body, ms } = await measure({ q: 'lorem', pageSize: 20, page: lastPage });
    report(`high page ${lastPage} of text "lorem"`, body.total, ms);
    assert.ok(body.data.length > 0 && body.page === lastPage);
  });

  it('the plan of the count and of the page, summarized', async () => {
    const filters: SearchFilters = {
      applicationId,
      query: normalizeText('filtro'),
      types: ['SCREEN', 'VARIABLE', 'COLLECTION', 'COMPONENT'],
    };
    for (const [label, statement] of [
      ['count', countStatement(filters)],
      ['page', pageStatement(filters, 0, 20)],
    ] as const) {
      const rows = await t.db.base.$queryRawUnsafe<{ 'QUERY PLAN': { Plan: PlanNode; 'Execution Time': number }[] }[]>(
        `EXPLAIN (ANALYZE, FORMAT JSON) ${statement.text}`,
        ...statement.values,
      );
      const plan = rows[0]!['QUERY PLAN'][0]!;
      console.log(`PERF search EXPLAIN ${label} (execution ${plan['Execution Time'].toFixed(1)} ms):`);
      for (const line of summarize(plan.Plan)) console.log(`PERF   ${line}`);
    }
  });

  it('two statements (count, then page) against one statement with count(*) OVER (), in one snapshot', async () => {
    const all = ['SCREEN', 'VARIABLE', 'COLLECTION', 'COMPONENT'] as const;
    const scenarios: [string, SearchFilters, number][] = [
      ['common text "filtro", page 1', { applicationId, query: normalizeText('filtro'), types: all }, 0],
      ['text without results', { applicationId, query: normalizeText('zzqxjk'), types: all }, 0],
      ['text "lorem", high page', { applicationId, query: normalizeText('lorem'), types: all }, 480],
      ['filters only', { applicationId, types: ['VARIABLE', 'COLLECTION'], environment: 'PROD' }, 0],
    ];
    const timed = async (
      run: (tx: Prisma.TransactionClient) => Promise<number>,
    ): Promise<{ ms: number[]; total: number }> => {
      const ms: number[] = [];
      let total = -1;
      for (let i = 0; i < READS; i += 1) {
        const started = performance.now();
        total = await t.db.base.$transaction(
          async (tx) => {
            await tx.$executeRaw`SET TRANSACTION READ ONLY`;
            return run(tx);
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
        );
        ms.push(performance.now() - started);
      }
      return { ms, total };
    };
    for (const [label, filters, skip] of scenarios) {
      const two = await timed(async (tx) => {
        const counted = await tx.$queryRaw<{ total: bigint }[]>(countStatement(filters));
        await tx.$queryRaw(pageStatement(filters, skip, 20, false));
        return Number(counted[0]!.total);
      });
      const one = await timed(async (tx) => {
        const rows = await tx.$queryRaw<{ total: bigint }[]>(pageStatement(filters, skip, 20));
        return rows.length === 0 ? 0 : Number(rows[0]!.total);
      });
      console.log(
        `PERF search total strategy, ${label}: two statements median=${median(two.ms).toFixed(1)} min=${Math.min(...two.ms).toFixed(1)} max=${Math.max(...two.ms).toFixed(1)} ms; count(*) OVER () median=${median(one.ms).toFixed(1)} min=${Math.min(...one.ms).toFixed(1)} max=${Math.max(...one.ms).toFixed(1)} ms; totals ${two.total}/${one.total}`,
      );
      if (skip === 0) assert.equal(one.total, two.total, label);
    }
  });
});
