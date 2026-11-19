/**
 * Name of the file of a report (D-120). Pure.
 *
 * @module modules/reports/fileName
 */

/** The longest part taken from the title. */
const MAX_TITLE_PART = 80;

/**
 * `<title>-YYYY-MM-DD.<ext>`: the title in lowercase ASCII (NFKD without combining marks), every run of characters
 * other than `a-z` and `0-9` replaced by one `-`, no `-` at the ends, at most 80 characters (`report` when nothing is
 * left), then the UTC date of `completedAt` and `.pdf` or `.xlsx`. Only `a-z`, `0-9`, `-` and `.` can appear.
 *
 * @param title - Title of the report, as the user wrote it.
 * @param format - `PDF` or `XLSX`.
 * @param completedAt - The instant the report became READY.
 */
export function reportFileName(title: string, format: 'PDF' | 'XLSX', completedAt: Date): string {
  const slug = title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_TITLE_PART)
    .replace(/-+$/g, '');
  const date = completedAt.toISOString().slice(0, 10);
  return `${slug === '' ? 'report' : slug}-${date}.${format === 'PDF' ? 'pdf' : 'xlsx'}`;
}
