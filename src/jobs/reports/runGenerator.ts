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

/**
 * Flags the thread starts with. From `src/` (development and tests) it inherits those of the process, which is how `tsx`
 * lets the thread load `.ts` files. From `dist/` it inherits NOTHING: a flag such as `--inspect` or `--max-old-space-size`
 * of the API process must not reach the thread (an inspector port would be opened twice).
 *
 * @param parent - `process.execArgv` of the main thread.
 * @param fromSource - True when the code runs from `src/` through `tsx`.
 */
export function threadExecArgv(parent: readonly string[], fromSource: boolean): string[] {
  return fromSource ? [...parent] : [];
}

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
    const thread = new Worker(run.entry ?? GENERATOR_THREAD, {
      workerData: input,
      resourceLimits: { maxOldGenerationSizeMb: run.maxMemoryMb },
      execArgv: run.execArgv ?? threadExecArgv(process.execArgv, RUNS_FROM_SOURCE),
      // Nothing of the thread is printed by the API process.
      stdout: false,
      stderr: false,
    });

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
        fail(new ReportThreadError(message.errorClass));
      }
    });
    thread.once('error', (error: Error & { code?: string }) => {
      fail(
        why(() =>
          error.code === 'ERR_WORKER_OUT_OF_MEMORY'
            ? new ReportTooLargeError('memory')
            : new ReportThreadError(error.name),
        ),
      );
    });
    thread.once('exit', (code) => {
      // A thread that ends without a message: terminated by us, or it died.
      fail(why(() => new ReportThreadError(`exit code ${code}`)));
    });
  });
}
