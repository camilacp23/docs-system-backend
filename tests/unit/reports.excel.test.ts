/**
 * The Excel report (D-117): text is written as literal strings, never as formulas. The neutralizer on its own, then a
 * workbook with malicious values that is written by the generator and read back with exceljs (the only place a
 * workbook is READ: a file this very generator wrote): no cell is a formula, the stored text is the original with a
 * `'` in front when it begins with `=`, `+`, `-`, `@`, a tab or a carriage return, and the properties of the workbook
 * and the headers are treated the same. Also the evidence that exceljs 4.4.0 has no `quotePrefix`, which is why the
 * technique is the apostrophe, and the sizes of text and the dates and numbers.
 */
import '../helpers/env.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import ExcelJS from 'exceljs';
import type { CellValue, ReportContent } from '../../src/modules/reports/content.js';
import { generateExcel, XLSX_MIME } from '../../src/jobs/reports/excel.js';
import { EXCEL_MAX_CELL_LENGTH, excelText, neutralizeText } from '../../src/jobs/reports/neutralize.js';

const context = {
  checkpoint: () => undefined,
  maxBytes: 50_000_000,
  deadlineMs: Number.POSITIVE_INFINITY,
  signal: new AbortController().signal,
};

const CR = String.fromCharCode(13);
const LF = String.fromCharCode(10);

const read = async (buffer: Buffer): Promise<ExcelJS.Workbook> => {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as ExcelJS.Buffer);
  return workbook;
};

describe('neutralizeText', () => {
  it('puts an apostrophe in front of =, +, -, @, tab and carriage return', () => {
    for (const start of ['=', '+', '-', '@', '\t', '\r']) {
      assert.equal(neutralizeText(`${start}1+1`), `'${start}1+1`, JSON.stringify(start));
    }
  });

  it('leaves the rest as it is: empty text, normal text, a "-" or "=" inside, a space first', () => {
    for (const text of [
      '',
      'Normal text',
      'self-service',
      'a=b',
      'x@y.com',
      'a+b',
      ' =1',
      "'quoted",
      '1-2',
      'é=',
      '\nline',
    ]) {
      assert.equal(neutralizeText(text), text, JSON.stringify(text));
    }
  });

  it('is applied once: an apostrophe that was added is not a formula start', () => {
    assert.equal(neutralizeText(neutralizeText('=1')), "'=1");
  });
});

describe('excelText', () => {
  it('never returns more characters than a cell can hold', () => {
    assert.equal(excelText('x'.repeat(40_000)).length, EXCEL_MAX_CELL_LENGTH);
    assert.equal(excelText(`=${'x'.repeat(40_000)}`).length, EXCEL_MAX_CELL_LENGTH);
  });

  it('keeps the longest text of the documentation (20000 characters) whole, with its apostrophe', () => {
    const longest = `=${'y'.repeat(19_999)}`;
    assert.equal(excelText(longest), `'${longest}`);
  });
});

describe('the workbook of the report', () => {
  const MALICIOUS = [
    '=1+1',
    '+SUM(A1:A9)',
    '-2+3',
    '@SUM(1,1)',
    '\t=cmd',
    '\r=cmd',
    '=HYPERLINK("https://example.test","click")',
    "=cmd|' /C calc'!A0",
  ];
  const NORMAL = ['Normal text', 'self-service', 'a=b', 'Pantalla de configuración ñandú'];

  const content = (): ReportContent => ({
    title: '=Report title',
    application: '+Application',
    generatedBy: '@Ada',
    generatedAt: new Date(Date.UTC(2026, 10, 14, 16, 20, 5)),
    sections: [
      {
        name: 'Variables',
        layout: 'records',
        columns: [
          { header: '=Header', width: 20 },
          { header: 'Text', width: 40 },
          { header: 'Number', width: 10 },
          { header: 'Date', width: 22 },
        ],
        rows: [
          ...[...MALICIOUS, ...NORMAL].map((text, index): CellValue[] => [
            text,
            text,
            index,
            new Date(Date.UTC(2026, 0, 1 + index, 8, 30)),
          ]),
          ['', null, 0, null],
        ],
      },
    ],
  });

  it('no cell is a formula; the dangerous text is the original with an apostrophe, the rest is untouched', async () => {
    const file = await generateExcel(content(), context);
    assert.equal(file.mimeType, XLSX_MIME);
    assert.deepEqual([...file.buffer.subarray(0, 4)], [0x50, 0x4b, 0x03, 0x04], 'PK\\x03\\x04');
    const workbook = await read(file.buffer);
    const sheet = workbook.getWorksheet('Variables')!;
    let checked = 0;
    sheet.eachRow((row, rowNumber) => {
      row.eachCell((cell) => {
        assert.notEqual(cell.type, ExcelJS.ValueType.Formula, `${cell.address} is a formula`);
        assert.equal(cell.formula, undefined, `${cell.address} has a formula`);
        assert.equal(
          typeof cell.value === 'object' && cell.value !== null && !(cell.value instanceof Date),
          false,
          cell.address,
        );
        checked += 1;
      });
      if (rowNumber === 1) return;
      const original = [...MALICIOUS, ...NORMAL][rowNumber - 2];
      if (original === undefined) return;
      // XML turns a carriage return into a line feed when the file is read; the apostrophe in front is what matters.
      const expected = (MALICIOUS.includes(original) ? `'${original}` : original).replaceAll(CR, LF);
      assert.equal(row.getCell(1).value, expected, `row ${rowNumber}`);
      assert.equal(row.getCell(2).value, expected, `row ${rowNumber}`);
    });
    assert.ok(checked > 40);
    assert.equal(sheet.getCell('A1').value, "'=Header", 'the headers too');
  });

  it('the properties of the workbook are neutralized and come from the report', async () => {
    const workbook = await read((await generateExcel(content(), context)).buffer);
    assert.equal(workbook.title, "'=Report title");
    assert.equal(workbook.creator, "'@Ada");
    assert.equal(workbook.lastModifiedBy, "'@Ada");
    assert.equal(workbook.created.toISOString(), '2026-11-14T16:20:05.000Z');
  });

  it('numbers are numbers and dates are dates in UTC', async () => {
    const workbook = await read((await generateExcel(content(), context)).buffer);
    const sheet = workbook.getWorksheet('Variables')!;
    const third = sheet.getRow(4); // header + two rows before it
    assert.equal(third.getCell(3).type, ExcelJS.ValueType.Number);
    assert.equal(third.getCell(3).value, 2);
    assert.equal(third.getCell(4).type, ExcelJS.ValueType.Date);
    assert.equal((third.getCell(4).value as Date).toISOString(), '2026-01-03T08:30:00.000Z');
  });

  it('the longest texts are written whole (20000 characters) and nothing exceeds a cell (32767)', async () => {
    const longest = `=${'z'.repeat(19_999)}`;
    const huge = 'h'.repeat(40_000);
    const big: ReportContent = {
      ...content(),
      sections: [
        {
          name: 'Screens',
          layout: 'records',
          columns: [
            { header: 'Name', width: 10 },
            { header: 'Text', width: 10 },
          ],
          rows: [
            ['longest', longest],
            ['huge', huge],
          ],
        },
      ],
    };
    const sheet = (await read((await generateExcel(big, context)).buffer)).getWorksheet('Screens')!;
    assert.equal(sheet.getCell('B2').value, `'${longest}`);
    assert.equal((sheet.getCell('B3').value as string).length, EXCEL_MAX_CELL_LENGTH);
  });

  it('a sheet has the fixed name of its part, one per part, in the order of the content', async () => {
    const parts = ['Summary', 'Screens', 'Components', 'Variables', 'Collections', 'Collection fields', 'Dependencies'];
    const many: ReportContent = {
      ...content(),
      sections: parts.map((name) => ({
        name,
        layout: 'lines' as const,
        columns: [{ header: 'A', width: 8 }],
        rows: [['x']],
      })),
    };
    const workbook = await read((await generateExcel(many, context)).buffer);
    assert.deepEqual(
      workbook.worksheets.map((s) => s.name),
      parts,
    );
    for (const part of parts) assert.ok(part.length <= 31, part);
  });

  describe('why the technique is the apostrophe (D-117 prefers quotePrefix when exceljs supports it)', () => {
    it('exceljs 4.4.0 does not keep quotePrefix: written on a cell, it is not there when the file is read again', async () => {
      const workbook = new ExcelJS.Workbook();
      const sheet = workbook.addWorksheet('T');
      sheet.getCell('A1').value = '=1+1';
      sheet.getCell('A1').style = { quotePrefix: true } as unknown as Partial<ExcelJS.Style>;
      const again = await read(Buffer.from(await workbook.xlsx.writeBuffer()));
      const style = again.getWorksheet('T')!.getCell('A1').style as unknown as { quotePrefix?: boolean };
      assert.equal(style.quotePrefix, undefined);
    });
  });
});
