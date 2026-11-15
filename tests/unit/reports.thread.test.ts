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
import { runInThread, threadEnv, threadExecArgv, type ThreadRun } from '../../src/jobs/reports/runGenerator.js';

/** A thread test that has not finished by then is hung, not slow. Per test, never global. */
const TEST_TIMEOUT_MS = 30_000;

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
  it(
    'writes a real PDF and a real Excel in the thread and transfers the bytes',
    { timeout: TEST_TIMEOUT_MS },
    async () => {
      const pdf = await run({ format: 'PDF' });
      assert.equal(pdf.buffer.subarray(0, 5).toString('latin1'), '%PDF-');
      assert.equal(pdf.mimeType, 'application/pdf');
      assert.ok(pdf.heapPeakMb !== undefined && pdf.heapPeakMb > 0);
      const xlsx = await run({ format: 'XLSX' });
      assert.deepEqual([...xlsx.buffer.subarray(0, 4)], [0x50, 0x4b, 0x03, 0x04]);
    },
  );

  it(
    'a thread that runs out of memory dies alone: the report is "too large" and the process goes on',
    { timeout: TEST_TIMEOUT_MS },
    async () => {
      await assert.rejects(run({ entry: thread('oomThread'), maxMemoryMb: 64 }), (error) => {
        assert.ok(error instanceof ReportTooLargeError);
        assert.equal(error.limit, 'memory');
        return true;
      });
      assert.ok((await run()).buffer.length > 0, 'the next report is generated normally');
    },
  );

  it(
    'a thread in a synchronous block is terminated at the deadline: "took too long"',
    { timeout: TEST_TIMEOUT_MS },
    async () => {
      await assert.rejects(run({ entry: thread('spinThread'), deadlineMs: Date.now() + 300 }), ReportTooSlowError);
    },
  );

  it('a deadline that has already passed terminates the thread at once', { timeout: TEST_TIMEOUT_MS }, async () => {
    await assert.rejects(run({ deadlineMs: Date.now() - 1 }), ReportTooSlowError);
  });

  it('the shutdown signal terminates the thread and gives the report up', { timeout: TEST_TIMEOUT_MS }, async () => {
    const controller = new AbortController();
    const pending = run({ entry: thread('spinThread'), signal: controller.signal });
    controller.abort();
    await assert.rejects(pending, ReportAbandonedError);
    await assert.rejects(run({ signal: controller.signal }), ReportAbandonedError, 'already aborted: no thread');
  });

  it(
    'a PDF bigger than maxBytes is "too large" (the thread says so while it writes)',
    { timeout: TEST_TIMEOUT_MS },
    async () => {
      await assert.rejects(run({ maxBytes: 10 }), (error) => error instanceof ReportTooLargeError);
    },
  );

  it('the text of an error of the thread never reaches the API process', { timeout: TEST_TIMEOUT_MS }, async () => {
    await assert.rejects(run({ entry: thread('throwThread') }), (error) => {
      assert.ok(error instanceof ReportThreadError);
      const everything = JSON.stringify({ message: error.message, name: error.name, errorClass: error.errorClass });
      assert.ok(!everything.includes('ana.perez'));
      assert.ok(!everything.includes('7731'));
      assert.equal(error.errorClass, 'Error');
      return true;
    });
  });

  it(
    'a thread that cannot be created is a ReportThreadError with the code of the cause, not a raw exception',
    { timeout: TEST_TIMEOUT_MS },
    async () => {
      await assert.rejects(run({ entry: thread('argvThread'), execArgv: ['--no-such-flag-of-node'] }), (error) => {
        assert.ok(error instanceof ReportThreadError);
        assert.equal(error.code, 'ERR_WORKER_INVALID_EXEC_ARGV');
        return true;
      });
    },
  );

  describe('the flags of the thread', () => {
    it('from dist/ it inherits none, whatever the process has', () => {
      const parent = ['--inspect=127.0.0.1:9229', '--max-old-space-size=4096', '--import', 'tsx'];
      assert.deepEqual(threadExecArgv(parent, false), []);
    });

    it('from src/ it inherits only the loader of .ts files, not the preloads of the process (the pg watcher of npm test)', () => {
      const ofNpmTest = [
        '--import',
        'tsx',
        '--import',
        './tests/setup/failOnPgOverlap.ts',
        '--max-old-space-size=4096',
        '--experimental-test-coverage',
      ];
      assert.deepEqual(threadExecArgv(ofNpmTest, true), ['--import', 'tsx']);
      assert.deepEqual(threadExecArgv(['--import=tsx', '--require', './x.cjs'], true), ['--import=tsx']);
      assert.deepEqual(threadExecArgv([], true), []);
    });

    it('the thread does not get the variable with which node --test marks its children; the rest is kept', () => {
      const env = threadEnv({ NODE_TEST_CONTEXT: 'child-v8', PATH: '/bin', TZ: 'UTC' });
      assert.deepEqual(env, { PATH: '/bin', TZ: 'UTC' });
    });

    it('a thread started with explicit flags runs with exactly those', { timeout: TEST_TIMEOUT_MS }, async () => {
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
