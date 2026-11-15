/**
 * Helpers of the reports tests: the shape of the responses and report fixtures written with the owner connection
 * (a READY report with its file, a FAILED one...), so a test does not need the worker to have a report in a state.
 * Everything runs on the disposable database of `startTestApp`.
 */
import type { TestApp } from './app.js';

/** A report as the API returns it (`Report`; `parameters` only in the detail). */
export type ReportBody = {
  id: number;
  applicationId: number;
  title: string;
  format: 'PDF' | 'XLSX';
  status: 'PENDING' | 'READY' | 'FAILED';
  isPublished: boolean;
  fileName: string | null;
  fileSize: number | null;
  errorMessage: string | null;
  generatedBy: { id: number; name: string };
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  publishedAt: string | null;
  parameters?: { format: 'PDF' | 'XLSX'; scope: Record<string, unknown>; publish: boolean };
};

/** Typed view of a single-report response. */
export const reportOf = (res: { body: unknown }): ReportBody => (res.body as { data: ReportBody }).data;

/** Typed view of the reports page. */
export const reportsPageOf = (res: { body: unknown }) =>
  res.body as { data: ReportBody[]; page: number; pageSize: number; total: number };

/** The magic number of each format, so a fixture looks like what the worker writes. */
export const PDF_SIGNATURE = Buffer.from('%PDF-1.7\n');
export const ZIP_SIGNATURE = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

export const PDF_MIME = 'application/pdf';
export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** What a fixture can set; the rest has a sensible default. */
export type ReportFixture = {
  applicationId: number;
  title?: string;
  format?: 'PDF' | 'XLSX';
  status?: 'PENDING' | 'READY' | 'FAILED';
  published?: boolean;
  generatedBy?: number;
  createdAt?: string;
  content?: Buffer;
  errorMessage?: string;
  parameters?: object;
};

let counter = 0;

/**
 * Inserts a report (and its file when it is READY) and returns its id. A READY report is complete (`file_name`,
 * `file_size`, `completed_at`) and, if `published`, has `published_at`, as the CHECK constraints require.
 */
export async function insertReport(t: Pick<TestApp, 'owner' | 'users'>, fixture: ReportFixture): Promise<number> {
  counter += 1;
  const format = fixture.format ?? 'PDF';
  const status = fixture.status ?? 'READY';
  const title = fixture.title ?? `Fixture report ${counter}`;
  const content = fixture.content ?? (format === 'PDF' ? PDF_SIGNATURE : ZIP_SIGNATURE);
  const ready = status === 'READY';
  const published = ready && fixture.published === true;
  const ext = format === 'PDF' ? 'pdf' : 'xlsx';
  const created = fixture.createdAt ?? new Date().toISOString();
  const parameters = fixture.parameters ?? { format, scope: { elementTypes: ['VARIABLE'] }, publish: false };
  const { rows } = await t.owner.query<{ id: number }>(
    `INSERT INTO report (application_id, title, format, parameters, status, is_published, file_name, file_size,
                         error_message, generated_by, created_at, completed_at, published_at)
     VALUES ($1, $2, $3::report_format, $4::jsonb, $5::report_status, $6, $7, $8, $9, $10, $11::timestamptz,
             $12::timestamptz, $13::timestamptz)
     RETURNING id`,
    [
      fixture.applicationId,
      title,
      format,
      JSON.stringify(parameters),
      status,
      published,
      ready ? `fixture-report-${counter}-2026-11-14.${ext}` : null,
      ready ? content.length : null,
      status === 'FAILED'
        ? (fixture.errorMessage ?? "The report couldn't be generated. Try again in a few minutes.")
        : null,
      fixture.generatedBy ?? t.users.admin.id,
      created,
      ready ? created : null,
      published ? created : null,
    ],
  );
  const id = rows[0]!.id;
  if (ready) {
    await t.owner.query(`INSERT INTO report_file (report_id, mime_type, content) VALUES ($1, $2, $3)`, [
      id,
      format === 'PDF' ? PDF_MIME : XLSX_MIME,
      content,
    ]);
  }
  return id;
}

/**
 * The audit records of one report, oldest first. A fixture inserted with the owner connection has its own CREATE
 * record (no actor), so tests that look at what the API wrote ask for `action`.
 */
export async function auditOfReport(t: Pick<TestApp, 'owner'>, reportId: number, action?: 'CREATE' | 'UPDATE') {
  const { rows } = await t.owner.query<{ action: string; actor_user_id: number | null; changed_fields: string[] }>(
    `SELECT action, actor_user_id, changed_fields FROM audit_log
      WHERE entity_type = 'report' AND entity_id = $1 AND ($2::text IS NULL OR action = $2) ORDER BY id`,
    [String(reportId), action ?? null],
  );
  return rows;
}

/**
 * What the worker logged when it failed a report, for the message of an assertion: the kind of failure, the class and
 * the code of the error, the database codes and the first frames of the stack. Never a value of the documentation (the
 * worker does not log one), so it can be printed by a CI run.
 *
 * @param lines - The JSON log lines written while the pass ran.
 * @returns A line per failure, or an empty string when the worker logged none.
 */
export function explainWorkerFailures(lines: readonly string[]): string {
  const FIELDS = ['failure', 'errorClass', 'threadErrorClass', 'threadCode', 'prismaCode', 'sqlstate', 'limit'];
  const out: string[] = [];
  for (const line of lines) {
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const msg = typeof entry['msg'] === 'string' ? entry['msg'] : '';
    if (!msg.startsWith('report generation failed') && !msg.startsWith('could not')) continue;
    const facts = FIELDS.filter((key) => entry[key] !== undefined && entry[key] !== null).map(
      (key) => `${key}=${String(entry[key])}`,
    );
    const frames = typeof entry['stack'] === 'string' ? entry['stack'].split('\n').slice(0, 2).join(' |') : '';
    out.push(`report ${String(entry['reportId'])}: ${msg} (${facts.join(', ')})${frames === '' ? '' : ` ${frames}`}`);
  }
  return out.length === 0 ? '' : `\nworker log:\n  ${out.join('\n  ')}`;
}
