/**
 * Why a report fails (D-119): a closed catalog of four texts, the only values `report.error_message` can hold. The
 * contract lists them as an `enum` of `ReportCore.errorMessage`; nothing else (an exception's text, SQL, a trace) ever
 * reaches the client, the detail goes to the server log with the id of the report.
 *
 * @module modules/reports/failures
 */

/** The four texts of the contract. */
export const REPORT_ERROR_MESSAGES = {
  TOO_SLOW: 'The report took too long to generate. Try again with a smaller selection.',
  TOO_LARGE: 'The report is too large. Select fewer elements and try again.',
  SCREEN_GONE: 'A selected screen no longer exists. Select the screens again and try once more.',
  OTHER: "The report couldn't be generated. Try again in a few minutes.",
} as const;

/** The reason of a failed report. */
export type ReportFailure = keyof typeof REPORT_ERROR_MESSAGES;

/** A report that is slower than `REPORT_MAX_SECONDS`. */
export class ReportTooSlowError extends Error {
  constructor() {
    super('report generation exceeded its time limit');
    this.name = 'ReportTooSlowError';
  }
}

/**
 * A report with more rows or bytes than `REPORT_MAX_ROWS` / `REPORT_MAX_BYTES`, or whose generation needed more memory
 * than `REPORT_MAX_MEMORY_MB` (`memory`: the generator thread ran out of it).
 */
export class ReportTooLargeError extends Error {
  constructor(readonly limit: 'rows' | 'chars' | 'bytes' | 'memory') {
    super(`report exceeded its ${limit} limit`);
    this.name = 'ReportTooLargeError';
  }
}

/** A screen of `scope.screenIds` that no longer exists in the application (deleted after the request). */
export class ReportScreenGoneError extends Error {
  constructor() {
    super('a screen of the report no longer exists');
    this.name = 'ReportScreenGoneError';
  }
}

/** The worker is stopping: the report is given up (not failed) and stays PENDING for the next start. */
export class ReportAbandonedError extends Error {
  constructor() {
    super('report generation abandoned by shutdown');
    this.name = 'ReportAbandonedError';
  }
}

/** The generator thread failed for a reason other than time, size or memory. Only the class of the error travels. */
export class ReportThreadError extends Error {
  /**
   * @param errorClass - The class of the error of the thread (or `exit code N`).
   * @param specifier - The module Node could not find (`ERR_MODULE_NOT_FOUND`, `ERR_PACKAGE_PATH_NOT_EXPORTED`): a package
   *   name or a path relative to the repository.
   * @param code - The `code` of that error when it has one (`ERR_…`, `ENOENT`…), a fixed identifier and never content.
   */
  constructor(
    readonly errorClass: string,
    readonly code?: string,
    readonly specifier?: string,
  ) {
    super('the report generator thread failed');
    this.name = 'ReportThreadError';
  }
}
