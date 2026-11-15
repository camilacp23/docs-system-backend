/**
 * The generator thread (D-44; `runGenerator.ts`): what each way of failing becomes, that the thread is isolated from the
 * API (memory, time, shutdown, what it can import and what an error of it can say), the flags it starts with, and that it
 * writes real files. Parameters of the module, never environment variables; nothing waits a fixed time: every wait is for
 * the event that decides (the thread's answer, its exit).
 */
import '../helpers/env.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { ReportContent } from '../../src/modules/reports/content.js';
import {
  ReportAbandonedError,
  ReportThreadError,
  ReportTooLargeError,
  ReportTooSlowError,
} from '../../src/modules/reports/failures.js';
import { runInThread, threadExecArgv, type ThreadRun } from '../../src/jobs/reports/runGenerator.js';

const here = dirname(fileURLToPath(import.meta.url));
const thread = (name: string): URL => new URL(`../helpers/threads/${name}.ts`, import.meta.url);

const CONTENT: ReportContent = {
  title: 'Tiny',
  application: 'App',
  generatedBy: 'Ada',
  generatedAt: new Date(Date.UTC(2026, 10, 14, 12)),
  sections: [
    {
      name: 'Variables',
      layout: 'records',
      columns: [
        { header: 'Name', width: 20 },
        { header: 'Description', width: 40 },
      ],
      rows: [['gUser', 'The current user']],
    },
  ],
};

const run = (over: Partial<ThreadRun> = {}): Promise<Awaited<ReturnType<typeof runInThread>>> =>
  runInThread({
    format: 'PDF',
    content: CONTENT,
    maxBytes: 1_000_000,
    maxMemoryMb: 256,
    deadlineMs: Date.now() + 60_000,
    signal: new AbortController().signal,
    ...over,
  });

describe('generator thread', () => {
  it('writes a real PDF and a real Excel in the thread and transfers the bytes', async () => {
    const pdf = await run({ format: 'PDF' });
    assert.equal(pdf.buffer.subarray(0, 5).toString('latin1'), '%PDF-');
    assert.equal(pdf.mimeType, 'application/pdf');
    assert.ok(pdf.heapPeakMb !== undefined && pdf.heapPeakMb > 0);
    const xlsx = await run({ format: 'XLSX' });
    assert.deepEqual([...xlsx.buffer.subarray(0, 4)], [0x50, 0x4b, 0x03, 0x04]);
  });

  it('a thread that runs out of memory dies alone: the report is "too large" and the process goes on', async () => {
    await assert.rejects(run({ entry: thread('oomThread'), maxMemoryMb: 64 }), (error) => {
      assert.ok(error instanceof ReportTooLargeError);
      assert.equal(error.limit, 'memory');
      return true;
    });
    assert.ok((await run()).buffer.length > 0, 'the next report is generated normally');
  });

  it('a thread in a synchronous block is terminated at the deadline: "took too long"', async () => {
    await assert.rejects(run({ entry: thread('spinThread'), deadlineMs: Date.now() + 300 }), ReportTooSlowError);
  });

  it('a deadline that has already passed terminates the thread at once', async () => {
    await assert.rejects(run({ deadlineMs: Date.now() - 1 }), ReportTooSlowError);
  });

  it('the shutdown signal terminates the thread and gives the report up', async () => {
    const controller = new AbortController();
    const pending = run({ entry: thread('spinThread'), signal: controller.signal });
    controller.abort();
    await assert.rejects(pending, ReportAbandonedError);
    await assert.rejects(run({ signal: controller.signal }), ReportAbandonedError, 'already aborted: no thread');
  });

  it('a PDF bigger than maxBytes is "too large" (the thread says so while it writes)', async () => {
    await assert.rejects(run({ maxBytes: 10 }), (error) => error instanceof ReportTooLargeError);
  });

  it('the text of an error of the thread never reaches the API process', async () => {
    await assert.rejects(run({ entry: thread('throwThread') }), (error) => {
      assert.ok(error instanceof ReportThreadError);
      const everything = JSON.stringify({ message: error.message, name: error.name, errorClass: error.errorClass });
      assert.ok(!everything.includes('ana.perez'));
      assert.ok(!everything.includes('7731'));
      assert.equal(error.errorClass, 'Error');
      return true;
    });
  });

  describe('the flags of the thread', () => {
    it('from dist/ it inherits none, whatever the process has; from src/ it inherits them', () => {
      const parent = ['--inspect=127.0.0.1:9229', '--max-old-space-size=4096', '--import', 'tsx'];
      assert.deepEqual(threadExecArgv(parent, false), []);
      assert.deepEqual(threadExecArgv(parent, true), parent);
      assert.notEqual(threadExecArgv(parent, true), parent, 'a copy');
    });

    it('a thread started with explicit flags runs with exactly those', async () => {
      const result = await run({ entry: thread('argvThread'), execArgv: ['--import', 'tsx'] });
      assert.deepEqual(JSON.parse(result.buffer.toString('utf8')), ['--import', 'tsx']);
    });
  });

  describe('what the thread can import', () => {
    /** The files that `file` imports as values (type-only imports leave no trace at run time), relative ones only. */
    const importsOf = (file: string): string[] => {
      const source = readFileSync(file, 'utf8');
      const found: string[] = [];
      for (const match of source.matchAll(/^(?:import|export)\s+(?!type\b)[^;]*?from\s+'(\.[^']+)'/gm)) {
        found.push(match[1]!);
      }
      for (const match of source.matchAll(/import\('(\.[^']+)'\)/g)) found.push(match[1]!);
      return found.map((spec) => resolve(dirname(file), spec.replace(/\.js$/, '.ts')));
    };

    it('nothing from src/db, src/config, src/security, src/http or the Jira client, directly or through its imports', () => {
      const entry = resolve(here, '../../src/jobs/reports/generatorThread.ts');
      const seen = new Set<string>();
      const walk = (file: string): void => {
        if (seen.has(file)) return;
        seen.add(file);
        for (const next of importsOf(file)) walk(next);
      };
      walk(entry);
      const forbidden = /[\\/]src[\\/](db|config|security|http|integrations|generated)[\\/]/;
      const offenders = [...seen].filter((file) => forbidden.test(file));
      assert.deepEqual(offenders, []);
      assert.ok(seen.size >= 4, 'the walk reached the generators');
    });
  });
});
