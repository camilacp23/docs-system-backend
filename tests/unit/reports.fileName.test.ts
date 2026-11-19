/** The name of the file of a report (D-120): lowercase ASCII, runs of other characters become one "-", at most 80. */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { reportFileName } from '../../src/modules/reports/fileName.js';

const DAY = new Date(Date.UTC(2026, 10, 14, 23, 59, 59));

describe('reportFileName', () => {
  it('lowercases, removes accents and joins the rest with single hyphens', () => {
    assert.equal(
      reportFileName('Documentación de SAR - octubre 2026', 'PDF', DAY),
      'documentacion-de-sar-octubre-2026-2026-11-14.pdf',
    );
    assert.equal(
      reportFileName('Variables y colecciones de SAR', 'XLSX', DAY),
      'variables-y-colecciones-de-sar-2026-11-14.xlsx',
    );
    assert.equal(reportFileName('  ¡Ñandú!  ', 'PDF', DAY), 'nandu-2026-11-14.pdf');
  });

  it('uses "report" when nothing is left', () => {
    for (const title of ['***', '   ', '中文', '../../'])
      assert.equal(reportFileName(title, 'PDF', DAY), 'report-2026-11-14.pdf');
  });

  it('takes at most 80 characters of the title and never ends that part with a hyphen', () => {
    const name = reportFileName(`${'a'.repeat(79)} bbbb`, 'PDF', DAY);
    assert.equal(name, `${'a'.repeat(79)}-2026-11-14.pdf`);
    assert.equal(reportFileName('x'.repeat(300), 'PDF', DAY), `${'x'.repeat(80)}-2026-11-14.pdf`);
  });

  it('the date is the UTC date of completedAt', () => {
    assert.match(reportFileName('t', 'PDF', new Date('2026-12-31T23:30:00-05:00')), /-2027-01-01\.pdf$/);
  });

  it('only a-z, 0-9, "-" and "." can appear, whatever the title has (quotes, separators, control characters)', () => {
    for (const title of ['a"b', 'a/b\\c', 'a\r\nb', 'a;b=c', '=cmd|calc', 'ＡＢＣ', 'x\u0000y']) {
      assert.match(reportFileName(title, 'XLSX', DAY), /^[a-z0-9][a-z0-9.-]*$/, JSON.stringify(title));
    }
  });
});
