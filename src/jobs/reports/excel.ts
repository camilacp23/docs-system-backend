/**
 * The Excel report (D-116, D-117): one sheet per part, written to memory.
 *
 * Only WRITES: no workbook is ever read here (the one place that reads a workbook is the tests, on files this
 * generator produced). `writeBuffer` builds the file in memory, so nothing is written to the disk; the CSV, image and
 * reading functions of exceljs are never used. exceljs is loaded here, when a report is generated, and not when the
 * server starts. Every text goes through `excelText` and is a string cell; numbers and dates are numbers and dates (UTC).
 *
 * @module jobs/reports/excel
 */
import type { ContentSection, ReportContent } from '../../modules/reports/content.js';
import { excelText } from './neutralize.js';
import type { GeneratedFile, GeneratorContext } from './types.js';

/** Rows written between two looks at the clock and the event loop. */
const ROWS_PER_TURN = 200;

/** Media type of an `.xlsx` file. */
export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

const yieldToEventLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** A cell: dates and numbers as they are, text neutralized, nothing as an empty cell. */
function cellOf(value: ContentSection['rows'][number][number]): string | number | Date | null {
  if (typeof value === 'string') return excelText(value);
  return value;
}

/**
 * Generates the workbook.
 *
 * @param content - The parts of the report.
 * @param context - The time limit and size limit checks.
 * @returns The `.xlsx` file.
 */
export async function generateExcel(content: ReportContent, context: GeneratorContext): Promise<GeneratedFile> {
  const { default: ExcelJS } = await import('exceljs');
  const workbook = new ExcelJS.Workbook();
  // The properties come from the report and are text like any other (D-117).
  workbook.title = excelText(content.title);
  workbook.creator = excelText(content.generatedBy);
  workbook.lastModifiedBy = excelText(content.generatedBy);
  workbook.created = content.generatedAt;
  workbook.modified = content.generatedAt;

  for (const section of content.sections) {
    const sheet = workbook.addWorksheet(section.name); // fixed names of at most 31 characters (D-116)
    sheet.columns = section.columns.map((column) => ({ header: excelText(column.header), width: column.width }));
    sheet.getRow(1).font = { bold: true };
    sheet.views = [{ state: 'frozen', ySplit: 1 }];
    const dateColumns = section.columns.map((_, index) => section.rows.some((row) => row[index] instanceof Date));
    let written = 0;
    for (const values of section.rows) {
      const row = sheet.addRow(values.map(cellOf));
      values.forEach((value, index) => {
        if (value instanceof Date && dateColumns[index]) row.getCell(index + 1).numFmt = 'yyyy-mm-dd hh:mm:ss';
      });
      written += 1;
      if (written % ROWS_PER_TURN === 0) {
        await context.checkpoint();
        await yieldToEventLoop();
      }
    }
    await context.checkpoint();
    await yieldToEventLoop();
  }

  const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
  return { buffer, mimeType: XLSX_MIME, replacedCharacters: 0 };
}
