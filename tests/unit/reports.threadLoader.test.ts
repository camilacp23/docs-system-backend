/**
 * The TypeScript loader inside a worker thread. The real generator thread imports `./pdf.js` and `./excel.js`, which only
 * resolve to `pdf.ts` and `excel.ts` when the loader (`tsx`) is active in the thread. This test starts a thread with the
 * same options as `runInThread` (flags and environment) and has it import a `.ts` file by a relative `.js` path: if it
 * fails, the loader is not working in worker threads with this version of Node, whatever the report code does.
 */
import '../helpers/env.js';
import assert from 'node:assert/strict';
import { basename } from 'node:path';
import { describe, it } from 'node:test';
import { Worker } from 'node:worker_threads';
import { threadEnv, threadExecArgv } from '../../src/jobs/reports/runGenerator.js';

describe('TypeScript loader in worker threads', () => {
  it(
    `a thread started like the generator thread resolves a relative .js import to its .ts file (Node ${process.version})`,
    { timeout: 30_000 },
    async () => {
      const outcome = await new Promise<{ value?: string; code?: string; module?: string }>((resolve) => {
        const thread = new Worker(new URL('../helpers/threads/relativeImportThread.ts', import.meta.url), {
          resourceLimits: { maxOldGenerationSizeMb: 256 },
          execArgv: threadExecArgv(true),
          env: threadEnv(process.env, true),
          stdout: false,
          stderr: false,
        });
        thread.once('message', (message: { value: string }) => resolve({ value: message.value }));
        thread.once('error', (error: Error & { code?: string }) =>
          resolve({
            code: error.code ?? error.name,
            module: /Cannot find (?:module|package) '([^']+)'/.exec(error.message)?.[1],
          }),
        );
        thread.once('exit', () => resolve({ code: 'EXIT_WITHOUT_ANSWER' }));
      });
      assert.equal(
        outcome.value,
        'loaded',
        `the TypeScript loader (tsx) is NOT active in worker threads with Node ${process.version}: the thread failed with ` +
          `${outcome.code ?? 'no code'}${outcome.module === undefined ? '' : ` on ${basename(outcome.module)}`}. ` +
          `The generator thread cannot load its .ts files; use the Node version of .nvmrc.`,
      );
    },
  );
});
