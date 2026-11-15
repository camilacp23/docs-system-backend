/**
 * The fonts of the PDF reports: the three files exist, are the exact files recorded in `fonts/SOURCE.md` (so a change
 * of a font is a visible change), open with pdfkit, and `npm run build` copies them to `dist/`.
 */
import '../helpers/env.js';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import PDFDocument from 'pdfkit';
import { FONT_FILES, fontPath, type FontRole } from '../../src/jobs/reports/fonts.js';

const SOURCE = readFileSync(new URL('../../src/jobs/reports/fonts/SOURCE.md', import.meta.url), 'utf8');
const sha256 = (file: string): string => createHash('sha256').update(readFileSync(file)).digest('hex');

describe('PDF fonts', () => {
  for (const role of Object.keys(FONT_FILES) as FontRole[]) {
    it(`${role}: is the recorded file and a valid font with Spanish letters`, () => {
      const path = fontPath(role);
      assert.ok(SOURCE.includes(sha256(path)), `${FONT_FILES[role]} does not match SOURCE.md`);
      const { font } = new PDFDocument({ autoFirstPage: false }).font(path)._font;
      for (const char of 'áéíóúüñÁÉÍÓÚÜÑ¿¡€–—“”') assert.ok(font.hasGlyphForCodePoint(char.codePointAt(0)!), char);
    });
  }

  it('the license text is next to the fonts', () => {
    const license = readFileSync(new URL('../../src/jobs/reports/fonts/LICENSE.txt', import.meta.url), 'utf8');
    assert.match(license, /SIL OPEN FONT LICENSE Version 1\.1/);
  });

  it('the copy step puts the fonts and the license in the output directory', () => {
    const out = mkdtempSync(join(tmpdir(), 'fonts-copy-'));
    try {
      execFileSync(process.execPath, ['scripts/copy-sql.mjs', '--out', out], { stdio: 'pipe' });
      for (const file of [...Object.values(FONT_FILES), 'LICENSE.txt']) {
        const copied = join(out, 'jobs', 'reports', 'fonts', file);
        assert.ok(existsSync(copied), file);
        assert.equal(sha256(copied), sha256(join('src', 'jobs', 'reports', 'fonts', file)), file);
      }
      assert.ok(existsSync(join(out, 'modules', 'dependencies', 'graph.sql')), 'the SQL files are still copied');
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });
});
