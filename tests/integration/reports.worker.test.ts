/**
 * Module 9, the report worker (NFR-12; D-44, D-115 to D-120, D-129): what it writes (a real Excel and a real PDF, the
 * parts and columns of D-116 in the order of D-116), what it does when a report cannot be made (the four texts of
 * D-119, each from its own cause), the snapshot, the audit (the actor is `generated_by`), the files it must not create,
 * the size guard that runs before any text is read, and the orderly stop. The worker is driven with `runOnce`; nothing
 * waits a fixed time.
 */
import '../helpers/env.js';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import type { ReportsConfig } from '../../src/config/env.js';
import { createApplicationReportWorker } from '../../src/jobs/reports/index.js';
import { runInThread } from '../../src/jobs/reports/runGenerator.js';
import type { Generator } from '../../src/jobs/reports/types.js';
import type { ReportWorker, RunResult, WorkerHooks } from '../../src/jobs/reports/worker.js';
import type { ReportContent } from '../../src/modules/reports/content.js';
import { REPORT_ERROR_MESSAGES, ReportAbandonedError } from '../../src/modules/reports/failures.js';
import { bodyOf, startTestApp, type TestApp } from '../helpers/app.js';
import { getIndicators, indicatorsOf } from '../helpers/dashboard.js';
import {
  insertApplication,
  insertCollection,
  insertComponent,
  insertDependency,
  insertScreen,
  insertScreenCollection,
  insertVariable,
} from '../helpers/fixtures.js';
import { fileOf, pdfFacts, readWorkbook, sheetHeader, sheetRows } from '../helpers/reportFiles.js';
import { auditOfReport, explainWorkerFailures, insertReport, reportOf, type ReportBody } from '../helpers/reports.js';
import { watchPgOverlap } from '../helpers/pgWarnings.js';
import { asUser } from '../helpers/users.js';

const PII = 'ana.perez@example.test';
const THREADS = new URL('../helpers/threads/', import.meta.url);

/** A test that has not finished by then is hung, not slow: the slowest real PDF takes ~7 s here. Per test, never global. */
const TEST_TIMEOUT_MS = 45_000;

/** The columns of each part, as D-116 lists them (the specification, written out on purpose). */
const COLUMNS: Record<string, string[]> = {
  Summary: ['Item', 'Value'],
  Screens: [
    'Name',
    'Status',
    'Author',
    'Last updated (UTC)',
    'Miro link',
    'On start',
    'Working process',
    'Architecture',
    'Data model',
    'Requirements',
    'Known issues',
    'Risks',
  ],
  Components: ['Screen', 'Name', 'Control type', 'Description', 'On select'],
  Variables: ['Name', 'Data type', 'Scope', 'Origin screen', 'Description', 'Environments'],
  Collections: ['Name', 'Creation condition', 'Description', 'Environments', 'Linked to a screen'],
  'Collection fields': ['Collection', 'Position', 'Name', 'Data type', 'Description'],
  Dependencies: [
    'Relation',
    'Source type',
    'Source',
    'Target type',
    'Target',
    'Access mode',
    'Used in',
    'Assignment function',
  ],
};
const ALL_TYPES = ['SCREEN', 'COMPONENT', 'VARIABLE', 'COLLECTION'] as const;

/** Code-point order, as `COLLATE "C"`. */
const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const byCodePoint = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

describe('reports: the worker', () => {
  let t: TestApp;
  let applicationId: number;
  let alphaId: number;
  let zetaId: number;
  const pgOverlap = watchPgOverlap();

  before(async () => {
    t = await startTestApp();
    try {
      const application = await insertApplication(t);
      applicationId = application.id;
      const alpha = await insertScreen(t, applicationId, { name: 'Alpha', documentationStatus: 'APPROVED' });
      const zeta = await insertScreen(t, applicationId, { name: 'Zeta', documentationStatus: 'DRAFT' });
      await insertScreen(t, applicationId, { name: 'alpha', documentationStatus: 'IN_PROGRESS' });
      alphaId = alpha.id;
      zetaId = zeta.id;
      await t.owner.query(
        `UPDATE screen SET on_start = $2, architecture = $3, working_process = $4, miro_link = $5 WHERE id = $1`,
        [alphaId, '=Navigate(Home)', 'Layers: UI > Data', 'x'.repeat(20_000), 'https://miro.com/app/board/alpha'],
      );
      const button = await insertComponent(t, applicationId, alphaId, { name: 'btnSave', type: 'Button' });
      await insertComponent(t, applicationId, alphaId, { name: 'btnCancel', type: 'Button' });
      await t.owner.query(`UPDATE component SET on_select = $2, description = $3 WHERE id = $1`, [
        button.id,
        '-Set(gUser, 1)',
        'Saves the form',
      ]);
      const user = await insertVariable(t, applicationId, {
        name: 'gUser',
        scope: 'GLOBAL',
        originScreenId: alphaId,
        environments: [{ environment: 'DEV' }, { environment: 'PROD' }],
      });
      await insertVariable(t, applicationId, { name: 'gAdmin', scope: 'GLOBAL', originScreenId: null });
      const items = await insertCollection(t, applicationId, { name: 'colItems' });
      await insertCollection(t, applicationId, { name: 'colFree' });
      await t.owner.query(
        `INSERT INTO collection_field (collection_id, name, data_type, position, description) VALUES
           ($1, 'second', 'TEXT', 2, 'The second one'), ($1, 'first', 'NUMBER', 1, 'The first one')`,
        [items.id],
      );
      await insertScreenCollection(t, {
        screenId: alphaId,
        collectionId: items.id,
        accessMode: 'READ',
        usedIn: 'OnVisible',
      });
      await insertDependency(t, { sourceId: alphaId, targetId: zetaId, relationType: 'NAVIGATES_TO' });
      assert.ok(user.id > 0 && application.id > 0);
    } catch (error) {
      await t.close();
      throw error;
    }
  });
  after(async () => {
    pgOverlap.stop();
    await t.close();
  });

  /** A worker over the test app; `config` overrides limits, `generators` replaces the real threads. */
  const makeWorker = (
    over: {
      config?: Partial<ReportsConfig>;
      generators?: { PDF?: Generator; XLSX?: Generator };
      hooks?: WorkerHooks;
      maxContentChars?: number;
    } = {},
  ): ReportWorker => {
    const worker = createApplicationReportWorker(
      { db: t.db, logger: t.built.logger, jira: t.built.jira, config: { ...t.config.reports, ...over.config } },
      {
        ...(over.generators === undefined ? {} : { generators: over.generators }),
        ...(over.hooks === undefined ? {} : { hooks: over.hooks }),
        ...(over.maxContentChars === undefined ? {} : { maxContentChars: over.maxContentChars }),
      },
    );
    created.push(worker);
    return worker;
  };

  /** Every worker a test creates, stopped after it (a thread that is still alive is terminated by `stop()`). */
  const created: ReportWorker[] = [];

  // Each test sees only its own reports: whatever an earlier test left PENDING (a failed assertion between the request
  // and the pass) is removed, because a pass takes the OLDEST pending report, not the one the test just asked for.
  beforeEach(async () => {
    await t.owner.query(`DELETE FROM report WHERE status = 'PENDING'`);
  });
  afterEach(async () => {
    await Promise.all(created.splice(0).map((worker) => worker.stop()));
  });

  /**
   * One pass of the worker, which must end as `expected`. When it does not, the message says why the worker logged
   * (kind of failure, class and code of the error, database codes, first frames; never content).
   */
  const expectPass = async (worker: ReportWorker, expected: RunResult): Promise<void> => {
    const from = t.logs.length;
    const got = await worker.runOnce();
    assert.equal(
      got,
      expected,
      `the pass ended "${got}", expected "${expected}"${explainWorkerFailures(t.logs.slice(from))}`,
    );
  };

  /** Saves a PENDING report the way the endpoint does (the fixture writes the same row). */
  const request = (
    over: {
      format?: 'PDF' | 'XLSX';
      scope?: Record<string, unknown>;
      publish?: boolean;
      generatedBy?: number;
      title?: string;
      applicationId?: number;
    } = {},
  ): Promise<number> => {
    const format = over.format ?? 'XLSX';
    return insertReport(t, {
      applicationId: over.applicationId ?? applicationId,
      format,
      status: 'PENDING',
      ...(over.title === undefined ? {} : { title: over.title }),
      ...(over.generatedBy === undefined ? {} : { generatedBy: over.generatedBy }),
      parameters: {
        format,
        scope: over.scope ?? {
          elementTypes: [...ALL_TYPES],
          includeStatusSummary: true,
          includeDependencies: true,
        },
        publish: over.publish ?? false,
      },
    });
  };
  const detail = async (id: number): Promise<ReportBody> =>
    reportOf(await asUser(t, t.users.admin.token).get(`/reports/${id}`));
  /** The log lines of one report. */
  const logsOf = (id: number) =>
    t.logs.map((line) => JSON.parse(line) as Record<string, unknown>).filter((entry) => entry['reportId'] === id);

  /** Generators that keep the content they were given and return a tiny file. */
  const capturing = (into: { pdf?: ReportContent; xlsx?: ReportContent }) => ({
    PDF: (content: ReportContent) => {
      into.pdf = content;
      return Promise.resolve({
        buffer: Buffer.from('%PDF-1.7 stub'),
        mimeType: 'application/pdf',
        replacedCharacters: 0,
      });
    },
    XLSX: (content: ReportContent) => {
      into.xlsx = content;
      return Promise.resolve({
        buffer: Buffer.from('PK stub'),
        mimeType: 'application/octet-stream',
        replacedCharacters: 0,
      });
    },
  });

  it('with nothing PENDING the pass is idle', { timeout: TEST_TIMEOUT_MS }, async () => {
    assert.equal(await makeWorker().runOnce(), 'idle');
  });

  describe('Excel', () => {
    it(
      'writes a real workbook with the parts, columns and order of D-116, neutralized text, and the dashboard figures',
      { timeout: TEST_TIMEOUT_MS },
      async () => {
        const id = await request({ format: 'XLSX', title: 'Estado de la documentación – SAR', publish: false });
        await expectPass(makeWorker(), 'ready');
        const report = await detail(id);
        assert.equal(report.status, 'READY', explainWorkerFailures(t.logs));
        assert.match(report.fileName ?? '', /^estado-de-la-documentacion-sar-\d{4}-\d{2}-\d{2}\.xlsx$/);
        assert.equal(report.fileName, `estado-de-la-documentacion-sar-${report.completedAt?.slice(0, 10)}.xlsx`);
        const stored = (await fileOf(t, id))!;
        assert.equal(stored.mimeType, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        assert.deepEqual([...stored.content.subarray(0, 4)], [0x50, 0x4b, 0x03, 0x04]);
        assert.equal(report.fileSize, stored.content.length);

        const workbook = await readWorkbook(stored.content);
        assert.deepEqual(
          workbook.worksheets.map((s) => s.name),
          Object.keys(COLUMNS),
        );
        for (const sheet of workbook.worksheets) assert.deepEqual(sheetHeader(sheet), COLUMNS[sheet.name], sheet.name);

        // Screens: by name in code-point order; the template text is neutralized and the long one is whole.
        const screens = sheetRows(workbook.getWorksheet('Screens')!);
        const names = screens.map((row) => text(row[0]));
        assert.deepEqual(names, [...names].sort(byCodePoint));
        assert.deepEqual(names.slice(0, 1), ['Alpha']);
        assert.equal(names.at(-1), 'alpha');
        const alpha = screens[0]!;
        assert.equal(alpha[1], 'APPROVED');
        assert.equal(alpha[5], "'=Navigate(Home)", 'on start begins with = : forced to text');
        assert.equal(text(alpha[6]).length, 20_000, 'the longest field is whole');
        assert.equal(alpha[7], 'Layers: UI > Data');

        // Components: by screen, component and id; the formula is text.
        const components = sheetRows(workbook.getWorksheet('Components')!);
        assert.deepEqual(
          components.map((row) => [row[0], row[1]]),
          [
            ['Alpha', 'btnCancel'],
            ['Alpha', 'btnSave'],
          ],
        );
        assert.equal(components[1]![4], "'-Set(gUser, 1)");

        // Variables, with the environments as `DEV, PROD`, and the collections with their fields in position order.
        const variables = sheetRows(workbook.getWorksheet('Variables')!);
        assert.deepEqual(
          variables.map((row) => row[0]),
          ['gAdmin', 'gUser'],
        );
        assert.deepEqual([variables[1]![2], variables[1]![3], variables[1]![5]], ['GLOBAL', 'Alpha', 'DEV, PROD']);
        assert.equal(variables[0]![3] ?? null, null, 'no origin screen');
        const collections = sheetRows(workbook.getWorksheet('Collections')!);
        assert.deepEqual(
          collections.map((row) => [row[0], row[4]]),
          [
            ['colFree', 'No'],
            ['colItems', 'Yes'],
          ],
        );
        const fields = sheetRows(workbook.getWorksheet('Collection fields')!);
        assert.deepEqual(
          fields.map((row) => [row[0], row[1], row[2]]),
          [
            ['colItems', 1, 'first'],
            ['colItems', 2, 'second'],
          ],
        );

        // Dependencies: the edge between the two screens, with relation, types and names.
        const dependencies = sheetRows(workbook.getWorksheet('Dependencies')!);
        assert.ok(dependencies.some((row) => row[0] === 'NAVIGATES_TO' && row[2] === 'Alpha' && row[4] === 'Zeta'));

        // Summary: the same figures as GET /dashboard/indicators (D-106).
        const indicators = indicatorsOf(await getIndicators(t, applicationId));
        const summary = new Map(sheetRows(workbook.getWorksheet('Summary')!).map((row) => [text(row[0]), row[1]]));
        assert.equal(summary.get('Screens'), indicators.documentation.totalScreens);
        for (const [status, count] of Object.entries(indicators.documentation.byStatus)) {
          assert.equal(summary.get(`Screens ${status}`), count, status);
        }
        assert.equal(summary.get('Approved screens (%)'), indicators.documentation.approvedPercent);
        assert.equal(summary.get('Variables'), indicators.variables.total);
        assert.equal(summary.get('Variables without origin screen'), indicators.variables.untraced);
        assert.equal(summary.get('Collections'), indicators.collections.total);
        assert.equal(summary.get('Collections not documented'), indicators.collections.undocumented);
        assert.equal(summary.get('Generated by'), 'Ada Admin');
        assert.ok(summary.get('Generated at (UTC)') instanceof Date);
      },
    );

    it(
      'the scope decides the parts: no screens, components, variables or collections means no such sheet',
      { timeout: TEST_TIMEOUT_MS },
      async () => {
        const id = await request({ scope: { elementTypes: ['VARIABLE'], includeDependencies: true } });
        await expectPass(makeWorker(), 'ready');
        const workbook = await readWorkbook((await fileOf(t, id))!.content);
        assert.deepEqual(
          workbook.worksheets.map((s) => s.name),
          ['Variables', 'Dependencies'],
        );
        assert.deepEqual(
          sheetRows(workbook.getWorksheet('Dependencies')!),
          [],
          'an edge needs both ends in the report',
        );
      },
    );

    it(
      'screenIds and documentationStatus filter the screens and, through them, the components',
      { timeout: TEST_TIMEOUT_MS },
      async () => {
        const id = await request({
          scope: {
            elementTypes: ['SCREEN', 'COMPONENT'],
            screenIds: [alphaId, zetaId],
            documentationStatus: ['APPROVED'],
          },
        });
        await expectPass(makeWorker(), 'ready');
        const workbook = await readWorkbook((await fileOf(t, id))!.content);
        assert.deepEqual(
          sheetRows(workbook.getWorksheet('Screens')!).map((r) => r[0]),
          ['Alpha'],
        );
        assert.deepEqual(
          sheetRows(workbook.getWorksheet('Components')!).map((r) => r[0]),
          ['Alpha', 'Alpha'],
        );
      },
    );
  });

  describe('PDF', () => {
    it(
      'writes a real PDF: signature, pages, Title and Author from the report; long text takes as many pages as it needs',
      { timeout: TEST_TIMEOUT_MS },
      async () => {
        const short = await request({ format: 'PDF', title: 'Variables only', scope: { elementTypes: ['VARIABLE'] } });
        const long = await request({
          format: 'PDF',
          title: '=Pantalla – ñandú',
          scope: { elementTypes: ['SCREEN'], screenIds: [alphaId] },
        });
        const worker = makeWorker();
        await expectPass(worker, 'ready');
        await expectPass(worker, 'ready');
        const shortFile = (await fileOf(t, short))!;
        const longFile = (await fileOf(t, long))!;
        assert.equal(shortFile.mimeType, 'application/pdf');
        assert.equal(longFile.content.subarray(0, 5).toString('latin1'), '%PDF-');
        const shortFacts = pdfFacts(shortFile.content);
        const longFacts = pdfFacts(longFile.content);
        assert.equal(shortFacts.pages, 1);
        assert.ok(longFacts.pages >= 4, `20000 characters need several pages (${longFacts.pages})`);
        assert.equal(longFacts.title, '=Pantalla – ñandú');
        assert.equal(longFacts.author, 'Ada Admin');
        assert.equal(shortFacts.title, 'Variables only');
      },
    );

    it(
      'a character the font cannot draw is replaced by "?" and logged once, with the count and never the text',
      { timeout: TEST_TIMEOUT_MS },
      async () => {
        const screen = await insertScreen(t, applicationId, { name: 'Pantalla 中文' });
        const id = await request({ format: 'PDF', scope: { elementTypes: ['SCREEN'], screenIds: [screen.id] } });
        await expectPass(makeWorker(), 'ready');
        const warnings = logsOf(id).filter((entry) => String(entry['msg']).includes('without a glyph'));
        assert.equal(warnings.length, 1);
        assert.equal(warnings[0]!['replacedCharacters'], 2);
        assert.ok(!JSON.stringify(logsOf(id)).includes('中'));
      },
    );

    it('PDF and Excel get the very same content, in the same order', { timeout: TEST_TIMEOUT_MS }, async () => {
      const seen: { pdf?: ReportContent; xlsx?: ReportContent } = {};
      const worker = makeWorker({ generators: capturing(seen) });
      await request({ format: 'PDF', title: 'Same' });
      await request({ format: 'XLSX', title: 'Same' });
      await expectPass(worker, 'ready');
      await expectPass(worker, 'ready');
      assert.ok(seen.pdf && seen.xlsx);
      assert.deepEqual(
        seen.pdf.sections.map((s) => s.name),
        seen.xlsx.sections.map((s) => s.name),
      );
      // The only difference between the two is the instant ("Generated at"), read at the start of each pass.
      const strip = (c: ReportContent) =>
        c.sections.map((s) => ({
          ...s,
          rows: s.name === 'Summary' ? s.rows.filter((r) => r[0] !== 'Generated at (UTC)') : s.rows,
        }));
      assert.deepEqual(strip(seen.pdf), strip(seen.xlsx));
    });
  });

  describe('publishing', () => {
    it(
      'READY sets the file data, completedAt and, when the request said so, isPublished and publishedAt together',
      { timeout: TEST_TIMEOUT_MS },
      async () => {
        const published = await request({ publish: true });
        const hidden = await request({ publish: false });
        const worker = makeWorker({ generators: capturing({}) });
        await expectPass(worker, 'ready');
        await expectPass(worker, 'ready');
        const yes = await detail(published);
        assert.deepEqual([yes.status, yes.isPublished], ['READY', true]);
        assert.equal(yes.publishedAt, yes.completedAt, 'in the same update');
        assert.ok(yes.fileName && yes.fileSize !== null && yes.completedAt);
        const no = await detail(hidden);
        assert.deepEqual([no.status, no.isPublished, no.publishedAt], ['READY', false, null]);
        assert.equal((await asUser(t, t.users.reader.token).get(`/reports/${hidden}`)).status, 404);
        assert.equal((await asUser(t, t.users.reader.token).get(`/reports/${published}`)).status, 200);
      },
    );

    it('a report in an archived application can be generated (D-47)', { timeout: TEST_TIMEOUT_MS }, async () => {
      const archived = (await insertApplication(t, { status: 'ARCHIVED' })).id;
      const id = await request({ applicationId: archived, scope: { elementTypes: ['VARIABLE'] } });
      await expectPass(makeWorker({ generators: capturing({}) }), 'ready');
      assert.equal((await detail(id)).status, 'READY');
    });
  });

  describe('a report that cannot be made is FAILED with one of the four texts of D-119', () => {
    /** The report is FAILED, with that text, never published, with no file and no completion. */
    const assertFailed = async (id: number, text: string): Promise<void> => {
      const report = await detail(id);
      assert.equal(report.status, 'FAILED');
      assert.equal(report.errorMessage, text);
      assert.deepEqual(
        [report.isPublished, report.completedAt, report.publishedAt, report.fileName, report.fileSize],
        [false, null, null, null, null],
      );
      assert.equal(await fileOf(t, id), null);
    };

    it('too slow: the thread is terminated at the deadline', { timeout: TEST_TIMEOUT_MS }, async () => {
      const id = await request({ format: 'PDF', publish: true });
      const worker = makeWorker({
        config: { maxSeconds: 1 },
        generators: {
          PDF: (content, context) =>
            runInThread({
              format: 'PDF',
              content,
              maxBytes: context.maxBytes,
              maxMemoryMb: 64,
              deadlineMs: context.deadlineMs,
              signal: context.signal,
              entry: new URL('spinThread.ts', THREADS),
            }),
        },
      });
      await expectPass(worker, 'failed');
      await assertFailed(id, REPORT_ERROR_MESSAGES.TOO_SLOW);
    });

    it(
      'too large: a thread that runs out of memory, a file over maxBytes, too many rows, too much text',
      { timeout: TEST_TIMEOUT_MS },
      async () => {
        const oom = await request({ format: 'PDF' });
        const memory = makeWorker({
          generators: {
            PDF: (content, context) =>
              runInThread({
                format: 'PDF',
                content,
                maxBytes: context.maxBytes,
                maxMemoryMb: 64,
                deadlineMs: context.deadlineMs,
                signal: context.signal,
                entry: new URL('oomThread.ts', THREADS),
              }),
          },
        });
        await expectPass(memory, 'failed');
        await assertFailed(oom, REPORT_ERROR_MESSAGES.TOO_LARGE);

        const bytes = await request({ format: 'XLSX' });
        await expectPass(makeWorker({ config: { maxBytes: 5 }, generators: capturing({}) }), 'failed');
        await assertFailed(bytes, REPORT_ERROR_MESSAGES.TOO_LARGE);

        const rows = await request({ format: 'XLSX' });
        await expectPass(makeWorker({ config: { maxRows: 3 }, generators: capturing({}) }), 'failed');
        await assertFailed(rows, REPORT_ERROR_MESSAGES.TOO_LARGE);
      },
    );

    it(
      'too large before reading: when the text of the report is over the limit, no part is read at all',
      { timeout: TEST_TIMEOUT_MS },
      async () => {
        const id = await request({ format: 'XLSX' });
        const read: string[] = [];
        const worker = makeWorker({
          maxContentChars: 100,
          generators: capturing({}),
          hooks: { afterSection: (name) => Promise.resolve(void read.push(name)) },
        });
        await expectPass(worker, 'failed');
        await assertFailed(id, REPORT_ERROR_MESSAGES.TOO_LARGE);
        assert.deepEqual(read, [], 'the size is known from one aggregate query, before any content is read');
        assert.ok(logsOf(id).some((entry) => entry['limit'] === 'chars'));
      },
    );

    it('a deleted screen: the screens of the request that no longer exist', { timeout: TEST_TIMEOUT_MS }, async () => {
      const doomed = await insertScreen(t, applicationId, { name: 'Doomed' });
      const id = await request({ scope: { elementTypes: ['SCREEN'], screenIds: [alphaId, doomed.id] } });
      await t.owner.query(`DELETE FROM screen WHERE id = $1`, [doomed.id]);
      await expectPass(makeWorker({ generators: capturing({}) }), 'failed');
      await assertFailed(id, REPORT_ERROR_MESSAGES.SCREEN_GONE);
    });

    it(
      'any other failure: the generic text; the detail goes to the log with the id and without the content',
      { timeout: TEST_TIMEOUT_MS },
      async () => {
        const id = await request({ format: 'XLSX' });
        const worker = makeWorker({
          generators: {
            XLSX: () => Promise.reject(new Error(`could not write the report of ${PII}`)),
          },
        });
        await expectPass(worker, 'failed');
        await assertFailed(id, REPORT_ERROR_MESSAGES.OTHER);
        const failure = logsOf(id).find((entry) => entry['msg'] === 'report generation failed');
        assert.ok(failure, 'the failure is logged with the id of the report');
        assert.equal(failure['failure'], 'OTHER');
        assert.ok(!t.logs.join('\n').includes(PII), 'the text of the exception is not logged');
        assert.ok(!JSON.stringify(await detail(id)).includes(PII));
      },
    );

    it(
      'a database error leaves the transaction unusable: it is rolled back and FAILED is written in a new one',
      { timeout: TEST_TIMEOUT_MS },
      async () => {
        const id = await request({ scope: { elementTypes: ['COLLECTION'] } });
        await t.owner.query(`REVOKE SELECT ON collection_field FROM docs_app`);
        try {
          await expectPass(makeWorker({ generators: capturing({}) }), 'failed');
        } finally {
          await t.owner.query(`GRANT SELECT ON collection_field TO docs_app`);
        }
        await assertFailed(id, REPORT_ERROR_MESSAGES.OTHER);
        assert.ok(logsOf(id).some((entry) => String(entry['msg']).includes('new transaction')));
      },
    );

    it(
      'a failed report is never published, and its text is the only thing a client reads',
      { timeout: TEST_TIMEOUT_MS },
      async () => {
        const id = await request({ publish: true, generatedBy: t.users.developer.id });
        const worker = makeWorker({ generators: { XLSX: () => Promise.reject(new Error(PII)) } });
        await expectPass(worker, 'failed');
        const report = await detail(id);
        assert.deepEqual([report.status, report.isPublished], ['FAILED', false]);
        assert.equal(
          (await asUser(t, t.users.admin.token).put(`/reports/${id}/publication`, { isPublished: true })).status,
          409,
        );
        assert.equal(bodyOf(await asUser(t, t.users.admin.token).get(`/reports/${id}/file`)).code, 'REPORT_NOT_READY');
      },
    );
  });

  describe('the snapshot', () => {
    it(
      'the report shows the documentation as it was when the generation started, even if it changes meanwhile',
      { timeout: TEST_TIMEOUT_MS },
      async () => {
        const seen: { xlsx?: ReportContent } = {};
        const id = await request({ scope: { elementTypes: ['SCREEN', 'VARIABLE'], includeStatusSummary: true } });
        let changed = false;
        const worker = makeWorker({
          generators: capturing(seen),
          hooks: {
            // After the screens were read, other users change the documentation and commit.
            afterSection: async (name) => {
              if (name !== 'Screens' || changed) return;
              changed = true;
              await t.owner.query(`UPDATE screen SET name = 'Renamed meanwhile' WHERE id = $1`, [zetaId]);
              await t.owner.query(
                `UPDATE variable SET name = 'gRenamedMeanwhile' WHERE name = 'gUser' AND application_id = $1`,
                [applicationId],
              );
              await insertVariable(t, applicationId, { name: 'gAddedMeanwhile', scope: 'GLOBAL' });
              await t.owner.query(`DELETE FROM variable WHERE name = 'gAdmin' AND application_id = $1`, [
                applicationId,
              ]);
            },
          },
        });
        try {
          await expectPass(worker, 'ready');
          assert.ok(changed);
          const variables = seen.xlsx!.sections.find((s) => s.name === 'Variables')!;
          assert.deepEqual(
            variables.rows
              .map((r) => r[0])
              .filter((n) => String(n).startsWith('g'))
              .sort(),
            ['gAdmin', 'gUser'],
          );
          const screens = seen.xlsx!.sections.find((s) => s.name === 'Screens')!;
          assert.ok(
            screens.rows.some((r) => r[0] === 'Zeta') && !screens.rows.some((r) => r[0] === 'Renamed meanwhile'),
          );
          const summary = new Map(seen.xlsx!.sections[0]!.rows.map((r) => [r[0], r[1]]));
          assert.equal(summary.get('Variables'), 2, 'the summary was read in the same snapshot');
          assert.equal((await detail(id)).status, 'READY');
        } finally {
          await t.owner.query(`UPDATE screen SET name = 'Zeta' WHERE id = $1`, [zetaId]);
          await t.owner.query(`UPDATE variable SET name = 'gUser' WHERE name = 'gRenamedMeanwhile'`);
          await t.owner.query(`DELETE FROM variable WHERE name = 'gAddedMeanwhile' AND application_id = $1`, [
            applicationId,
          ]);
          await insertVariable(t, applicationId, { name: 'gAdmin', scope: 'GLOBAL', originScreenId: null });
        }
      },
    );
  });

  describe('the audit', () => {
    it(
      'the writes of the worker are attributed to the user who asked for the report (generated_by), READY and FAILED',
      { timeout: TEST_TIMEOUT_MS },
      async () => {
        const ready = await request({ generatedBy: t.users.developer.id });
        const failed = await request({ generatedBy: t.users.reader.id, title: 'Will fail' });
        const worker = makeWorker({
          generators: {
            XLSX: (content) =>
              content.title === 'Will fail' ? Promise.reject(new Error('x')) : capturing({}).XLSX(content),
          },
        });
        await expectPass(worker, 'ready');
        await expectPass(worker, 'failed');
        const readyRecords = (await auditOfReport(t, ready, 'UPDATE')).filter((r) =>
          r.changed_fields.includes('status'),
        );
        assert.deepEqual(
          readyRecords.map((r) => r.actor_user_id),
          [t.users.developer.id],
        );
        const failedRecords = (await auditOfReport(t, failed, 'UPDATE')).filter((r) =>
          r.changed_fields.includes('status'),
        );
        assert.deepEqual(
          failedRecords.map((r) => r.actor_user_id),
          [t.users.reader.id],
        );
        const { rows } = await t.owner.query<{ n: string }>(
          `SELECT count(*) AS n FROM audit_log WHERE entity_type = 'report_file'`,
        );
        assert.equal(rows[0]!.n, '0', 'report_file is not audited (D-18)');
      },
    );

    it('also when FAILED is written in a new transaction', { timeout: TEST_TIMEOUT_MS }, async () => {
      const id = await request({ scope: { elementTypes: ['COLLECTION'] }, generatedBy: t.users.developer.id });
      await t.owner.query(`REVOKE SELECT ON collection_field FROM docs_app`);
      try {
        await expectPass(makeWorker({ generators: capturing({}) }), 'failed');
      } finally {
        await t.owner.query(`GRANT SELECT ON collection_field TO docs_app`);
      }
      const records = (await auditOfReport(t, id, 'UPDATE')).filter((r) => r.changed_fields.includes('status'));
      assert.deepEqual(
        records.map((r) => r.actor_user_id),
        [t.users.developer.id],
      );
    });
  });

  describe('files it must not create', () => {
    it(
      'generating a PDF and an Excel with the real threads writes nothing to the temporary directory or the project',
      { timeout: TEST_TIMEOUT_MS },
      async () => {
        const sandbox = mkdtempSync(join(tmpdir(), 'reports-tmp-'));
        const saved = { TMPDIR: process.env['TMPDIR'], TEMP: process.env['TEMP'], TMP: process.env['TMP'] };
        process.env['TMPDIR'] = process.env['TEMP'] = process.env['TMP'] = sandbox; // what os.tmpdir() reads
        const project = readdirSync('.').sort();
        try {
          assert.equal(tmpdir(), sandbox);
          const pdf = await request({ format: 'PDF' });
          const xlsx = await request({ format: 'XLSX' });
          const worker = makeWorker();
          await expectPass(worker, 'ready');
          await expectPass(worker, 'ready');
          assert.ok((await fileOf(t, pdf)) && (await fileOf(t, xlsx)));
          // `tsx` keeps its own transform cache in the temporary directory (`tsx-<user>`) when it loads the thread from `src/`;
          // that is the test runner, and `dist/` has none (checked by hand with the compiled build).
          assert.deepEqual(
            readdirSync(sandbox).filter((name) => !name.startsWith('tsx-')),
            [],
            'nothing in os.tmpdir()',
          );
          assert.deepEqual(readdirSync('.').sort(), project, 'nothing in the project directory');
        } finally {
          for (const [name, value] of Object.entries(saved)) {
            if (value === undefined) delete process.env[name];
            else process.env[name] = value;
          }
          rmSync(sandbox, { recursive: true, force: true });
        }
      },
    );
  });

  describe('stopping', () => {
    it(
      'stop() waits for the report that is being generated when it has the time',
      { timeout: TEST_TIMEOUT_MS },
      async () => {
        const id = await request({});
        let release!: () => void;
        const gate = new Promise<void>((resolve) => (release = resolve));
        let started!: () => void;
        const running = new Promise<void>((resolve) => (started = resolve));
        const worker = makeWorker({
          config: { shutdownGraceMs: 60_000 },
          generators: {
            XLSX: async (content) => {
              started();
              await gate;
              return capturing({}).XLSX(content);
            },
          },
        });
        const pass = worker.runOnce();
        await running;
        const stopped = worker.stop();
        release();
        await stopped;
        assert.equal(await pass, 'ready');
        assert.equal((await detail(id)).status, 'READY');
        assert.equal(await worker.runOnce(), 'idle', 'a stopped worker takes no new report');
      },
    );

    it(
      'when the time is over the report is given up: it goes back to PENDING and its lock is released',
      { timeout: TEST_TIMEOUT_MS },
      async () => {
        const id = await request({});
        let started!: () => void;
        const running = new Promise<void>((resolve) => (started = resolve));
        const worker = makeWorker({
          config: { shutdownGraceMs: 0 },
          generators: {
            XLSX: (_content, context) =>
              new Promise((_resolve, reject) => {
                started();
                context.signal.addEventListener('abort', () => reject(new ReportAbandonedError()), { once: true });
              }),
          },
        });
        const pass = worker.runOnce();
        await running;
        await worker.stop();
        assert.equal(await pass, 'abandoned');
        const report = await detail(id);
        assert.deepEqual([report.status, report.errorMessage], ['PENDING', null]);
        // The row is not locked any more: another worker takes it at once.
        const again = await makeWorker({ generators: capturing({}) }).runOnce();
        assert.equal(again, 'ready');
      },
    );
  });
});
