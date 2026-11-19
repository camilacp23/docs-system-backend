/**
 * Text in the Excel (D-117, OWASP "CSV/Formula Injection"). A text value of the documentation can start with a
 * character that Excel reads as the start of a formula when the cell is edited (Power Fx formulas in `onSelect` do).
 * The contract requires every such value to be a literal string, never a formula.
 *
 * The technique is the visible apostrophe: exceljs 4.4.0 has no `quotePrefix` (the attribute that forces text without
 * showing anything; checked by writing it and reading the XML back, see `tests/unit/reports.excel.test.ts`), so a value
 * that begins with `=`, `+`, `-`, `@`, a tab or a carriage return is written with a `'` in front. Every text is also
 * written as an explicit string, never as `{ formula }` or an object, so exceljs cannot interpret it.
 *
 * @module jobs/reports/neutralize
 */

/** The characters that start a formula for Excel (the contract: `=`, `+`, `-`, `@`, tab, carriage return). */
const FORMULA_START = /^[=+\-@\t\r]/;

/** The most characters a cell can hold in Excel. */
export const EXCEL_MAX_CELL_LENGTH = 32_767;

/**
 * Makes a text safe to write to a cell.
 *
 * @param value - Text as stored in the documentation (an empty string stays empty).
 * @returns The text, with a `'` in front when it begins with a formula character.
 */
export function neutralizeText(value: string): string {
  return FORMULA_START.test(value) ? `'${value}` : value;
}

/**
 * A text ready for a cell or a property of the workbook: neutralized and never longer than a cell allows (the longest
 * text of the documentation is 20000 characters, so nothing is cut in practice).
 *
 * @param value - Text to write.
 */
export function excelText(value: string): string {
  const safe = neutralizeText(value);
  return safe.length > EXCEL_MAX_CELL_LENGTH ? safe.slice(0, EXCEL_MAX_CELL_LENGTH) : safe;
}
