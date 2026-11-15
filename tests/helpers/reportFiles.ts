/**
 * Reading what the report worker wrote, for the tests: the file of a report from `report_file`, the facts of a PDF (number
 * of pages, Title, Author) and a workbook read back with exceljs. exceljs READS here only because the file is one this
 * very generator wrote; the API never reads a workbook.
 */
import ExcelJS from 'exceljs';
import type { TestApp } from './app.js';

/** The bytes and the media type stored for a report, or `null`. */
export async function fileOf(
  t: Pick<TestApp, 'owner'>,
  reportId: number,
): Promise<{ mimeType: string; content: Buffer } | null> {
  const { rows } = await t.owner.query<{ mime_type: string; content: Buffer }>(
    `SELECT mime_type, content FROM report_file WHERE report_id = $1`,
    [reportId],
  );
  return rows[0] === undefined ? null : { mimeType: rows[0].mime_type, content: rows[0].content };
}

/** A string object of the PDF (`N 0 obj (text)`), decoded (UTF-16BE with a byte order mark when it is not ASCII). */
function pdfString(text: string, reference: string | undefined): string | undefined {
  if (reference === undefined) return undefined;
  const literal = new RegExp(`\\n${reference} 0 obj\\n\\(([^\\n]*)\\)\\n`).exec(text)?.[1];
  if (literal === undefined) return undefined;
  if (!literal.startsWith('þÿ')) return literal;
  const bytes = Buffer.from(literal.slice(2), 'latin1');
  return Buffer.from(bytes.swap16()).toString('utf16le');
}

/** What the tests check of a PDF: its pages and the Title and Author of its information dictionary. */
export function pdfFacts(file: Buffer): { pages: number; title: string | undefined; author: string | undefined } {
  const text = file.toString('latin1');
  return {
    pages: (text.match(/\/Type \/Page\b(?!s)/g) ?? []).length,
    title: pdfString(text, /\/Title (\d+) 0 R/.exec(text)?.[1]),
    author: pdfString(text, /\/Author (\d+) 0 R/.exec(text)?.[1]),
  };
}

/** Reads a workbook that the generator wrote. */
export async function readWorkbook(file: Buffer): Promise<ExcelJS.Workbook> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(file as unknown as ExcelJS.Buffer);
  return workbook;
}

/** The values of a sheet as rows of text, without the header. */
export function sheetRows(sheet: ExcelJS.Worksheet): ExcelJS.CellValue[][] {
  const rows: ExcelJS.CellValue[][] = [];
  sheet.eachRow((row, number) => {
    if (number === 1) return;
    rows.push((row.values as ExcelJS.CellValue[]).slice(1));
  });
  return rows;
}

/** The header of a sheet. */
export function sheetHeader(sheet: ExcelJS.Worksheet): string[] {
  return (sheet.getRow(1).values as ExcelJS.CellValue[]).slice(1).map(String);
}
