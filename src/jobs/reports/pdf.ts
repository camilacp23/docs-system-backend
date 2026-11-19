/**
 * The PDF report (D-116): the same parts, columns and order as the Excel, one section per part, written to memory.
 *
 * The layout is a corporate template: a cover with the report data and its contents, a running header and a footer with
 * the page number, and one numbered band per part. A part with long texts is printed as one card per row (`records`);
 * Components are grouped under a heading with the screen they belong to, so a report of several screens always says
 * which screen each element is from. A part of short values (`lines`) is a table.
 *
 * pdfkit is loaded here, when a report is generated, and not when the server starts. The text is drawn with the IBM
 * Plex fonts that travel with the code (see `fonts/SOURCE.md`); a character that the font cannot draw is replaced by
 * `?` and counted (the worker logs one warning per report with the count, never the text). Long texts flow over as many
 * pages as they need: nothing is cut.
 *
 * @module jobs/reports/pdf
 */
import type { CellValue, ContentSection, ReportContent } from '../../modules/reports/content.js';
import { ReportTooLargeError } from '../../modules/reports/failures.js';
import { fontPath } from './fonts.js';
import type { GeneratedFile, GeneratorContext } from './types.js';

/** Media type of a PDF. */
export const PDF_MIME = 'application/pdf';

/** Characters printed between two looks at the clock and the event loop (pdfkit lays text out synchronously). */
const CHARS_PER_TURN = 5_000;
const MARGIN = 50;
const TOP = 64;
const BOTTOM = 56;
const NAMES = { regular: 'plex-sans', bold: 'plex-sans-bold', mono: 'plex-mono' } as const;
type FontName = keyof typeof NAMES;

/** Corporate palette: navy for structure, blue as the accent, greys for support text. */
const COLOR = {
  navy: '#0B2545',
  blue: '#1F5FBF',
  paleBlue: '#DCE7F7',
  band: '#F1F5F9',
  zebra: '#F8FAFC',
  line: '#CBD5E1',
  text: '#1E293B',
  muted: '#64748B',
  white: '#FFFFFF',
  neutral: '#475569',
  onNavy: '#C9D8F2',
} as const;

/** Colour of the badge of a documentation status; any other badge text (control type, data type) is neutral. */
const STATUS_COLOR: Record<string, string> = {
  UNDOCUMENTED: '#6B7280',
  DRAFT: '#B45309',
  IN_PROGRESS: '#1D4ED8',
  IN_REVIEW: '#7E22CE',
  APPROVED: '#15803D',
};

/**
 * How a part is drawn as records: the column that titles the card, the one shown as a badge, the ones shown in the grey
 * line under the title, and (Components) the column whose value groups the cards under a heading. Every other column
 * becomes a labelled text field.
 */
type RecordStyle = { group?: number; title: number; badge?: number; meta?: number[] };
const RECORD_STYLES: Record<string, RecordStyle> = {
  Screens: { title: 0, badge: 1, meta: [2, 3, 4] },
  Components: { group: 0, title: 1, badge: 2 },
  Variables: { title: 0, badge: 1, meta: [2, 3, 5] },
  Collections: { title: 0, meta: [3, 4] },
};
const DEFAULT_STYLE: RecordStyle = { title: 0 };

const yieldToEventLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** `2026-11-14 16:20:00 UTC`. */
const utc = (date: Date): string => `${date.toISOString().slice(0, 19).replace('T', ' ')} UTC`;

const textOf = (value: CellValue): string => {
  if (value === null) return '';
  if (value instanceof Date) return utc(value);
  return String(value);
};

/**
 * Generates the PDF.
 *
 * @param content - The parts of the report.
 * @param context - The time limit and size limit checks.
 * @returns The PDF file and how many characters had no glyph.
 */
export async function generatePdf(content: ReportContent, context: GeneratorContext): Promise<GeneratedFile> {
  const { default: PDFDocument } = await import('pdfkit');
  const doc = new PDFDocument({
    size: 'A4',
    margins: { top: TOP, bottom: BOTTOM, left: MARGIN, right: MARGIN },
    // Title and Author are the title and the person of the report itself: nothing that is not in the report.
    info: { Title: clean(content.title), Author: clean(content.generatedBy), CreationDate: content.generatedAt },
  });
  doc.registerFont(NAMES.regular, fontPath('regular'));
  doc.registerFont(NAMES.bold, fontPath('bold'));
  doc.registerFont(NAMES.mono, fontPath('mono'));

  const chunks: Buffer[] = [];
  let size = 0;
  doc.on('data', (chunk) => {
    chunks.push(chunk);
    size += chunk.length;
  });
  const finished = new Promise<void>((resolve, reject) => {
    doc.on('end', resolve);
    doc.on('error', reject);
  });

  let replaced = 0;
  const width = doc.page.width - MARGIN * 2;
  const bottomLimit = (): number => doc.page.height - BOTTOM;

  /** Returns `text` as the font can draw it: a character without a glyph becomes `?` and is counted. */
  const prep = (text: string, font: FontName): string => {
    doc.font(NAMES[font]);
    const embedded = doc._font.font;
    let out = '';
    for (const char of text.replace(/\r\n?/g, '\n').replace(/\t/g, '    ')) {
      const code = char.codePointAt(0)!;
      if (char === '\n' || (code >= 32 && code !== 127 && embedded.hasGlyphForCodePoint(code))) out += char;
      else {
        out += '?';
        replaced += 1;
      }
    }
    return out === '' ? ' ' : out;
  };

  let sinceTurn = 0;
  /** The font, size and colour in use: a page added in the middle of a text must not change how the text goes on. */
  let active: { font: FontName; size: number; color: string } = { font: 'regular', size: 9, color: COLOR.text };
  const setStyle = (font: FontName, fontSize: number, color: string): void => {
    active = { font, size: fontSize, color };
    doc.font(NAMES[font]).fontSize(fontSize).fillColor(color);
  };
  /** Height of `text` (already through `prep`) laid out in `w`. */
  const measure = (text: string, font: FontName, fontSize: number, w: number): number => {
    doc.font(NAMES[font]).fontSize(fontSize);
    return doc.heightOfString(text, { width: w });
  };
  /** Draws `text` (already through `prep`) at a position. */
  const drawAt = (
    text: string,
    font: FontName,
    fontSize: number,
    color: string,
    x: number,
    y: number,
    options: { width: number; align?: 'left' | 'center' | 'right'; height?: number; ellipsis?: boolean },
  ): void => {
    setStyle(font, fontSize, color);
    doc.text(text, x, y, options);
    sinceTurn += text.length;
  };
  /** Flows text from the cursor, over as many pages as it needs. */
  const flow = (text: string, font: FontName, fontSize: number, color: string, x: number, w: number, gap = 0): void => {
    setStyle(font, fontSize, color);
    doc.x = x;
    doc.text(text, { width: w, paragraphGap: gap });
    sinceTurn += text.length;
  };

  /** When less than `space` points are left on the page, starts a new one. */
  const ensure = (space: number): void => {
    if (doc.y + space > bottomLimit()) doc.addPage();
  };

  /** After a row: when enough text was laid out since the last time, look at the clock and let the event loop run. */
  const turn = async (): Promise<void> => {
    if (sinceTurn < CHARS_PER_TURN) return;
    sinceTurn = 0;
    await context.checkpoint();
    if (size > context.maxBytes) throw new ReportTooLargeError('bytes');
    await yieldToEventLoop();
  };

  // ---- Pages: a running header (not on the cover) and a footer with the page number ------------------------------
  const reportTitle = prep(content.title, 'bold');
  const applicationName = prep(content.application, 'regular');
  const footerLeft = prep(`Generated by ${content.generatedBy}  |  ${utc(content.generatedAt)}`, 'regular');
  let pageNumber = 0;

  const decoratePage = (): void => {
    pageNumber += 1;
    const resume = active;
    const savedBottom = doc.page.margins.bottom;
    doc.page.margins.bottom = 0; // text below the bottom margin must not start a new page
    if (pageNumber > 1) {
      drawAt(reportTitle, 'bold', 8, COLOR.navy, MARGIN, 28, { width: width * 0.6, height: 10, ellipsis: true });
      drawAt(applicationName, 'regular', 8, COLOR.muted, MARGIN + width * 0.6, 28, {
        width: width * 0.4,
        height: 10,
        ellipsis: true,
        align: 'right',
      });
      doc.rect(MARGIN, 42, width, 1.5).fill(COLOR.blue);
    }
    const footerY = doc.page.height - 38;
    doc.rect(MARGIN, footerY - 8, width, 0.5).fill(COLOR.line);
    drawAt(footerLeft, 'regular', 7.5, COLOR.muted, MARGIN, footerY, {
      width: width * 0.8,
      height: 10,
      ellipsis: true,
    });
    drawAt(`Page ${pageNumber}`, 'bold', 7.5, COLOR.navy, MARGIN + width * 0.8, footerY, {
      width: width * 0.2,
      align: 'right',
    });
    doc.page.margins.bottom = savedBottom;
    setStyle(resume.font, resume.size, resume.color);
    doc.x = MARGIN;
    doc.y = TOP;
  };
  doc.on('pageAdded', decoratePage);

  // ---- Cover ------------------------------------------------------------------------------------------------------
  const printCover = (): void => {
    const bandHeight = 128;
    doc.rect(0, 0, doc.page.width, bandHeight).fill(COLOR.navy);
    doc.rect(0, bandHeight, doc.page.width, 4).fill(COLOR.blue);
    drawAt(prep('TECHNICAL DOCUMENTATION REPORT', 'bold'), 'bold', 8, '#9DB8E8', MARGIN, 34, { width });
    const titleHeight = Math.min(measure(reportTitle, 'bold', 24, width), 70);
    drawAt(reportTitle, 'bold', 24, COLOR.white, MARGIN, 52, { width, height: 70, ellipsis: true });
    drawAt(applicationName, 'regular', 11, COLOR.onNavy, MARGIN, 52 + titleHeight + 8, {
      width,
      height: 16,
      ellipsis: true,
    });

    // The three facts of the report, side by side.
    const top = bandHeight + 30;
    const facts: [string, string][] = [
      ['APPLICATION', prep(content.application, 'bold')],
      ['GENERATED BY', prep(content.generatedBy, 'bold')],
      ['GENERATED AT', prep(utc(content.generatedAt), 'bold')],
    ];
    const factWidth = width / 3;
    facts.forEach(([label, value], index) => {
      const x = MARGIN + index * factWidth;
      drawAt(prep(label, 'bold'), 'bold', 7, COLOR.blue, x, top, { width: factWidth - 10 });
      drawAt(value, 'bold', 10, COLOR.text, x, top + 12, { width: factWidth - 10, height: 28, ellipsis: true });
    });
    doc.rect(MARGIN, top + 50, width, 0.5).fill(COLOR.line);

    // Contents: the parts, in order, with the number each one carries in the report.
    let y = top + 70;
    drawAt(prep('CONTENTS', 'bold'), 'bold', 8, COLOR.navy, MARGIN, y, { width });
    y += 18;
    content.sections.forEach((section, index) => {
      doc.roundedRect(MARGIN, y, 22, 16, 3).fill(COLOR.navy);
      drawAt(String(index + 1).padStart(2, '0'), 'bold', 8, COLOR.white, MARGIN, y + 4, { width: 22, align: 'center' });
      drawAt(prep(section.name, 'regular'), 'regular', 10, COLOR.text, MARGIN + 32, y + 3, { width: width - 32 });
      y += 24;
    });
    doc.x = MARGIN;
    doc.y = y + 10;
  };

  // ---- Parts ------------------------------------------------------------------------------------------------------
  /** The numbered band that opens a part. */
  const printBand = (section: ContentSection, index: number): void => {
    ensure(110);
    const y = doc.y;
    const height = 30;
    doc.rect(MARGIN, y, width, height).fill(COLOR.navy);
    doc.rect(MARGIN, y, 44, height).fill(COLOR.blue);
    drawAt(String(index + 1).padStart(2, '0'), 'bold', 14, COLOR.white, MARGIN, y + 8, { width: 44, align: 'center' });
    drawAt(prep(section.name, 'bold'), 'bold', 14, COLOR.white, MARGIN + 56, y + 8, { width: width * 0.6 });
    const unit = section.layout === 'records' ? 'record' : 'row';
    const count = `${section.rows.length} ${unit}${section.rows.length === 1 ? '' : 's'}`;
    drawAt(prep(count, 'regular'), 'regular', 8, COLOR.onNavy, MARGIN + width * 0.6, y + 11, {
      width: width * 0.4 - 12,
      align: 'right',
    });
    doc.x = MARGIN;
    doc.y = y + height + 12;
  };

  /** A heading that says which screen the cards below it belong to. */
  const printGroup = (name: string, count: number): void => {
    ensure(90);
    const y = doc.y;
    const label = prep(name === '' ? '(no screen)' : name, 'bold');
    const labelWidth = width - 74 - 90;
    const height = Math.max(22, measure(label, 'bold', 11, labelWidth) + 12);
    doc.rect(MARGIN, y, width, height).fill(COLOR.paleBlue);
    doc.rect(MARGIN, y, 4, height).fill(COLOR.blue);
    drawAt(prep('SCREEN', 'bold'), 'bold', 7, COLOR.blue, MARGIN + 14, y + 8, { width: 56 });
    drawAt(label, 'bold', 11, COLOR.navy, MARGIN + 74, y + 6, { width: labelWidth });
    const total = prep(`${count} component${count === 1 ? '' : 's'}`, 'regular');
    drawAt(total, 'regular', 8, COLOR.muted, MARGIN + width - 80, y + 8, { width: 70, align: 'right' });
    doc.x = MARGIN;
    doc.y = y + height + 8;
  };

  /** One record: a title bar (with its badge), a grey line of facts and the labelled texts. */
  const printRecord = (section: ContentSection, style: RecordStyle, row: CellValue[], nested: boolean): void => {
    const indent = nested ? 12 : 0;
    const left = MARGIN + indent;
    const inner = width - indent;
    const used = new Set<number>([style.title, ...(style.meta ?? [])]);
    if (style.badge !== undefined) used.add(style.badge);
    if (style.group !== undefined) used.add(style.group);

    const title = prep(textOf(row[style.title] ?? null) || '(no name)', 'bold');
    const badgeText = style.badge === undefined ? '' : textOf(row[style.badge] ?? null);
    const badge = badgeText === '' ? '' : prep(badgeText.replace(/_/g, ' '), 'bold');
    let badgeWidth = 0;
    if (badge !== '') {
      doc.font(NAMES.bold).fontSize(7);
      badgeWidth = doc.widthOfString(badge) + 14;
    }
    const titleWidth = inner - 24 - (badgeWidth === 0 ? 0 : badgeWidth + 10);
    const barHeight = Math.max(24, measure(title, 'bold', 11, titleWidth) + 14);

    ensure(barHeight + 60);
    const y = doc.y;
    doc.rect(left, y, inner, barHeight).fill(nested ? COLOR.zebra : COLOR.band);
    doc.rect(left, y, 3, barHeight).fill(nested ? COLOR.line : COLOR.blue);
    drawAt(title, 'bold', 11, COLOR.navy, left + 12, y + 7, { width: titleWidth });
    if (badge !== '') {
      const badgeX = left + inner - badgeWidth - 8;
      const badgeY = y + (barHeight - 14) / 2;
      doc.roundedRect(badgeX, badgeY, badgeWidth, 14, 7).fill(STATUS_COLOR[badgeText] ?? COLOR.neutral);
      drawAt(badge, 'bold', 7, COLOR.white, badgeX, badgeY + 4, { width: badgeWidth, align: 'center' });
    }
    doc.x = left;
    doc.y = y + barHeight + 5;

    const facts = (style.meta ?? [])
      .map((index) => [section.columns[index]?.header ?? '', textOf(row[index] ?? null)] as const)
      .filter(([, value]) => value !== '')
      .map(([header, value]) => `${header}: ${value}`);
    if (facts.length > 0) {
      flow(prep(facts.join('     |     '), 'regular'), 'regular', 8, COLOR.muted, left + 4, inner - 4, 4);
    }

    section.columns.forEach((column, index) => {
      if (used.has(index)) return;
      const value = textOf(row[index] ?? null);
      if (value === '') return;
      ensure(40);
      flow(prep(column.header.toUpperCase(), 'bold'), 'bold', 7, COLOR.blue, left + 4, inner - 4);
      const font: FontName = column.mono === true ? 'mono' : 'regular';
      flow(prep(value, font), font, 9, COLOR.text, left + 4, inner - 4, 5);
    });
    doc.x = MARGIN;
    doc.y += 8;
  };

  /** A part of short values as a table with a header row and alternating rows. */
  const printTable = (section: ContentSection): void => {
    // A narrow column keeps room for its header.
    const weights = section.columns.map((column) => Math.max(column.width, 16));
    const total = weights.reduce((sum, weight) => sum + weight, 0);
    const widths = weights.map((weight) => (weight / total) * width);
    const pad = 5;
    const firstBold = section.columns.length === 2;
    const fontOf = (index: number): FontName => (index === 0 && firstBold ? 'bold' : 'regular');

    const header = (): void => {
      ensure(60);
      const y = doc.y;
      doc.rect(MARGIN, y, width, 20).fill(COLOR.paleBlue);
      let x = MARGIN;
      section.columns.forEach((column, index) => {
        drawAt(prep(column.header.toUpperCase(), 'bold'), 'bold', 7, COLOR.navy, x + pad, y + 7, {
          width: widths[index]! - pad * 2,
          height: 9,
          ellipsis: true,
        });
        x += widths[index]!;
      });
      doc.x = MARGIN;
      doc.y = y + 20;
    };
    header();

    section.rows.forEach((row, rowIndex) => {
      const cells = section.columns.map((_, index) => prep(textOf(row[index] ?? null), fontOf(index)));
      const height =
        Math.max(...cells.map((cell, index) => measure(cell, fontOf(index), 8, widths[index]! - pad * 2))) + pad * 2;
      if (doc.y + height > bottomLimit()) {
        doc.addPage();
        header();
      }
      const y = doc.y;
      if (rowIndex % 2 === 1) doc.rect(MARGIN, y, width, height).fill(COLOR.zebra);
      doc.rect(MARGIN, y + height - 0.5, width, 0.5).fill(COLOR.line);
      let x = MARGIN;
      cells.forEach((cell, index) => {
        drawAt(cell, fontOf(index), 8, COLOR.text, x + pad, y + pad, { width: widths[index]! - pad * 2 });
        x += widths[index]!;
      });
      doc.x = MARGIN;
      doc.y = y + height;
    });
    doc.y += 6;
  };

  /** The Dependencies part: too many columns for a table, so each edge is a line "source -> target" and its details. */
  const printEdges = (section: ContentSection): void => {
    const badgeWidth = 74;
    const textWidth = width - badgeWidth - 18;
    ensure(40);
    section.rows.forEach((row, rowIndex) => {
      const cell = (index: number): string => textOf(row[index] ?? null);
      const main = prep(`${cell(2)} (${cell(1)})   ->   ${cell(4)} (${cell(3)})`, 'bold');
      const details = (
        [
          ['Access mode', cell(5)],
          ['Used in', cell(6)],
          ['Assignment function', cell(7)],
        ] as const
      )
        .filter(([, value]) => value !== '')
        .map(([name, value]) => `${name}: ${value}`)
        .join('     |     ');
      const detailText = details === '' ? '' : prep(details, 'regular');
      const mainHeight = measure(main, 'bold', 8.5, textWidth);
      const detailHeight = detailText === '' ? 0 : measure(detailText, 'regular', 7.5, textWidth) + 3;
      const height = mainHeight + detailHeight + 12;
      if (doc.y + height > bottomLimit()) doc.addPage();
      const y = doc.y;
      if (rowIndex % 2 === 1) doc.rect(MARGIN, y, width, height).fill(COLOR.zebra);
      doc.rect(MARGIN, y + height - 0.5, width, 0.5).fill(COLOR.line);
      doc.roundedRect(MARGIN + 6, y + 6, badgeWidth, 14, 3).fill(COLOR.navy);
      drawAt(prep(cell(0), 'bold'), 'bold', 6.5, COLOR.white, MARGIN + 6, y + 10, {
        width: badgeWidth,
        align: 'center',
      });
      drawAt(main, 'bold', 8.5, COLOR.text, MARGIN + badgeWidth + 14, y + 6, { width: textWidth });
      if (detailText !== '') {
        drawAt(detailText, 'regular', 7.5, COLOR.muted, MARGIN + badgeWidth + 14, y + 6 + mainHeight + 3, {
          width: textWidth,
        });
      }
      doc.x = MARGIN;
      doc.y = y + height;
    });
    doc.y += 6;
  };

  async function printSection(section: ContentSection, index: number): Promise<void> {
    printBand(section, index);
    if (section.rows.length === 0) {
      flow(prep('No rows.', 'regular'), 'regular', 9, COLOR.muted, MARGIN, width, 6);
    } else if (section.layout === 'lines') {
      if (section.name === 'Dependencies') printEdges(section);
      else printTable(section);
    } else {
      const style = RECORD_STYLES[section.name] ?? DEFAULT_STYLE;
      const groupSizes = new Map<string, number>();
      if (style.group !== undefined) {
        for (const row of section.rows) {
          const key = textOf(row[style.group] ?? null);
          groupSizes.set(key, (groupSizes.get(key) ?? 0) + 1);
        }
      }
      let currentGroup: string | undefined;
      for (const row of section.rows) {
        if (style.group !== undefined) {
          const key = textOf(row[style.group] ?? null);
          if (key !== currentGroup) {
            currentGroup = key;
            printGroup(key, groupSizes.get(key) ?? 0);
          }
        }
        printRecord(section, style, row, style.group !== undefined);
        await turn();
      }
    }
    doc.moveDown(0.6);
    await context.checkpoint();
    await yieldToEventLoop();
  }

  // The first page exists already (the cover): decorate it, then draw the cover and the parts.
  decoratePage();
  printCover();
  for (const [index, section] of content.sections.entries()) {
    await printSection(section, index);
  }

  doc.end();
  await finished;
  const buffer = Buffer.concat(chunks);
  if (buffer.length > context.maxBytes) throw new ReportTooLargeError('bytes');
  return { buffer, mimeType: PDF_MIME, replacedCharacters: replaced };
}

/** Text for a property of the PDF: no control characters, at most 200 characters. */
function clean(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 200);
}
