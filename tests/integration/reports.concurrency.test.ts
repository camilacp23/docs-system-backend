/**
 * Module 9, the worker under concurrency (D-44: `FOR UPDATE SKIP LOCKED`), several rounds each:
 * (a) several workers with N PENDING reports process every report exactly once;
 * (b) a worker that finds the oldest report taken by another takes the next one and does not wait for it;
 * (c) the publication of a report that is being generated answers 409 at once, and two simultaneous publications of a
 *     READY report both succeed with ONE audit record.
 * The generators are replaced by stubs that the test can hold, so a report stays "being generated" for exactly as long as
 * the test needs, with no sleeps.
 */
import '../helpers/env.js';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { createApplicationReportWorker } from '../../src/jobs/reports/index.js';
import type { Generator } from '../../src/jobs/reports/types.js';
import type { ReportWorker, RunResult } from '../../src/jobs/reports/worker.js';
import { bodyOf, startTestApp, type TestApp } from '../helpers/app.js';
import { insertApplication } from '../helpers/fixtures.js';
import { watchPgOverlap } from '../helpers/pgWarnings.js';
import { auditOfReport, insertReport, reportOf } from '../helpers/reports.js';
import { asUser } from '../helpers/users.js';

const ROUNDS = 5;
const REPORTS_PER_ROUND = 9;
const WORKERS = 3;

const stub: Generator = () =>
  Promise.resolve({ buffer: Buffer.from('%PDF-1.7 stub'), mimeType: 'application/pdf', replacedCharacters: 0 });

/** A promise that the test settles by hand. */
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

describe('reports: the worker under concurrency', () => {
  let t: TestApp;
  let applicationId: number;
  const pgOverlap = watchPgOverlap();

  before(async () => {
    t = await startTestApp();
    try {
      applicationId = (await insertApplication(t)).id;
    } catch (error) {
      await t.close();
      throw error;
    }
  });
  after(async () => {
    pgOverlap.stop();
    await t.close();
  });

  const pending = (): Promise<number> =>
    insertReport(t, {
      applicationId,
      status: 'PENDING',
      format: 'PDF',
      parameters: { format: 'PDF', scope: { elementTypes: ['VARIABLE'] }, publish: false },
    });

  const makeWorker = (generator: Generator = stub, onClaim?: (id: number) => Promise<void>): ReportWorker =>
    createApplicationReportWorker(
      { db: t.db, logger: t.built.logger, jira: t.built.jira, config: t.config.reports },
      { generators: { PDF: generator }, ...(onClaim === undefined ? {} : { hooks: { afterClaim: onClaim } }) },
    );

  /** A worker that goes on until it finds nothing to take (a lost race, `conflict`, is just another look). */
  async function drain(worker: ReportWorker): Promise<RunResult[]> {
    const results: RunResult[] = [];
    for (;;) {
      const result = await worker.runOnce();
      results.push(result);
      if (result === 'idle') return results;
    }
  }

  const statusOf = async (id: number) =>
    (await t.owner.query<{ status: string }>(`SELECT status FROM report WHERE id = $1`, [id])).rows[0]!.status;

  describe('(a) every report is processed exactly once', () => {
    it(`${WORKERS} workers and ${REPORTS_PER_ROUND} PENDING reports, ${ROUNDS} rounds`, async () => {
      for (let round = 0; round < ROUNDS; round += 1) {
        const ids: number[] = [];
        for (let n = 0; n < REPORTS_PER_ROUND; n += 1) ids.push(await pending());
        const claims = new Map<number, number>();
        const workers = Array.from({ length: WORKERS }, () =>
          makeWorker(stub, (id) => {
            claims.set(id, (claims.get(id) ?? 0) + 1);
            return Promise.resolve();
          }),
        );
        const outcomes = (await Promise.all(workers.map((worker) => drain(worker)))).flat();

        assert.equal(outcomes.filter((o) => o === 'ready').length, REPORTS_PER_ROUND, `round ${round}`);
        for (const id of ids) {
          assert.equal(claims.get(id), 1, `round ${round}: report ${id} was taken ${claims.get(id) ?? 0} times`);
          assert.equal(await statusOf(id), 'READY', `round ${round}`);
        }
        const { rows } = await t.owner.query<{ n: string; files: string }>(
          `SELECT count(*) AS n, count(DISTINCT report_id) AS files FROM report_file WHERE report_id = ANY($1)`,
          [ids],
        );
        assert.deepEqual([rows[0]!.n, rows[0]!.files], [String(REPORTS_PER_ROUND), String(REPORTS_PER_ROUND)]);
        for (const id of ids) {
          const finished = (await auditOfReport(t, id, 'UPDATE')).filter((r) => r.changed_fields.includes('status'));
          assert.equal(finished.length, 1, `round ${round}: report ${id} finished once`);
        }
      }
    });
  });

  describe('(b) SKIP LOCKED: the second worker takes another report instead of waiting', () => {
    it('with two PENDING reports, B takes the second while A holds the first (several rounds)', async () => {
      for (let round = 0; round < ROUNDS; round += 1) {
        const first = await pending();
        const second = await pending();
        const holding = deferred();
        const inside = deferred<number>();
        const a = makeWorker(
          async (content, context) => {
            await holding.promise;
            return stub(content, context);
          },
          (id) => {
            inside.resolve(id);
            return Promise.resolve();
          },
        );
        const passA = a.runOnce();
        assert.equal(await inside.promise, first, 'the oldest report goes first');

        const taken: number[] = [];
        const b = makeWorker(stub, (id) => {
          taken.push(id);
          return Promise.resolve();
        });
        assert.equal(await b.runOnce(), 'ready', `round ${round}: B did not wait for the lock of A`);
        assert.deepEqual(taken, [second]);
        assert.equal(await statusOf(second), 'READY');
        assert.equal(await statusOf(first), 'PENDING', 'A still holds the first');

        holding.resolve();
        assert.equal(await passA, 'ready');
        assert.equal(await statusOf(first), 'READY');
      }
    });

    it('with a single PENDING report held by A, B finds nothing and answers idle at once', async () => {
      for (let round = 0; round < ROUNDS; round += 1) {
        const only = await pending();
        const holding = deferred();
        const inside = deferred();
        const a = makeWorker(
          async (content, context) => {
            await holding.promise;
            return stub(content, context);
          },
          () => {
            inside.resolve();
            return Promise.resolve();
          },
        );
        const passA = a.runOnce();
        await inside.promise;
        assert.equal(await makeWorker().runOnce(), 'idle', `round ${round}`);
        assert.equal(await statusOf(only), 'PENDING');
        holding.resolve();
        assert.equal(await passA, 'ready');
      }
    });
  });

  describe('(c) publishing while a report is generated, and twice at once', () => {
    it('the PUT of the publication of a report being generated is 409 at once; the reads are answered too (several rounds)', async () => {
      for (let round = 0; round < ROUNDS; round += 1) {
        const id = await pending();
        const holding = deferred();
        const inside = deferred();
        const worker = makeWorker(
          async (content, context) => {
            await holding.promise;
            return stub(content, context);
          },
          () => {
            inside.resolve();
            return Promise.resolve();
          },
        );
        const pass = worker.runOnce();
        await inside.promise; // the worker holds the row of the report
        try {
          const admin = asUser(t, t.users.admin.token);
          // If these waited for the worker they would never answer: it is released only after them.
          const [publish, unpublish, detail, file] = await Promise.all([
            admin.put(`/reports/${id}/publication`, { isPublished: true }),
            admin.put(`/reports/${id}/publication`, { isPublished: false }),
            admin.get(`/reports/${id}`),
            admin.get(`/reports/${id}/file`),
          ]);
          for (const res of [publish, unpublish]) {
            assert.equal(res.status, 409, `round ${round}`);
            assert.deepEqual(bodyOf(res).details, { status: 'PENDING' });
          }
          assert.equal(detail.status, 200);
          assert.equal(reportOf(detail).status, 'PENDING');
          assert.equal(file.status, 409);
        } finally {
          holding.resolve();
        }
        assert.equal(await pass, 'ready');
      }
    });

    it('once the worker is done, two simultaneous PUTs both succeed and leave ONE audit record (several rounds)', async () => {
      for (let round = 0; round < ROUNDS; round += 1) {
        const id = await pending();
        assert.equal(await makeWorker().runOnce(), 'ready');
        const admin = asUser(t, t.users.admin.token);
        const [one, two] = await Promise.all([
          admin.put(`/reports/${id}/publication`, { isPublished: true }),
          admin.put(`/reports/${id}/publication`, { isPublished: true }),
        ]);
        assert.deepEqual([one.status, two.status], [200, 200], `round ${round}`);
        assert.equal(one.headers['etag'], two.headers['etag']);
        const records = (await auditOfReport(t, id, 'UPDATE')).filter((r) => r.changed_fields.includes('is_published'));
        assert.equal(records.length, 1, `round ${round}`);
      }
    });
  });
});
