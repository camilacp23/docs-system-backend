/**
 * Module 9, `POST /reports/pdf` and `POST /reports/excel` (FR-22, NFR-12; D-115, D-118): the 202 with its headers, what
 * is stored, the three roles, an archived application, and each error in its order: 400 (validator, then the rules of
 * `scope` with positions) -> 404 (application, then a screen of `screenIds`). Every response is checked against the
 * contract.
 */
import '../helpers/env.js';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { assertConformsToContract } from '../helpers/contractResponse.js';
import { bodyOf, startTestApp, type TestApp } from '../helpers/app.js';
import { insertApplication, insertScreen, setApplicationStatus } from '../helpers/fixtures.js';
import { auditOfReport, reportOf } from '../helpers/reports.js';
import { watchPgOverlap } from '../helpers/pgWarnings.js';
import { asUser } from '../helpers/users.js';

describe('reports: POST /reports/pdf and /reports/excel', () => {
  let t: TestApp;
  let applicationId: number;
  let otherApplicationId: number;
  let screenId: number;
  let foreignScreenId: number;
  const pgOverlap = watchPgOverlap();

  before(async () => {
    t = await startTestApp();
    try {
      applicationId = (await insertApplication(t)).id;
      otherApplicationId = (await insertApplication(t)).id;
      screenId = (await insertScreen(t, applicationId)).id;
      foreignScreenId = (await insertScreen(t, otherApplicationId)).id;
    } catch (error) {
      await t.close();
      throw error;
    }
  });
  after(async () => {
    pgOverlap.stop();
    await t.close();
  });

  const admin = () => asUser(t, t.users.admin.token);
  const request = (over: Record<string, unknown> = {}) => ({
    applicationId,
    title: 'Variables y colecciones',
    scope: { elementTypes: ['VARIABLE', 'COLLECTION'] },
    publish: false,
    ...over,
  });

  it('the six report operations are implemented (no NOT_IMPLEMENTED)', () => {
    for (const operationId of [
      'generatePdfReport',
      'generateExcelReport',
      'listReports',
      'getReport',
      'downloadReport',
      'setReportPublication',
    ]) {
      assert.ok(!t.built.notImplemented.includes(operationId), operationId);
    }
  });

  describe('202', () => {
    for (const [path, format] of [
      ['/reports/pdf', 'PDF'],
      ['/reports/excel', 'XLSX'],
    ] as const) {
      it(`${path}: saves a PENDING report with Location and the ETag of its updatedAt`, async () => {
        const body = request({ title: '  =Estado de la documentación  ', publish: true });
        const res = await admin().post(path, body);
        assert.equal(res.status, 202, JSON.stringify(res.body));
        await assertConformsToContract(res);
        const report = reportOf(res);
        assert.equal(res.headers['location'], `/api/v1/reports/${report.id}`);
        assert.equal(res.headers['etag'], `W/"${new Date(report.updatedAt).getTime()}"`);
        assert.equal(res.headers['retry-after'], undefined, 'no Retry-After (D-118)');
        assert.equal(report.status, 'PENDING');
        assert.equal(report.format, format);
        assert.equal(report.title, '  =Estado de la documentación  ', 'the title is stored as sent');
        assert.equal(report.isPublished, false, 'published only when it is READY');
        assert.deepEqual(
          [report.fileName, report.fileSize, report.errorMessage, report.completedAt, report.publishedAt],
          [null, null, null, null, null],
        );
        assert.equal(report.generatedBy.id, t.users.admin.id);
        assert.equal('parameters' in report, false, 'the 202 has no parameters');

        const stored = await t.owner.query<{ parameters: unknown }>(`SELECT parameters FROM report WHERE id = $1`, [
          report.id,
        ]);
        // The validator fills the defaults of the contract (`false`), so they are stored too: the same meaning as sent.
        assert.deepEqual(stored.rows[0]!.parameters, {
          format,
          scope: { ...body.scope, includeStatusSummary: false, includeDependencies: false },
          publish: true,
        });
      });
    }

    it('the creation is audited with the user who asked for it', async () => {
      const res = await asUser(t, t.users.developer.token).post('/reports/pdf', request());
      assert.equal(res.status, 202);
      const records = await auditOfReport(t, reportOf(res).id);
      assert.deepEqual(
        records.map((r) => [r.action, r.actor_user_id]),
        [['CREATE', t.users.developer.id]],
      );
    });

    it('only the overall status is enough (empty elementTypes with includeStatusSummary)', async () => {
      const res = await admin().post(
        '/reports/pdf',
        request({ scope: { elementTypes: [], includeStatusSummary: true } }),
      );
      assert.equal(res.status, 202, JSON.stringify(res.body));
      await assertConformsToContract(res);
    });

    it('screenIds and documentationStatus are accepted with SCREEN or COMPONENT', async () => {
      for (const elementTypes of [['SCREEN'], ['COMPONENT']]) {
        const res = await admin().post(
          '/reports/excel',
          request({ scope: { elementTypes, screenIds: [screenId], documentationStatus: ['DRAFT', 'APPROVED'] } }),
        );
        assert.equal(res.status, 202, JSON.stringify(res.body));
      }
    });

    it('an archived application can generate a report (D-47)', async () => {
      const archived = (await insertApplication(t)).id;
      await setApplicationStatus(t, archived, 'ARCHIVED');
      const res = await admin().post('/reports/pdf', request({ applicationId: archived }));
      assert.equal(res.status, 202, JSON.stringify(res.body));
    });

    it('every request creates a new report', async () => {
      const first = reportOf(await admin().post('/reports/pdf', request()));
      const second = reportOf(await admin().post('/reports/pdf', request()));
      assert.notEqual(first.id, second.id);
    });
  });

  describe('roles (D-32)', () => {
    it('Administrator and Developer: 202; Reader: 403; no token: 401', async () => {
      assert.equal((await asUser(t, t.users.admin.token).post('/reports/pdf', request())).status, 202);
      assert.equal((await asUser(t, t.users.developer.token).post('/reports/excel', request())).status, 202);
      const reader = await asUser(t, t.users.reader.token).post('/reports/pdf', request());
      assert.equal(reader.status, 403);
      assert.equal(bodyOf(reader).code, 'FORBIDDEN');
      assert.equal((await t.http.post('/api/v1/reports/pdf').send(request())).status, 401);
    });
  });

  describe('400 from the validator', () => {
    const cases: [string, Record<string, unknown>, string][] = [
      ['a title that is only spaces', { title: '   ' }, 'title'],
      ['an empty title', { title: '' }, 'title'],
      ['a title of 201 characters', { title: 'x'.repeat(201) }, 'title'],
      ['no publish', { publish: undefined }, 'publish'],
      ['an unknown scope key', { scope: { elementTypes: ['SCREEN'], extra: true } }, 'scope'],
      ['an unknown element type', { scope: { elementTypes: ['PAGE'] } }, 'scope.elementTypes[0]'],
      [
        'five element types',
        { scope: { elementTypes: ['SCREEN', 'VARIABLE', 'COLLECTION', 'COMPONENT', 'SCREEN'] } },
        'scope.elementTypes',
      ],
      ['an empty screenIds', { scope: { elementTypes: ['SCREEN'], screenIds: [] } }, 'scope.screenIds'],
      [
        'an empty documentationStatus',
        { scope: { elementTypes: ['SCREEN'], documentationStatus: [] } },
        'scope.documentationStatus',
      ],
      [
        '501 screenIds',
        { scope: { elementTypes: ['SCREEN'], screenIds: Array.from({ length: 501 }, (_, i) => i + 1) } },
        'scope.screenIds',
      ],
    ];
    for (const [name, over, field] of cases) {
      it(`${name}`, async () => {
        const res = await admin().post('/reports/pdf', request(over));
        assert.equal(res.status, 400, JSON.stringify(res.body));
        assert.equal(bodyOf(res).code, 'VALIDATION_ERROR');
        assert.ok(
          (bodyOf(res).details.fields as { field: string }[]).some(
            (f) => f.field.startsWith(field) || f.field === field,
          ),
          `${field} in ${JSON.stringify(bodyOf(res).details)}`,
        );
        await assertConformsToContract(res);
      });
    }
  });

  describe('400 from the rules of the scope (with positions)', () => {
    const fieldsOf = (res: { body: unknown }) =>
      (bodyOf(res).details.fields as { field: string; rule: string; message: string }[]).map((f) => [f.field, f.rule]);

    it('a repeated value is `unique` at its position, in the three lists', async () => {
      const res = await admin().post(
        '/reports/pdf',
        request({
          scope: {
            elementTypes: ['SCREEN', 'VARIABLE', 'SCREEN'],
            screenIds: [screenId, 9, screenId, 9],
            documentationStatus: ['DRAFT', 'APPROVED', 'DRAFT'],
          },
        }),
      );
      assert.equal(res.status, 400);
      assert.deepEqual(fieldsOf(res), [
        ['scope.elementTypes[2]', 'unique'],
        ['scope.screenIds[2]', 'unique'],
        ['scope.screenIds[3]', 'unique'],
        ['scope.documentationStatus[2]', 'unique'],
      ]);
      await assertConformsToContract(res);
    });

    it('an empty elementTypes without includeStatusSummary is `required`', async () => {
      for (const scope of [{ elementTypes: [] }, { elementTypes: [], includeStatusSummary: false }]) {
        const res = await admin().post('/reports/pdf', request({ scope }));
        assert.equal(res.status, 400);
        assert.deepEqual(fieldsOf(res), [['scope.elementTypes', 'required']]);
      }
    });

    it('screenIds and documentationStatus without SCREEN or COMPONENT are `notApplicable`', async () => {
      const res = await admin().post(
        '/reports/pdf',
        request({
          scope: { elementTypes: ['VARIABLE'], screenIds: [screenId], documentationStatus: ['DRAFT'] },
        }),
      );
      assert.equal(res.status, 400);
      assert.deepEqual(fieldsOf(res), [
        ['scope.screenIds', 'notApplicable'],
        ['scope.documentationStatus', 'notApplicable'],
      ]);
      const messages = (bodyOf(res).details.fields as { message: string }[]).map((f) => f.message);
      assert.deepEqual(messages, [
        'scope.screenIds only applies when SCREEN or COMPONENT is selected.',
        'scope.documentationStatus only applies when SCREEN or COMPONENT is selected.',
      ]);
      await assertConformsToContract(res);
    });

    it('the rules of the scope come before the 404 of the application', async () => {
      const res = await admin().post(
        '/reports/pdf',
        request({ applicationId: 2_000_000_000, scope: { elementTypes: [] } }),
      );
      assert.equal(res.status, 400);
    });
  });

  describe('404', () => {
    it('an application that does not exist, also one outside the integer range', async () => {
      for (const id of [999_999, 2_147_483_648]) {
        for (const path of ['/reports/pdf', '/reports/excel']) {
          const res = await admin().post(path, request({ applicationId: id }));
          assert.equal(res.status, 404, `${path} ${id}`);
          assert.equal(bodyOf(res).code, 'NOT_FOUND');
          // An id outside the integer range is answered before the database, with the id as text (like the other modules).
          assert.deepEqual(bodyOf(res).details, { element: 'application', id: id > 2_147_483_647 ? String(id) : id });
          await assertConformsToContract(res);
        }
      }
    });

    it('a screen of screenIds that does not exist, with its position', async () => {
      const res = await admin().post(
        '/reports/pdf',
        request({ scope: { elementTypes: ['SCREEN'], screenIds: [screenId, 999_999, 888_888] } }),
      );
      assert.equal(res.status, 404);
      assert.deepEqual(bodyOf(res).details, { element: 'screen', id: 999_999, field: 'scope.screenIds[1]' });
      await assertConformsToContract(res);
    });

    it('a screen of another application is the same 404 as one that does not exist', async () => {
      const foreign = await admin().post(
        '/reports/pdf',
        request({ scope: { elementTypes: ['SCREEN'], screenIds: [foreignScreenId] } }),
      );
      const missing = await admin().post(
        '/reports/pdf',
        request({ scope: { elementTypes: ['SCREEN'], screenIds: [999_999] } }),
      );
      assert.equal(foreign.status, 404);
      assert.equal(bodyOf(foreign).message, bodyOf(missing).message);
      assert.deepEqual(bodyOf(foreign).details, {
        element: 'screen',
        id: foreignScreenId,
        field: 'scope.screenIds[0]',
      });
      assert.ok(
        !JSON.stringify(foreign.body).includes(String(otherApplicationId)),
        'the other application is not named',
      );
    });

    it('a screen id outside the integer range is 404 with its position', async () => {
      const res = await admin().post(
        '/reports/pdf',
        request({ scope: { elementTypes: ['SCREEN'], screenIds: [screenId, 2_147_483_648] } }),
      );
      assert.equal(res.status, 404);
      assert.deepEqual(bodyOf(res).details, { element: 'screen', id: 2_147_483_648, field: 'scope.screenIds[1]' });
    });

    it('the application is checked before the screens', async () => {
      const res = await admin().post(
        '/reports/pdf',
        request({ applicationId: 999_999, scope: { elementTypes: ['SCREEN'], screenIds: [888_888] } }),
      );
      assert.equal(bodyOf(res).details.element, 'application');
    });

    it('nothing is saved when a request fails', async () => {
      const before = await t.owner.query<{ n: string }>(`SELECT count(*) AS n FROM report`);
      await admin().post('/reports/pdf', request({ applicationId: 999_999 }));
      await admin().post('/reports/pdf', request({ scope: { elementTypes: [] } }));
      const after = await t.owner.query<{ n: string }>(`SELECT count(*) AS n FROM report`);
      assert.equal(after.rows[0]!.n, before.rows[0]!.n);
    });
  });
});
