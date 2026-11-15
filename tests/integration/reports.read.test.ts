/**
 * Module 9, the three reads (FR-22; D-32, D-55, D-72, D-118, D-120): `GET /reports` (order, filters, what a Reader
 * sees, ETag and 304), `GET /reports/{id}` (parameters, the same 404 for a Reader) and `GET /reports/{id}/file` (400 ->
 * 404 -> 409 -> 304 -> 200, the content type and the file name). Every JSON response is checked against the contract,
 * and a last block takes away the right to read `report_file` from the API role: everything but the download must keep
 * working, which proves that no other read loads the binary.
 */
import '../helpers/env.js';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { Response } from 'superagent';
import { assertConformsToContract } from '../helpers/contractResponse.js';
import { bodyOf, startTestApp, type TestApp } from '../helpers/app.js';
import { insertApplication, setApplicationStatus } from '../helpers/fixtures.js';
import {
  PDF_MIME,
  PDF_SIGNATURE,
  XLSX_MIME,
  ZIP_SIGNATURE,
  insertReport,
  reportOf,
  reportsPageOf,
} from '../helpers/reports.js';
import { watchPgOverlap } from '../helpers/pgWarnings.js';
import { asUser } from '../helpers/users.js';

describe('reports: reads', () => {
  let t: TestApp;
  let applicationId: number;
  const pgOverlap = watchPgOverlap();
  const ids: Record<string, number> = {};

  before(async () => {
    t = await startTestApp();
    try {
      applicationId = (await insertApplication(t)).id;
      const at = (minutes: number) => new Date(Date.UTC(2026, 10, 14, 12, minutes)).toISOString();
      ids.oldest = await insertReport(t, { applicationId, createdAt: at(0), published: true });
      // Two reports created at the same instant: the list orders them by id, newest first.
      ids.tieA = await insertReport(t, { applicationId, createdAt: at(10), status: 'READY', published: false });
      ids.tieB = await insertReport(t, { applicationId, createdAt: at(10), status: 'READY', published: true });
      ids.pending = await insertReport(t, { applicationId, createdAt: at(20), status: 'PENDING', format: 'XLSX' });
      ids.failed = await insertReport(t, { applicationId, createdAt: at(30), status: 'FAILED', format: 'XLSX' });
      ids.xlsx = await insertReport(t, { applicationId, createdAt: at(5), format: 'XLSX', published: true });
    } catch (error) {
      await t.close();
      throw error;
    }
  });
  after(async () => {
    pgOverlap.stop();
    await t.close();
  });

  const as = (role: 'admin' | 'developer' | 'reader') => asUser(t, t.users[role].token);

  describe('GET /reports', () => {
    it('newest first: createdAt descending and then id descending; no parameters', async () => {
      const res = await as('admin').get(`/reports?applicationId=${applicationId}`);
      assert.equal(res.status, 200);
      await assertConformsToContract(res);
      const page = reportsPageOf(res);
      assert.deepEqual(
        page.data.map((r) => r.id),
        [ids.failed, ids.pending, ids.tieB, ids.tieA, ids.xlsx, ids.oldest],
      );
      assert.equal(page.total, 6);
      assert.deepEqual([page.page, page.pageSize], [1, 20]);
      for (const report of page.data) assert.equal('parameters' in report, false);
    });

    it('a Reader sees only the published reports; published=false is an empty page, not an error', async () => {
      const own = await as('reader').get(`/reports?applicationId=${applicationId}`);
      assert.equal(own.status, 200);
      assert.deepEqual(
        reportsPageOf(own).data.map((r) => r.id),
        [ids.tieB, ids.xlsx, ids.oldest],
      );
      assert.equal(reportsPageOf(own).total, 3);

      const empty = await as('reader').get(`/reports?applicationId=${applicationId}&published=false`);
      assert.equal(empty.status, 200);
      await assertConformsToContract(empty);
      assert.deepEqual(reportsPageOf(empty).data, []);
      assert.equal(reportsPageOf(empty).total, 0);

      const published = await as('reader').get(`/reports?applicationId=${applicationId}&published=true`);
      assert.equal(reportsPageOf(published).total, 3);
    });

    it('Administrator and Developer: published=true and published=false split the reports', async () => {
      for (const role of ['admin', 'developer'] as const) {
        const yes = reportsPageOf(await as(role).get(`/reports?applicationId=${applicationId}&published=true`));
        const no = reportsPageOf(await as(role).get(`/reports?applicationId=${applicationId}&published=false`));
        assert.deepEqual(
          yes.data.map((r) => r.id),
          [ids.tieB, ids.xlsx, ids.oldest],
          role,
        );
        assert.deepEqual(
          no.data.map((r) => r.id),
          [ids.failed, ids.pending, ids.tieA],
          role,
        );
        assert.equal(yes.total + no.total, 6);
      }
    });

    it('pagination keeps the order and the total', async () => {
      const second = reportsPageOf(await as('admin').get(`/reports?applicationId=${applicationId}&page=2&pageSize=2`));
      assert.deepEqual(
        second.data.map((r) => r.id),
        [ids.tieB, ids.tieA],
      );
      assert.deepEqual([second.page, second.pageSize, second.total], [2, 2, 6]);
      const beyond = reportsPageOf(await as('admin').get(`/reports?applicationId=${applicationId}&page=9`));
      assert.deepEqual(beyond.data, []);
    });

    it('only the reports of the application', async () => {
      const other = (await insertApplication(t)).id;
      const empty = await as('admin').get(`/reports?applicationId=${other}`);
      assert.equal(reportsPageOf(empty).total, 0);
    });

    it('an archived application can be listed', async () => {
      const archived = (await insertApplication(t)).id;
      await insertReport(t, { applicationId: archived });
      await setApplicationStatus(t, archived, 'ARCHIVED');
      assert.equal(reportsPageOf(await as('admin').get(`/reports?applicationId=${archived}`)).total, 1);
    });

    it('404 for an application that does not exist (also outside the integer range); 400 for a bad query', async () => {
      for (const id of [999_999, 2_147_483_648]) {
        const res = await as('admin').get(`/reports?applicationId=${id}`);
        assert.equal(res.status, 404, String(id));
        assert.equal(bodyOf(res).details.element, 'application');
        await assertConformsToContract(res);
      }
      // A Reader also gets the 404, and the 404 comes before the empty page of published=false.
      assert.equal((await as('reader').get(`/reports?applicationId=999999&published=false`)).status, 404);
      for (const query of ['', '?applicationId=x', `?applicationId=${applicationId}&published=maybe`]) {
        const res = await as('admin').get(`/reports${query}`);
        assert.equal(res.status, 400, query);
        await assertConformsToContract(res);
      }
      assert.equal((await t.http.get(`/api/v1/reports?applicationId=${applicationId}`)).status, 401);
    });

    it('the ETag is a weak hash of the body and If-None-Match answers 304', async () => {
      const path = `/reports?applicationId=${applicationId}`;
      const first = await as('admin').get(path);
      const etag = first.headers['etag'] as string;
      assert.match(etag, /^W\/"[^"]+"$/);
      assert.equal(first.headers['etag'], (await as('admin').get(path)).headers['etag'], 'stable');
      const again = await asUser(t, t.users.admin.token).get(path).set('If-None-Match', etag);
      assert.equal(again.status, 304);
      assert.deepEqual(again.body, {});
    });
  });

  describe('GET /reports/{id}', () => {
    it('returns the report with its parameters, and the ETag of its updatedAt', async () => {
      for (const role of ['admin', 'developer'] as const) {
        const res = await as(role).get(`/reports/${ids.failed}`);
        assert.equal(res.status, 200);
        await assertConformsToContract(res);
        const report = reportOf(res);
        assert.equal(report.status, 'FAILED');
        assert.deepEqual(report.parameters, {
          format: 'XLSX',
          scope: { elementTypes: ['VARIABLE'] },
          publish: false,
        });
        assert.equal(res.headers['etag'], `W/"${new Date(report.updatedAt).getTime()}"`);
      }
    });

    it('a PENDING report in the polling shape: no file data, not published', async () => {
      const report = reportOf(await as('admin').get(`/reports/${ids.pending}`));
      assert.deepEqual(
        [
          report.fileName,
          report.fileSize,
          report.errorMessage,
          report.completedAt,
          report.publishedAt,
          report.isPublished,
        ],
        [null, null, null, null, null, false],
      );
    });

    it('a Reader reads a published report with its parameters', async () => {
      const res = await as('reader').get(`/reports/${ids.oldest}`);
      assert.equal(res.status, 200);
      assert.ok(reportOf(res).parameters);
    });

    it('a Reader gets the same 404 body for a report that is not published as for one that does not exist', async () => {
      const hidden = await as('reader').get(`/reports/${ids.tieA}`);
      const missing = await as('reader').get(`/reports/${ids.tieA! + 100_000}`);
      assert.equal(hidden.status, 404);
      assert.equal(missing.status, 404);
      assert.equal(bodyOf(hidden).message, bodyOf(missing).message);
      assert.deepEqual(bodyOf(hidden).details, { element: 'report', id: ids.tieA });
      assert.deepEqual(bodyOf(missing).details, { element: 'report', id: ids.tieA! + 100_000 });
      assert.deepEqual(Object.keys(bodyOf(hidden)).sort(), Object.keys(bodyOf(missing)).sort());
      await assertConformsToContract(hidden);
      // The same report is visible to the other roles: its existence is not what the 404 says.
      assert.equal((await as('developer').get(`/reports/${ids.tieA}`)).status, 200);
    });

    it('404 for an id that does not exist, also outside the integer range; 400 for a text id', async () => {
      for (const id of [999_999, 2_147_483_648]) assert.equal((await as('admin').get(`/reports/${id}`)).status, 404);
      assert.equal((await as('admin').get('/reports/abc')).status, 400);
    });

    it('If-None-Match with the ETag answers 304 without a body', async () => {
      const first = await as('admin').get(`/reports/${ids.oldest}`);
      const res = await as('admin')
        .get(`/reports/${ids.oldest}`)
        .set('If-None-Match', first.headers['etag'] as string);
      assert.equal(res.status, 304);
    });
  });

  describe('GET /reports/{id}/file', () => {
    it('400 for a text id comes first; 404 for a report that does not exist', async () => {
      assert.equal((await as('admin').get('/reports/abc/file')).status, 400);
      const missing = await as('admin').get('/reports/999999/file');
      assert.equal(missing.status, 404);
      await assertConformsToContract(missing);
    });

    it('a Reader gets the 404 of a report that is not published before any 409', async () => {
      for (const id of [ids.tieA, ids.pending, ids.failed]) {
        const res = await as('reader').get(`/reports/${id}/file`);
        assert.equal(res.status, 404, String(id));
        assert.deepEqual(bodyOf(res).details, { element: 'report', id });
      }
    });

    it('409 REPORT_NOT_READY with the status for a PENDING and a FAILED report, for every role that can see it', async () => {
      for (const role of ['admin', 'developer'] as const) {
        for (const [id, status] of [
          [ids.pending, 'PENDING'],
          [ids.failed, 'FAILED'],
        ] as const) {
          const res = await as(role).get(`/reports/${id}/file`);
          assert.equal(res.status, 409);
          assert.equal(bodyOf(res).code, 'REPORT_NOT_READY');
          assert.deepEqual(bodyOf(res).details, { status });
          await assertConformsToContract(res);
        }
      }
    });

    it('200: the PDF is sent as application/pdf with its name, ETag and bytes', async () => {
      const report = reportOf(await as('admin').get(`/reports/${ids.oldest}`));
      const res = await as('admin').get(`/reports/${ids.oldest}/file`).buffer(true).parse(binary);
      assert.equal(res.status, 200);
      assert.equal(res.headers['content-type'], PDF_MIME);
      assert.equal(res.headers['content-disposition'], `attachment; filename="${report.fileName}"`);
      assert.equal(res.headers['etag'], `W/"${new Date(report.updatedAt).getTime()}"`);
      assert.ok((res.body as Buffer).equals(PDF_SIGNATURE));
    });

    it('200: the Excel file is sent with the content type of its format, never the other one', async () => {
      const res = await as('developer').get(`/reports/${ids.xlsx}/file`).buffer(true).parse(binary);
      assert.equal(res.status, 200);
      assert.equal(res.headers['content-type'], XLSX_MIME);
      assert.ok((res.body as Buffer).equals(ZIP_SIGNATURE));
    });

    it('a Reader downloads a published report', async () => {
      const res = await as('reader').get(`/reports/${ids.tieB}/file`).buffer(true).parse(binary);
      assert.equal(res.status, 200);
    });

    it('304 with the ETag of the report; the 409 and the 404 come before it', async () => {
      const first = await as('admin').get(`/reports/${ids.oldest}/file`).buffer(true).parse(binary);
      const etag = first.headers['etag'] as string;
      const fresh = await as('admin').get(`/reports/${ids.oldest}/file`).set('If-None-Match', etag);
      assert.equal(fresh.status, 304);
      // The ETag of a PENDING report does not turn its 409 into a 304.
      const pendingEtag = reportOf(await as('admin').get(`/reports/${ids.pending}`));
      const stillConflict = await as('admin')
        .get(`/reports/${ids.pending}/file`)
        .set('If-None-Match', `W/"${new Date(pendingEtag.updatedAt).getTime()}"`);
      assert.equal(stillConflict.status, 409);
      const hidden = await as('reader').get(`/reports/${ids.tieA}/file`).set('If-None-Match', etag);
      assert.equal(hidden.status, 404);
    });

    it('the file of a report of an archived application can be downloaded (D-47)', async () => {
      const archived = (await insertApplication(t)).id;
      const id = await insertReport(t, { applicationId: archived });
      await setApplicationStatus(t, archived, 'ARCHIVED');
      assert.equal((await as('admin').get(`/reports/${id}/file`).buffer(true).parse(binary)).status, 200);
    });
  });

  describe('no read but the download loads report_file', () => {
    it('with SELECT on report_file taken away, the list and the detail still work and the download does not', async () => {
      await t.owner.query(`REVOKE SELECT ON report_file FROM docs_app`);
      try {
        const list = await as('admin').get(`/reports?applicationId=${applicationId}`);
        const detail = await as('admin').get(`/reports/${ids.oldest}`);
        const pending = await as('admin').get(`/reports/${ids.pending}/file`); // 409 is decided before the file
        const download = await as('admin').get(`/reports/${ids.oldest}/file`);
        assert.equal(list.status, 200);
        assert.equal(detail.status, 200);
        assert.equal(pending.status, 409);
        assert.equal(download.status, 500, 'the only read of the file is the download');
      } finally {
        await t.owner.query(`GRANT SELECT ON report_file TO docs_app`);
      }
    });
  });
});

/** supertest parser that keeps the bytes of a binary response. */
function binary(res: Response, done: (e: Error | null, b: Buffer) => void) {
  const chunks: Buffer[] = [];
  res.on('data', (chunk: Buffer) => chunks.push(chunk));
  res.on('end', () => done(null, Buffer.concat(chunks)));
}
