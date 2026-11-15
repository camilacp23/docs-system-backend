/**
 * Report generation at the scale of a department (`npm run test:perf:reports`; outside `npm test`, D-119): how long it
 * takes, how big the file is, how much memory the process and the generator thread use, and how long the event loop of
 * the API process (the main thread) is blocked while a report is generated, for the largest report (every part, with the
 * dependencies). The figures are printed as `[perf]` lines; the thresholds of the worker (`REPORT_MAX_SECONDS`,
 * `REPORT_MAX_BYTES`, `REPORT_MAX_MEMORY_MB`, `REPORT_MAX_ROWS`) are decided from them.
 *
 * Knobs (environment, this test only): `REPORT_PERF_TEXT` (`realistic` | `random`), `REPORT_PERF_FACTOR` (multiplies the
 * 500 screens, 3000 components, ... of the department), `REPORT_PERF_CHARS` (characters of each of the seven template
 * fields), `REPORT_PERF_FORMAT` (`PDF` | `XLSX`) and the limits of the worker (`REPORT_MAX_*`), which the application reads
 * like in production. The test fails only when the outcome is not READY or FAILED, or when the main thread was blocked
 * for longer than a request could stand.
 */
import '../helpers/env.js';
import assert from 'node:assert/strict';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { after, before, describe, it } from 'node:test';
import { startTestApp, type TestApp } from '../helpers/app.js';
import { insertApplication } from '../helpers/fixtures.js';
import { insertReport, reportOf } from '../helpers/reports.js';
import { DEPARTMENT_SCALE, loadReportData, type ReportScale, type TextKind } from '../helpers/reportsScale.js';
import { runInThread } from '../../src/jobs/reports/runGenerator.js';
import { asUser } from '../helpers/users.js';

const env = (name: string): string | undefined => process.env[name];
const FACTOR = Number(env('REPORT_PERF_FACTOR') ?? '1');
const CHARS = Number(env('REPORT_PERF_CHARS') ?? DEPARTMENT_SCALE.templateChars);
const TEXT = (env('REPORT_PERF_TEXT') ?? 'realistic') as TextKind;
const ONLY = env('REPORT_PERF_FORMAT');
const LIMITS = Object.fromEntries(
  ['REPORT_MAX_SECONDS', 'REPORT_MAX_BYTES', 'REPORT_MAX_MEMORY_MB', 'REPORT_MAX_ROWS'].flatMap((name) => {
    const value = env(name);
    return value === undefined ? [] : [[name, value] as const];
  }),
);

const at = (scale: ReportScale, factor: number): ReportScale => ({
  ...scale,
  screens: Math.max(1, Math.round(scale.screens * factor)),
  components: Math.max(1, Math.round(scale.components * factor)),
  variables: Math.max(1, Math.round(scale.variables * factor)),
  collections: Math.max(1, Math.round(scale.collections * factor)),
  navigations: Math.round(scale.navigations * factor),
  templateChars: CHARS,
});

const ms = (ns: number): number => Math.round(ns / 1e6);
const mb = (bytes: number): number => Math.round(bytes / 1_048_576);

describe('reports: generation at the scale of a department', () => {
  let t: TestApp;
  let applicationId: number;
  const scale = at(DEPARTMENT_SCALE, FACTOR);

  before(async () => {
    t = await startTestApp({ env: LIMITS });
    try {
      applicationId = (await insertApplication(t)).id;
      const started = performance.now();
      await loadReportData(t, applicationId, scale, TEXT);
      console.log(
        `[perf] ${TEXT} text, ${scale.screens} screens x ${scale.templateChars} chars, factor ${FACTOR}: data loaded in ` +
          `${Math.round(performance.now() - started)} ms; limits ${JSON.stringify(t.config.reports)}`,
      );
    } catch (error) {
      await t.close();
      throw error;
    }
  });
  after(() => t.close());

  for (const format of (['PDF', 'XLSX'] as const).filter((f) => ONLY === undefined || ONLY === f)) {
    it(`${format}: every part and the dependencies`, async () => {
      const id = await insertReport(t, {
        applicationId,
        format,
        status: 'PENDING',
        parameters: {
          format,
          scope: {
            elementTypes: ['SCREEN', 'COMPONENT', 'VARIABLE', 'COLLECTION'],
            includeStatusSummary: true,
            includeDependencies: true,
          },
          publish: false,
        },
      });
      const loop = monitorEventLoopDelay({ resolution: 10 });
      loop.enable();
      const rssBefore = process.memoryUsage().rss;
      let peak = rssBefore;
      const sampler = setInterval(() => (peak = Math.max(peak, process.memoryUsage().rss)), 25);
      const started = performance.now();
      const result = await t.built.reportWorker.runOnce();
      const elapsed = performance.now() - started;
      clearInterval(sampler);
      loop.disable();
      const report = reportOf(await asUser(t, t.users.admin.token).get(`/reports/${id}`));
      const ready = t.logs
        .map((line) => JSON.parse(line) as { msg?: string; reportId?: number; heapPeakMb?: number })
        .find((entry) => entry.msg === 'report ready' && entry.reportId === id);
      console.log(
        `[perf] ${format} ${result}: ${report.status}${report.errorMessage === null ? '' : ` (${report.errorMessage})`} ` +
          `${Math.round(elapsed)} ms, ${report.fileSize === null ? '-' : `${(report.fileSize / 1_048_576).toFixed(1)} MB`}, ` +
          `process rss +${mb(peak - rssBefore)} MB, thread heap ${ready?.heapPeakMb ?? '-'} MB, ` +
          `main event loop p50=${ms(loop.percentile(50))} p99=${ms(loop.percentile(99))} max=${ms(loop.max)} ms`,
      );
      assert.ok(['READY', 'FAILED'].includes(report.status), report.status);
      assert.ok(ms(loop.max) < 2_000, 'the main thread was blocked for more than 2 s');
    });
  }

  it('the cost of the thread itself: create, load pdfkit or exceljs, generate a tiny report and end', async () => {
    const content = {
      title: 'Tiny',
      application: 'App',
      generatedBy: 'Ada',
      generatedAt: new Date(),
      sections: [
        {
          name: 'Variables',
          layout: 'records' as const,
          columns: [
            { header: 'Name', width: 20 },
            { header: 'Description', width: 40 },
          ],
          rows: [['gUser', 'The current user']],
        },
      ],
    };
    for (const format of ['PDF', 'XLSX'] as const) {
      const times: number[] = [];
      for (let round = 0; round < 6; round += 1) {
        const started = performance.now();
        await runInThread({
          format,
          content,
          maxBytes: 1_000_000,
          maxMemoryMb: 256,
          deadlineMs: Date.now() + 60_000,
          signal: new AbortController().signal,
        });
        times.push(Math.round(performance.now() - started));
      }
      const [first, ...rest] = times;
      rest.sort((a, b) => a - b);
      console.log(
        `[perf] thread ${format}: first ${first} ms, then median ${rest[Math.floor(rest.length / 2)]} ms (${times.join(', ')})`,
      );
    }
  });
});
