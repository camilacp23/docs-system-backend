/**
 * Module 8, about 5000 records (FR-21, NFR-11): the audit log of a department after some time. The records are written by
 * the trigger (real UPDATEs of audited rows, each transaction as a different user through `app.user_id`); nothing is
 * written to `audit_log` by hand. The test reads `GET /audit-log` with the usual filters and prints how long each takes
 * (median, minimum and maximum) and the plan PostgreSQL chooses for the statements of the repository. It asserts no
 * time threshold (a threshold would make it flaky on a busy machine); it asserts the size, the contract, and that the
 * indexes of SDD Table 41 are the ones the statements can use.
 */
import '../helpers/env.js';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { startTestApp, type TestApp } from '../helpers/app.js';
import { assertConformsToContract } from '../helpers/contractResponse.js';
import { insertApplication, insertVariable } from '../helpers/fixtures.js';
import { countStatement, pageStatement, type AuditFilters } from '../../src/modules/audit/repository.js';

const APPLICATIONS = 3;
const VARIABLES_PER_APPLICATION = 25;
const ROUNDS = 70;
const READS = 15;

const median = (values: number[]): number => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;

/** The names of the nodes of a JSON plan, with the index each scan uses. */
function nodesOf(plan: unknown): string[] {
  const found: string[] = [];
  const visit = (node: Record<string, unknown>): void => {
    const index = typeof node['Index Name'] === 'string' ? ` using ${node['Index Name']}` : '';
    found.push(`${String(node['Node Type'])}${index}`);
    for (const child of (node['Plans'] as Record<string, unknown>[] | undefined) ?? []) visit(child);
  };
  visit(plan as Record<string, unknown>);
  return found;
}

describe('audit: about 5000 records', () => {
  let t: TestApp;
  let applicationIds: number[];
  let variableOfFirst: number;

  before(async () => {
    t = await startTestApp();
    try {
      applicationIds = [];
      const variables: { id: number; applicationId: number }[] = [];
      for (let a = 0; a < APPLICATIONS; a += 1) {
        const app = await insertApplication(t, { name: `Audit performance ${a}` });
        applicationIds.push(app.id);
        for (let v = 0; v < VARIABLES_PER_APPLICATION; v += 1) {
          variables.push({
            id: (await insertVariable(t, app.id, { name: `gPerf${a}x${v}` })).id,
            applicationId: app.id,
          });
        }
      }
      variableOfFirst = variables[0]!.id;
      // Each round is one transaction as another user (the admin, the developer or none), and updates every
      // variable of the application: the trigger writes one record per row.
      const actors: (number | null)[] = [t.users.admin.id, t.users.developer.id, null];
      for (let round = 0; round < ROUNDS; round += 1) {
        for (let a = 0; a < APPLICATIONS; a += 1) {
          const actor = actors[(round + a) % actors.length];
          await t.owner.query('BEGIN');
          try {
            if (actor !== null) await t.owner.query(`SELECT set_config('app.user_id', $1, true)`, [String(actor)]);
            await t.owner.query(`UPDATE variable SET description = $2 WHERE application_id = $1`, [
              applicationIds[a],
              `round ${round}`,
            ]);
            await t.owner.query('COMMIT');
          } catch (error) {
            await t.owner.query('ROLLBACK');
            throw error;
          }
        }
      }
      await t.owner.query('ANALYZE audit_log');
    } catch (error) {
      await t.close();
      throw error;
    }
  });
  after(async () => {
    await t.close();
  });

  const get = (token: string, query: Record<string, string | number>) =>
    t.http.get('/api/v1/audit-log').query(query).set('Authorization', `Bearer ${token}`);

  it('has about 5000 records', async () => {
    const total = Number((await t.owner.query<{ n: string }>('SELECT count(*) AS n FROM audit_log')).rows[0]!.n);
    assert.ok(total >= 5000, `${total} records`);
  });

  it('serves the usual reads, and prints how long each takes', async () => {
    const [first] = applicationIds as [number];
    const from = new Date(Date.now() - 3_600_000).toISOString();
    const to = new Date(Date.now() + 3_600_000).toISOString();
    const scenarios: [string, string, Record<string, string | number>][] = [
      ['Administrator, first page', t.users.admin.token, {}],
      ['Administrator, applicationId', t.users.admin.token, { applicationId: first }],
      ['Administrator, actorUserId', t.users.admin.token, { actorUserId: t.users.developer.id }],
      [
        'Administrator, entityType + entityId',
        t.users.admin.token,
        { entityType: 'variable', entityId: String(variableOfFirst) },
      ],
      ['Administrator, entityType + action', t.users.admin.token, { entityType: 'variable', action: 'UPDATE' }],
      ['Administrator, from + to', t.users.admin.token, { from, to }],
      [
        'Administrator, applicationId + from + to, page 50',
        t.users.admin.token,
        { applicationId: first, from, to, page: 50 },
      ],
      ['Administrator, page 200 (skip 4000)', t.users.admin.token, { page: 200 }],
      ['Developer, own actions', t.users.developer.token, {}],
    ];
    const lines: string[] = [];
    for (const [label, token, query] of scenarios) {
      const warm = await get(token, query);
      assert.equal(warm.status, 200, `${label}: ${JSON.stringify(warm.body)}`);
      await assertConformsToContract(warm);
      const times: number[] = [];
      for (let i = 0; i < READS; i += 1) {
        const started = performance.now();
        const res = await get(token, query);
        times.push(performance.now() - started);
        assert.equal(res.status, 200);
      }
      const body = warm.body as { total: number; data: unknown[] };
      lines.push(
        `${label}: total ${body.total}, page ${body.data.length}; median ${median(times).toFixed(1)} ms, min ${Math.min(...times).toFixed(1)} ms, max ${Math.max(...times).toFixed(1)} ms (${READS} reads)`,
      );
    }
    console.log(`AUDIT-LOG TIMES (about 5000 records)\n  ${lines.join('\n  ')}`);
  });

  it('prints the plans of the statements, and the indexes of Table 41 are the ones they can use', async () => {
    const explain = async (filters: AuditFilters, noSeqScan: boolean) => {
      const out: Record<string, string[]> = {};
      const statements = { count: countStatement(filters), page: pageStatement(filters, 0, 20) };
      await t.owner.query('BEGIN');
      try {
        if (noSeqScan) await t.owner.query('SET LOCAL enable_seqscan = off');
        for (const [name, statement] of Object.entries(statements)) {
          const r = await t.owner.query<{ 'QUERY PLAN': { Plan: unknown }[] }>(
            `EXPLAIN (FORMAT JSON) ${statement.text}`,
            statement.values,
          );
          out[name] = nodesOf(r.rows[0]!['QUERY PLAN'][0]!.Plan);
        }
      } finally {
        await t.owner.query('ROLLBACK');
      }
      return out;
    };
    const first = applicationIds[0]!;
    const cases: [string, AuditFilters, string][] = [
      ['applicationId', { applicationId: first }, 'audit_log_application_id_created_at_idx'],
      ['actorUserId', { actorUserId: t.users.developer.id }, 'audit_log_actor_user_id_created_at_idx'],
      [
        'entityType + entityId',
        { entityType: 'variable', entityId: String(variableOfFirst) },
        'audit_log_entity_type_entity_id_created_at_idx',
      ],
      ['from + to', { from: '2026-01-01T00:00:00Z', to: '2999-01-01T00:00:00Z' }, 'audit_log_created_at_idx'],
    ];
    const lines: string[] = [];
    const checks: (() => void)[] = [];
    for (const [label, filters, index] of cases) {
      const natural = await explain(filters, false);
      const forced = await explain(filters, true);
      lines.push(
        `${label}\n    natural plan:    page = ${natural['page']!.join(' > ')}; count = ${natural['count']!.join(' > ')}`,
      );
      lines.push(`    seq scan off:    page = ${forced['page']!.join(' > ')}; count = ${forced['count']!.join(' > ')}`);
      checks.push(() => {
        assert.ok(
          forced['count']!.some((n) => n.includes(index)),
          `${label}: the count can use ${index}; plan: ${forced['count']!.join(' > ')}`,
        );
        assert.ok(
          forced['page']!.some((n) => /Index (Only )?Scan using audit_log_\w+_idx/.test(n)),
          `${label}: the page reads audit_log through an index; plan: ${forced['page']!.join(' > ')}`,
        );
      });
    }
    // Printed first, so the plans are in the output even if a check fails.
    console.log(`AUDIT-LOG PLANS (about 5000 records)\n  ${lines.join('\n  ')}`);
  });
});
