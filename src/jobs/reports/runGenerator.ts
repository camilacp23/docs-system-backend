/**
 * The main-thread side of the generator thread (`worker_threads`, inside the API process; D-44 stays).
 *
 * One thread per report, created for the report and terminated when it is over (no pool). The thread gets only the
 * content of the report and the options of the format (`workerData`) and answers with the file as a transferred
 * `ArrayBuffer`. What the main thread controls, and why the API cannot be hurt by a report:
 * - memory: `resourceLimits.maxOldGenerationSizeMb`; a thread that runs out of it dies alone (`ERR_WORKER_OUT_OF_MEMORY`)
 *   and the report is FAILED "too large";
 * - time: a timer calls `terminate()` at the deadline, which works even while the thread is in a synchronous block;
 * - shutdown: the abort signal calls `terminate()` too, and the report is given up (it stays PENDING).
 * The text of an error of the thread never reaches the main thread: only a kind and the class of the error.
 *
 * @module jobs/reports/runGenerator
 */
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import type { ReportContent } from '../../modules/reports/content.js';
import {
  ReportAbandonedError,
  ReportThreadError,
  ReportTooLargeError,
  ReportTooSlowError,
} from '../../modules/reports/failures.js';
import type { ThreadInput, ThreadOutput } from './generatorThread.js';
import type { GeneratedFile } from './types.js';

/** `.ts` when this module runs from `src/` (tests, `tsx`) and `.js` from `dist/`: the thread file sits next to it. */
const RUNS_FROM_SOURCE = fileURLToPath(import.meta.url).endsWith('.ts');

/** The thread file of this build. */
export const GENERATOR_THREAD = new URL(`./generatorThread${RUNS_FROM_SOURCE ? '.ts' : '.js'}`, import.meta.url);

/** The only preload a thread started from `src/` needs: the one that lets it load `.ts` files. */
const TYPESCRIPT_LOADER = /^tsx(?:\/.*)?$/;

/**
 * Flags the thread starts with. From `dist/` it inherits NOTHING: a flag such as `--inspect` or `--max-old-space-size`
 * of the API process must not reach the thread (an inspector port would be opened twice). From `src/` (development and
 * tests) it inherits ONLY the loader that lets it read `.ts` files (`--import tsx`): the other preloads of the process
 * belong to the process, not to the thread. In `npm test` one of them is the pg watcher, which imports `node:test` and
 * starts a second test runner inside the thread, reporting on the stdout of the real one.
 *
 * @param parent - `process.execArgv` of the main thread.
 * @param fromSource - True when the code runs from `src/` through `tsx`.
 */
export function threadExecArgv(parent: readonly string[], fromSource: boolean): string[] {
  if (!fromSource) return [];
  const kept: string[] = [];
  for (let i = 0; i < parent.length; i += 1) {
    const flag = parent[i]!;
    if (flag === '--import' || flag === '--require') {
      const specifier = parent[i + 1];
      i += 1;
      if (specifier !== undefined && TYPESCRIPT_LOADER.test(specifier)) kept.push(flag, specifier);
    } else if (flag.startsWith('--import=') && TYPESCRIPT_LOADER.test(flag.slice('--import='.length))) {
      kept.push(flag);
    }
  }
  return kept;
}

/**
 * The environment of the thread: the one of the process without the variable with which `node --test` tells a child
 * that it belongs to a test run (a thread that inherited it would behave as a second child of the runner).
 *
 * @param parent - `process.env` of the main thread.
 */
export function threadEnv(parent: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const { NODE_TEST_CONTEXT: _runner, ...rest } = parent;
  return rest;
}

/** The class of a thrown value. */
const errorNameOf = (error: unknown): string => (error instanceof Error ? error.name : 'NonError');

/** The `code` of a thrown value when it is a fixed identifier (`ERR_WORKER_…`, `ENOENT`); anything else is not logged. */
const errorCodeOf = (error: unknown): string | undefined => {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^[A-Z0-9_]{1,64}$/.test(code) ? code : undefined;
};

/** What a run needs. */
export type ThreadRun = {
  format: 'PDF' | 'XLSX';
  content: ReportContent;
  maxBytes: number;
  /** `REPORT_MAX_MEMORY_MB`. */
  maxMemoryMb: number;
  /** The instant (epoch ms) at which the thread is terminated. */
  deadlineMs: number;
  /** Aborted when the server stops. */
  signal: AbortSignal;
  /** Another thread file (tests only). */
  entry?: URL;
  /** `execArgv` of the thread (tests only; default {@link threadExecArgv}). */
  execArgv?: string[];
};

/**
 * Generates the file of a report in a thread of its own.
 *
 * @param run - Content, format and limits.
 * @returns The file.
 * @throws {ReportTooSlowError} The deadline passed (the thread was terminated).
 * @throws {ReportTooLargeError} The file is bigger than `maxBytes`, or the thread used more than `maxMemoryMb`.
 * @throws {ReportAbandonedError} The abort signal fired.
 * @throws {ReportThreadError} Any other failure of the thread.
 */
export function runInThread(run: ThreadRun): Promise<GeneratedFile> {
  return new Promise<GeneratedFile>((resolve, reject) => {
    if (run.signal.aborted) {
      reject(new ReportAbandonedError());
      return;
    }
    const input: ThreadInput = { format: run.format, content: run.content, maxBytes: run.maxBytes };
    let thread: Worker;
    try {
      thread = new Worker(run.entry ?? GENERATOR_THREAD, {
        workerData: input,
        resourceLimits: { maxOldGenerationSizeMb: run.maxMemoryMb },
        execArgv: run.execArgv ?? threadExecArgv(process.execArgv, RUNS_FROM_SOURCE),
        env: threadEnv(process.env),
        // Nothing of the thread is printed by the API process.
        stdout: false,
        stderr: false,
      });
    } catch (error) {
      // The thread could not even be created (invalid flags, content that cannot be cloned): class and code, no text.
      reject(new ReportThreadError(errorNameOf(error), errorCodeOf(error)));
      return;
    }

    let settled = false;
    let timedOut = false;
    let aborted = false;
    const finish = (settle: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      run.signal.removeEventListener('abort', onAbort);
      settle();
      void thread.terminate(); // the thread ends here in every case
    };
    const fail = (error: Error): void => finish(() => reject(error));
    const why = (fallback: () => Error): Error => {
      if (aborted) return new ReportAbandonedError();
      if (timedOut) return new ReportTooSlowError();
      return fallback();
    };

    const timer = setTimeout(
      () => {
        timedOut = true;
        void thread.terminate();
      },
      Math.max(0, run.deadlineMs - Date.now()),
    );
    const onAbort = (): void => {
      aborted = true;
      void thread.terminate();
    };
    run.signal.addEventListener('abort', onAbort, { once: true });

    thread.once('message', (message: ThreadOutput) => {
      if (message.type === 'done') {
        const file: GeneratedFile = {
          buffer: Buffer.from(message.buffer),
          mimeType: message.mimeType,
          replacedCharacters: message.replacedCharacters,
          heapPeakMb: message.heapPeakMb,
        };
        finish(() => resolve(file));
      } else if (message.kind === 'TOO_LARGE') {
        fail(new ReportTooLargeError('bytes'));
      } else {
        fail(new ReportThreadError(message.errorClass, message.code));
      }
    });
    thread.once('error', (error: Error & { code?: string }) => {
      fail(
        why(() =>
          error.code === 'ERR_WORKER_OUT_OF_MEMORY'
            ? new ReportTooLargeError('memory')
            : new ReportThreadError(error.name, errorCodeOf(error)),
        ),
      );
    });
    thread.once('exit', (code) => {
      // A thread that ends without a message: terminated by us, or it died.
      fail(why(() => new ReportThreadError(`exit code ${code}`)));
    });
  });
}
