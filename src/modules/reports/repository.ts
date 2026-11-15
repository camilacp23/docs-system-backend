/**
 * Prisma queries of the reports module (Module 9: FR-22; SDD Table 6, Tables 25 and 26). No rules live here (D-42):
 * the service decides, this only reads and writes.
 *
 * `report_file` (the binary, Table 26) is read ONLY by `findFile`. Every other query selects the columns of `report`
 * explicitly, so listing or opening a report never loads a file.
 *
 * @module modules/reports/repository
 */
import type { Prisma, PrismaClient } from '../../generated/prisma/client.js';
import type { ReportScopeBody } from './scope.js';

/** Clients accepted by the queries: the plain client or the transaction client of `auditedTransaction`. */
export type ReportsClient = Pick<PrismaClient, 'report' | 'reportFile' | 'application' | 'screen' | '$queryRaw'>;

/** The two formats and the three states of a report (enums of the database). */
export type ReportFormat = 'PDF' | 'XLSX';
export type ReportStatus = 'PENDING' | 'READY' | 'FAILED';

/** Reference to another resource (contract schema `Ref`). */
export type Ref = { id: number; name: string };

/** The report as the list and the publication return it (contract schema `Report`, D-118). */
export type ReportView = {
  id: number;
  applicationId: number;
  title: string;
  format: ReportFormat;
  status: ReportStatus;
  isPublished: boolean;
  fileName: string | null;
  fileSize: number | null;
  errorMessage: string | null;
  generatedBy: Ref;
  createdAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
  publishedAt: Date | null;
};

/** What is stored in `report.parameters` (contract schema `ReportParameters`, CP-10). */
export type ReportParameters = { format: ReportFormat; scope: ReportScopeBody; publish: boolean };

/** The report with its parameters (contract schema `ReportDetail`). */
export type ReportDetailView = ReportView & { parameters: ReportParameters };

/** The data of a new report. `parameters` is stored exactly as the service built it. */
export type NewReport = {
  applicationId: number;
  title: string;
  format: ReportFormat;
  parameters: ReportParameters;
  generatedById: number;
};

/** The page of reports `GET /reports` asks for. Fixed order: `createdAt` descending, then `id` descending. */
export type ReportListQuery = {
  applicationId: number;
  /** `true` = only published, `false` = only unpublished, `undefined` = both. */
  published?: boolean | undefined;
  skip: number;
  take: number;
};

const VIEW_SELECT = {
  id: true,
  applicationId: true,
  title: true,
  format: true,
  status: true,
  isPublished: true,
  fileName: true,
  fileSize: true,
  errorMessage: true,
  createdAt: true,
  updatedAt: true,
  completedAt: true,
  publishedAt: true,
  generatedBy: { select: { id: true, name: true } },
} as const;

const DETAIL_SELECT = { ...VIEW_SELECT, parameters: true } as const;

type ViewRow = Prisma.ReportGetPayload<{ select: typeof VIEW_SELECT }>;

const toView = (row: ViewRow): ReportView => ({
  id: row.id,
  applicationId: row.applicationId,
  title: row.title,
  format: row.format,
  status: row.status,
  isPublished: row.isPublished,
  fileName: row.fileName,
  fileSize: row.fileSize,
  errorMessage: row.errorMessage,
  generatedBy: row.generatedBy,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
  completedAt: row.completedAt,
  publishedAt: row.publishedAt,
});

/** True when the application exists. */
export async function applicationExists(client: ReportsClient, applicationId: number): Promise<boolean> {
  const row = await client.application.findUnique({ where: { id: applicationId }, select: { id: true } });
  return row !== null;
}

/**
 * Which of `screenIds` are screens of the application.
 *
 * @returns The ids that exist in `applicationId` (a screen of another application is not in the set).
 */
export async function screensOfApplication(
  client: ReportsClient,
  applicationId: number,
  screenIds: readonly number[],
): Promise<Set<number>> {
  const rows = await client.screen.findMany({
    where: { applicationId, id: { in: [...screenIds] } },
    select: { id: true },
  });
  return new Set(rows.map((row) => row.id));
}

/** Inserts a report as PENDING and returns it. */
export async function insertReport(client: ReportsClient, data: NewReport): Promise<ReportView> {
  const row = await client.report.create({
    data: {
      applicationId: data.applicationId,
      title: data.title,
      format: data.format,
      parameters: data.parameters,
      generatedById: data.generatedById,
    },
    select: VIEW_SELECT,
  });
  return toView(row);
}

/** A page of reports (without parameters) and the total that matches the filters. */
export async function listReports(
  client: ReportsClient,
  query: ReportListQuery,
): Promise<{ data: ReportView[]; total: number }> {
  const where: Prisma.ReportWhereInput = {
    applicationId: query.applicationId,
    ...(query.published === undefined ? {} : { isPublished: query.published }),
  };
  // One statement after the other: the transaction of the caller has one connection.
  const rows = await client.report.findMany({
    where,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    skip: query.skip,
    take: query.take,
    select: VIEW_SELECT,
  });
  const total = await client.report.count({ where });
  return { data: rows.map(toView), total };
}

/** A report with its parameters, or `null`. Never loads the file. */
export async function findReport(client: ReportsClient, id: number): Promise<ReportDetailView | null> {
  const row = await client.report.findUnique({ where: { id }, select: DETAIL_SELECT });
  return row === null ? null : { ...toView(row), parameters: row.parameters as unknown as ReportParameters };
}

/** Locks the row of a report until the end of the transaction (waits for another lock on it). */
export async function lockReportForUpdate(client: Pick<ReportsClient, '$queryRaw'>, id: number): Promise<void> {
  await client.$queryRaw`SELECT id FROM report WHERE id = ${id} FOR UPDATE`;
}

/** The binary of a report and its media type, or `null` when there is no file. The only query that reads the file. */
export async function findFile(
  client: ReportsClient,
  reportId: number,
): Promise<{ mimeType: string; content: Buffer } | null> {
  const row = await client.reportFile.findUnique({
    where: { reportId },
    select: { mimeType: true, content: true },
  });
  return row === null ? null : { mimeType: row.mimeType, content: Buffer.from(row.content) };
}

/** Sets the publication of a report and returns it (`updated_at` moves by the database trigger). */
export async function updatePublication(
  client: ReportsClient,
  id: number,
  isPublished: boolean,
  publishedAt: Date | null,
): Promise<ReportView> {
  const row = await client.report.update({
    where: { id },
    data: { isPublished, publishedAt },
    select: VIEW_SELECT,
  });
  return toView(row);
}
