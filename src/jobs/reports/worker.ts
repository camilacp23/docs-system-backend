/**
 * The report worker (NFR-12; D-44, D-118, D-119; SDD 8.4, Figure 27). It runs inside the API process.
 *
 * One pass (`runOnce`) is ONE transaction, `REPEATABLE READ`, that
 * 1. takes the oldest PENDING report with `FOR UPDATE SKIP LOCKED` and KEEPS that lock until the end, so another worker
 *    (another instance) takes another report, and a process that dies releases it: the report is PENDING again;
 * 2. acts as `report.generated_by` (`actAs`, so the audit records name the person who asked, R-1);
 * 3. reads the content on that transaction (the report is a snapshot, D-116), one statement after the other;
 * 4. has the file generated in a thread of its own (`runGenerator`; the transaction stays open and waits for it), and
 * 5. in the SAME transaction stores the file and sets READY, `completedAt`, `fileName`, `fileSize` and, when the request
 *    said so, `isPublished` and `publishedAt` (the CHECK `report_published_ready_chk` needs them together).
 *
 * A failure that leaves the transaction usable (time, size, memory, a deleted screen, any error that is not the
 * database's) sets the report FAILED in that SAME transaction and commits it. Only when the transaction itself is
 * unusable (a database error, a statement cut by `statement_timeout`, the transaction cut by its own timeout) is it
 * rolled back and FAILED written in a NEW transaction that locks the row again and changes a report only if it is still
 * PENDING. The text is one of the four of D-119; the technical detail goes to the log with the id of the report and no
 * content. A report given up because the server is stopping is not failed: it stays PENDING and the next start takes it.
 *
 * Times: `REPORT_MAX_SECONDS` is the budget of the report from the claim. `statement_timeout` is set to that value and
 * applies to each QUERY of the transaction, never to the wait for the thread (a transaction that waits is idle, not
 * running a statement). The thread is terminated at the deadline. The interactive transaction of Prisma gets that budget
 * plus a margin (`TRANSACTION_MARGIN_MS`) for what happens after the deadline: writing the file (up to `REPORT_MAX_BYTES`),
 * the READY or FAILED update and the commit.
 *
 * One worker generates one report at a time. No fixed waits: the loop sleeps `pollMs` between looks at an empty queue and
 * `wake()` (called when a report is saved) cuts the sleep short; tests drive the worker with `runOnce`.
 *
 * @module jobs/reports/worker
 */
import type { ReportsConfig } from '../../config/env.js';
import { actAs, type Database } from '../../db/prisma.js';
import { Prisma } from '../../generated/prisma/client.js';
import { extractDbFacts } from '../../http/dbErrors.js';
import type { Logger } from '../../http/logger.js';
import { buildReportContent, type ReportJob } from '../../modules/reports/content.js';
import type { ContentDeps } from '../../modules/reports/content.js';
import {
  REPORT_ERROR_MESSAGES,
  ReportAbandonedError,
  ReportScreenGoneError,
  ReportThreadError,
  ReportTooLargeError,
  ReportTooSlowError,
  type ReportFailure,
} from '../../modules/reports/failures.js';
import { reportFileName } from '../../modules/reports/fileName.js';
import type { ReportParameters } from '../../modules/reports/repository.js';
import { runInThread } from './runGenerator.js';
import type { Generator } from './types.js';

/** What one pass did. */
export type RunResult = 'idle' | 'ready' | 'failed' | 'abandoned' | 'conflict';

/** Hooks for tests; production passes none. */
export type WorkerHooks = {
  /** After the report was claimed, before anything is read (the lock is held). */
  afterClaim?: (reportId: number) => Promise<void>;
  /** After each part of the content was read (the snapshot is open). */
  afterSection?: (name: string) => Promise<void>;
};

export type ReportWorkerOptions = {
  db: Pick<Database, 'base'>;
  logger: Logger;
  config: ReportsConfig;
  dashboard: ContentDeps['dashboard'];
  dependencies: ContentDeps['dependencies'];
  /** Replacements of the generators (tests). */
  generators?: { PDF?: Generator; XLSX?: Generator };
  hooks?: WorkerHooks;
  /** Most characters of text a report may hold (default {@link MAX_CONTENT_CHARS}); tests pass a small one. */
  maxContentChars?: number;
};

/** The worker. */
export type ReportWorker = {
  /** Starts the loop (returns at once). Does nothing when it is already started. */
  start(): void;
  /** Tells the loop that a report was saved, so it looks at the table now instead of at its next turn. */
  wake(): void;
  /** One pass: takes at most one PENDING report and finishes it (see the module). */
  runOnce(): Promise<RunResult>;
  /**
   * Stops: no new report is taken, and the one being generated gets `shutdownGraceMs` to finish; after that it is given up
   * (the report stays PENDING) and the transaction is rolled back.
   */
  stop(): Promise<void>;
};

type Claim = {
  id: number;
  applicationId: number;
  title: string;
  format: 'PDF' | 'XLSX';
  parameters: ReportParameters;
  generatedById: number;
};

/**
 * The most characters of text of a report (D-129): about 2.3 times the full-scale report that was measured (17.5 million
 * characters). The content is read by the main thread, so this is what keeps a huge documentation from exhausting its
 * memory (and from doing so again at every start: the report would be PENDING again).
 */
export const MAX_CONTENT_CHARS = 40_000_000;

/**
 * Extra time of the Prisma transaction beyond `REPORT_MAX_SECONDS`: after the deadline there is still the insert of the
 * file (at most `REPORT_MAX_BYTES`), the update and the commit, or the FAILED update. 30 s is far above that (the insert of
 * 8 MB takes well under a second), so the budget of the report is the limit that decides and never Prisma's.
 */
const TRANSACTION_MARGIN_MS = 30_000;
/** How long the FAILED write waits for the row of a report that is still being released. */
const FAILED_LOCK_TIMEOUT_MS = 5_000;
/** After a worker is told to stop, the extra time (beyond the grace) to let an abandoned report roll back. */
const ABANDON_WAIT_MS = 1_000;

const sleepOrWake = (ms: number, register: (wake: () => void) => void): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
    register(() => {
      clearTimeout(timer);
      resolve();
    });
  });

/**
 * Creates a report worker.
 *
 * @param options - Database, logger, limits, the two services the content is read through, and test replacements.
 */
export function createReportWorker(options: ReportWorkerOptions): ReportWorker {
  const { db, logger, config, hooks } = options;
  /** The real generators run in a thread of their own; tests may replace them with in-process ones. */
  const threaded =
    (format: 'PDF' | 'XLSX'): Generator =>
    (content, context) =>
      runInThread({
        format,
        content,
        maxBytes: context.maxBytes,
        maxMemoryMb: config.maxMemoryMb,
        deadlineMs: context.deadlineMs,
        signal: context.signal,
      });
  const generators: Record<'PDF' | 'XLSX', Generator> = {
    PDF: options.generators?.PDF ?? threaded('PDF'),
    XLSX: options.generators?.XLSX ?? threaded('XLSX'),
  };
  const maxMs = config.maxSeconds * 1000;

  let started = false;
  let stopping = false;
  let abandon = new AbortController();
  let current: Promise<RunResult> | undefined;
  let wakeSleep: (() => void) | undefined;
  let woken = false;
  let loop: Promise<void> | undefined;

  /** Why a thrown value failed the report, and the log fields that explain it without content. */
  function classify(error: unknown): { failure: ReportFailure; fields: Record<string, unknown> } {
    if (error instanceof ReportTooSlowError) return { failure: 'TOO_SLOW', fields: { errorClass: error.name } };
    if (error instanceof ReportTooLargeError) {
      return { failure: 'TOO_LARGE', fields: { errorClass: error.name, limit: error.limit } };
    }
    if (error instanceof ReportScreenGoneError) return { failure: 'SCREEN_GONE', fields: { errorClass: error.name } };
    if (error instanceof ReportThreadError) {
      // What the thread (or its creation) failed with: the class and the code of its error, never its text.
      return {
        failure: 'OTHER',
        fields: { errorClass: error.name, threadErrorClass: error.errorClass, threadCode: error.code ?? null },
      };
    }
    const facts = extractDbFacts(error);
    if (facts !== null) {
      const fields = { errorClass: 'DatabaseError', prismaCode: facts.prismaCode, sqlstate: facts.sqlstate };
      // A cut transaction (Prisma P2028) or a statement cut by `statement_timeout` (57014) is a time limit.
      const slow = facts.prismaCode === 'P2028' || facts.sqlstate === '57014';
      return { failure: slow ? 'TOO_SLOW' : 'OTHER', fields };
    }
    // The message of an error of ours or of a library can hold a value of the documentation: only its class is logged
    // here; the stack (file paths and line numbers) is what explains a defect.
    const plain = error instanceof Error ? error : new Error('a value that is not an error was thrown');
    // The first lines of a stack repeat the message: only the frames (files and lines) are kept.
    const frames = (plain.stack ?? '')
      .split('\n')
      .filter((line) => line.trimStart().startsWith('at '))
      .join('\n');
    return { failure: 'OTHER', fields: { errorClass: plain.name, stack: frames } };
  }

  /** Sets a report FAILED in a NEW transaction, locking the row again and writing only if it is still PENDING. */
  async function markFailed(reportId: number, failure: ReportFailure): Promise<boolean> {
    try {
      return await db.base.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('lock_timeout', ${String(FAILED_LOCK_TIMEOUT_MS)}, true)`;
        const rows = await tx.$queryRaw<{ generatedById: number }[]>`
          SELECT generated_by AS "generatedById" FROM report WHERE id = ${reportId} AND status = 'PENDING' FOR UPDATE`;
        const row = rows[0];
        if (row === undefined) return false; // it is not PENDING any more: nothing to change
        await actAs(tx, row.generatedById);
        await tx.report.update({
          where: { id: reportId },
          data: { status: 'FAILED', errorMessage: REPORT_ERROR_MESSAGES[failure] },
        });
        return true;
      });
    } catch (error) {
      logger.error({ reportId, ...classify(error).fields }, 'could not set the report as FAILED; it stays PENDING');
      return false;
    }
  }

  async function pass(): Promise<RunResult> {
    let claimedId: number | undefined;
    let completed:
      { replacedCharacters: number; bytes: number; heapPeakMb: number | undefined; ms: number } | undefined;
    let decided: { failure: ReportFailure; fields: Record<string, unknown> } | undefined;
    try {
      const outcome = await db.base.$transaction(
        async (tx) => {
          // The claim is the FIRST statement: the snapshot of the transaction starts here.
          const claims = await tx.$queryRaw<Claim[]>`
            SELECT id, application_id AS "applicationId", title, format::text AS format, parameters,
                   generated_by AS "generatedById"
              FROM report
             WHERE status = 'PENDING'
             ORDER BY created_at, id
               FOR UPDATE SKIP LOCKED
             LIMIT 1`;
          const claim = claims[0];
          if (claim === undefined) return 'idle' as const;
          claimedId = claim.id;
          logger.info({ reportId: claim.id, format: claim.format }, 'report generation started');

          try {
            const deadline = Date.now() + maxMs;
            await tx.$executeRaw`SELECT set_config('statement_timeout', ${String(maxMs)}, true)`;
            await actAs(tx, claim.generatedById);
            const checkpoint = (): void => {
              if (abandon.signal.aborted) throw new ReportAbandonedError();
              if (Date.now() > deadline) throw new ReportTooSlowError();
            };
            await hooks?.afterClaim?.(claim.id);

            const author = await tx.user.findUniqueOrThrow({
              where: { id: claim.generatedById },
              select: { name: true },
            });
            const job: ReportJob = {
              id: claim.id,
              applicationId: claim.applicationId,
              title: claim.title,
              generatedById: claim.generatedById,
              generatedByName: author.name,
              parameters: claim.parameters,
            };
            const content = await buildReportContent(job, {
              client: tx,
              dashboard: options.dashboard,
              dependencies: options.dependencies,
              maxRows: config.maxRows,
              maxChars: options.maxContentChars ?? MAX_CONTENT_CHARS,
              now: new Date(),
              checkpoint,
              ...(hooks?.afterSection === undefined ? {} : { afterSection: hooks.afterSection }),
            });
            checkpoint();
            const file = await generators[claim.format](content, {
              checkpoint,
              maxBytes: config.maxBytes,
              deadlineMs: deadline,
              signal: abandon.signal,
            });
            if (file.buffer.length > config.maxBytes) throw new ReportTooLargeError('bytes');
            checkpoint();

            const completedAt = new Date();
            await tx.reportFile.create({
              data: { reportId: claim.id, mimeType: file.mimeType, content: file.buffer as Uint8Array<ArrayBuffer> },
              select: { reportId: true },
            });
            const publish = claim.parameters.publish;
            await tx.report.update({
              where: { id: claim.id },
              data: {
                status: 'READY',
                completedAt,
                fileName: reportFileName(claim.title, claim.format, completedAt),
                fileSize: file.buffer.length,
                ...(publish ? { isPublished: true, publishedAt: completedAt } : {}),
              },
              select: { id: true },
            });
            completed = {
              replacedCharacters: file.replacedCharacters,
              bytes: file.buffer.length,
              heapPeakMb: file.heapPeakMb,
              ms: Date.now() - (deadline - maxMs),
            };
            return 'ready' as const;
          } catch (error) {
            // A failure that leaves the transaction usable is written HERE, in the same transaction (the lock is still
            // held). A database error, or the shutdown, leaves it to the caller: rolled back, and FAILED in a new one.
            if (error instanceof ReportAbandonedError || extractDbFacts(error) !== null) throw error;
            decided = classify(error);
            logger.error(
              { reportId: claim.id, failure: decided.failure, ...decided.fields },
              'report generation failed',
            );
            await tx.report.update({
              where: { id: claim.id },
              data: { status: 'FAILED', errorMessage: REPORT_ERROR_MESSAGES[decided.failure] },
              select: { id: true },
            });
            return 'failed' as const;
          }
        },
        {
          isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
          maxWait: 10_000,
          timeout: maxMs + TRANSACTION_MARGIN_MS,
        },
      );
      if (outcome === 'ready' && completed !== undefined) {
        if (completed.replacedCharacters > 0) {
          // One warning per report, with the count and never the text.
          logger.warn(
            { reportId: claimedId, replacedCharacters: completed.replacedCharacters },
            'characters without a glyph in the PDF font were replaced by "?"',
          );
        }
        logger.info(
          { reportId: claimedId, bytes: completed.bytes, ms: completed.ms, heapPeakMb: completed.heapPeakMb },
          'report ready',
        );
      }
      return outcome;
    } catch (error) {
      if (error instanceof ReportAbandonedError) {
        logger.warn({ reportId: claimedId }, 'report generation given up (shutdown); the report stays PENDING');
        return 'abandoned';
      }
      if (claimedId === undefined) {
        // Nothing was claimed: a serialization failure of the claim itself is a lost race, anything else is a real error.
        if (extractDbFacts(error)?.sqlstate === '40001') return 'conflict';
        throw error;
      }
      // The transaction is unusable: roll back (done) and write FAILED in a new one.
      const { failure, fields } = decided ?? classify(error);
      logger.error(
        { reportId: claimedId, failure, ...fields },
        'report generation failed; setting FAILED in a new transaction',
      );
      return (await markFailed(claimedId, failure)) ? 'failed' : 'abandoned';
    }
  }

  async function run(): Promise<void> {
    while (!stopping) {
      let result: RunResult = 'idle';
      try {
        result = await worker.runOnce();
      } catch (error) {
        logger.error(classify(error).fields, 'the report worker could not look at the queue');
      }
      if (stopping) break;
      if (result === 'idle' || result === 'abandoned') {
        if (!woken) await sleepOrWake(config.pollMs, (wake) => (wakeSleep = wake));
        woken = false;
        wakeSleep = undefined;
      }
    }
  }

  const worker: ReportWorker = {
    start() {
      if (started) return;
      started = true;
      stopping = false;
      loop = run();
    },

    wake() {
      woken = true;
      wakeSleep?.();
    },

    runOnce() {
      if (stopping || current !== undefined) return Promise.resolve('idle');
      current = pass().finally(() => {
        current = undefined;
      });
      return current;
    },

    async stop() {
      stopping = true;
      wakeSleep?.();
      const inFlight = current;
      if (inFlight !== undefined) {
        let timer: NodeJS.Timeout | undefined;
        const timedOut = new Promise<'timeout'>((resolve) => {
          timer = setTimeout(() => resolve('timeout'), config.shutdownGraceMs);
          timer.unref();
        });
        const first = await Promise.race([inFlight.then(() => 'done' as const), timedOut]);
        clearTimeout(timer);
        if (first === 'timeout') {
          abandon.abort(); // the thread is terminated, the report is given up and the transaction rolls back
          await Promise.race([
            inFlight.catch(() => undefined),
            new Promise((r) => setTimeout(r, ABANDON_WAIT_MS).unref()),
          ]);
        }
      }
      await loop?.catch(() => undefined);
      started = false;
      abandon = new AbortController();
    },
  };
  return worker;
}
