/**
 * Rules of the saved reports (FR-22, NFR-12; D-115, D-118, D-120, D-121). The service never sees req/res.
 *
 * Order of the answers (the role gate and the contract validator run before this code):
 * - `generate`: 400 (the rules of `scope`) -> 404 (application, then a screen of `scope.screenIds`) -> the report is saved
 *   PENDING. An archived application can generate (D-47).
 * - `get` and `download`: 404 (the report does not exist, or it is not published and the caller is a Reader: the same
 *   answer) -> for the download, 409 `REPORT_NOT_READY`.
 * - `setPublication`: 404 -> 412 -> 409 `REPORT_NOT_READY`. The report is first read WITHOUT a lock, because the worker
 *   keeps the row of a PENDING report locked while it generates: a report that is not READY answers 409 at once and
 *   never waits for it. Only a READY report is locked (and read again) before it is written.
 *
 * @module modules/reports/service
 */
import type { Database } from '../../db/prisma.js';
import { INT32_MAX, assertIdInRange } from '../../http/ids.js';
import { Prisma } from '../../generated/prisma/client.js';
import { E } from '../../security/errors.js';
import { etagOf } from '../../http/etag.js';
import * as repo from './repository.js';
import { scopeProblems, type ReportScopeBody } from './scope.js';

const ELEMENT = 'report';

/** The caller, as the authentication middleware read it from the database. */
export type ReportCaller = { id: number; role: string };

/** Body of `POST /reports/pdf` and `/reports/excel`, as the validator lets it through. */
export type ReportRequestBody = { applicationId: number; title: string; scope: ReportScopeBody; publish: boolean };

/** Checks `If-Match` against the current ETag (throws 412); built by the controller. */
export type PreconditionCheck = (currentETag: string) => void;

/** The parameters of `GET /reports`, already parsed by the controller. */
export type ListReportsInput = {
  applicationId: number;
  published?: boolean | undefined;
  skip: number;
  take: number;
};

/** The reports service. */
export type ReportService = {
  /** `POST /reports/pdf` and `POST /reports/excel`: saves the report as PENDING. */
  generate(caller: ReportCaller, format: repo.ReportFormat, body: ReportRequestBody): Promise<repo.ReportView>;
  /** `GET /reports`. */
  list(caller: ReportCaller, input: ListReportsInput): Promise<{ data: repo.ReportView[]; total: number }>;
  /** `GET /reports/{id}`. */
  get(caller: ReportCaller, id: number): Promise<repo.ReportDetailView>;
  /** The report of `GET /reports/{id}/file` once it is known to be READY (404 and 409 are decided here). */
  forDownload(caller: ReportCaller, id: number): Promise<repo.ReportView>;
  /** The binary of a READY report; only called when the answer is a 200. */
  readFile(id: number): Promise<{ mimeType: string; content: Buffer }>;
  /** `PUT /reports/{id}/publication`. */
  setPublication(
    caller: ReportCaller,
    id: number,
    isPublished: boolean,
    assertCurrent: PreconditionCheck,
  ): Promise<repo.ReportView>;
};

/** The report without its parameters (`Report`, as the list and the publication return it). */
function withoutParameters({ parameters: _parameters, ...view }: repo.ReportDetailView): repo.ReportView {
  return view;
}

const isReader = (caller: ReportCaller): boolean => caller.role === 'READER';

/**
 * Creates the reports service.
 *
 * @param db - Database connected as docs_app.
 * @param hooks - `onQueued` runs after a report was saved (the worker uses it to start without waiting for its next
 *   look at the table); nothing depends on it for correctness.
 */
export function createReportService(
  db: Pick<Database, 'base' | 'auditedTransaction'>,
  hooks: { onQueued?: () => void } = {},
): ReportService {
  /** The report, or 404 (also for a Reader when it is not published: the same body as one that does not exist). */
  const visibleReport = async (
    client: repo.ReportsClient,
    caller: ReportCaller,
    id: number,
  ): Promise<repo.ReportDetailView> => {
    const report = await repo.findReport(client, id);
    if (report === null || (isReader(caller) && !report.isPublished)) throw E.notFound(ELEMENT, id);
    return report;
  };

  return {
    async generate(caller, format, body) {
      const problems = scopeProblems(body.scope);
      if (problems.length > 0) throw E.validation(problems);
      assertIdInRange(body.applicationId, 'application');

      const report = await db.auditedTransaction(async (tx) => {
        if (!(await repo.applicationExists(tx, body.applicationId)))
          throw E.notFound('application', body.applicationId);
        const screenIds = body.scope.screenIds;
        if (screenIds !== undefined) {
          const existing = await repo.screensOfApplication(
            tx,
            body.applicationId,
            screenIds.filter((id) => id <= INT32_MAX),
          );
          const missing = screenIds.findIndex((id) => !existing.has(id));
          if (missing >= 0) throw E.notFound('screen', screenIds[missing], `scope.screenIds[${missing}]`);
        }
        return repo.insertReport(tx, {
          applicationId: body.applicationId,
          title: body.title,
          format,
          parameters: { format, scope: body.scope, publish: body.publish },
          generatedById: caller.id,
        });
      });
      hooks.onQueued?.();
      return report;
    },

    async list(caller, input) {
      assertIdInRange(input.applicationId, 'application');
      // A Reader sees only the published reports; asking for the others is an empty page, not an error (D-32).
      const published = isReader(caller) ? (input.published ?? true) : input.published;
      return db.base.$transaction(
        async (tx) => {
          if (!(await repo.applicationExists(tx, input.applicationId)))
            throw E.notFound('application', input.applicationId);
          if (isReader(caller) && published === false) return { data: [], total: 0 };
          return repo.listReports(tx, { ...input, published });
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
      );
    },

    get: (caller, id) => visibleReport(db.base, caller, id),

    async forDownload(caller, id) {
      const report = await visibleReport(db.base, caller, id);
      if (report.status !== 'READY') throw E.reportNotReady(report.status);
      return withoutParameters(report);
    },

    async readFile(id) {
      const file = await repo.findFile(db.base, id);
      if (file === null) throw new Error(`report ${id} is READY but has no file`); // a defect, not a user error
      return file;
    },

    async setPublication(caller, id, isPublished, assertCurrent) {
      // 404 and 412 on a read without a lock, then 409 at once for a report that is not READY (it may be generating).
      const first = await visibleReport(db.base, caller, id);
      assertCurrent(etagOf(first));
      if (first.status !== 'READY') throw E.reportNotReady(first.status);

      return db.auditedTransaction(async (tx) => {
        await repo.lockReportForUpdate(tx, id);
        const current = await visibleReport(tx, caller, id);
        assertCurrent(etagOf(current));
        if (current.status !== 'READY') throw E.reportNotReady(current.status);
        if (current.isPublished === isPublished) return withoutParameters(current); // nothing to write (D-71)
        return repo.updatePublication(tx, id, isPublished, isPublished ? new Date() : null);
      });
    },
  };
}
