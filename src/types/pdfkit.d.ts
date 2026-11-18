/**
 * The part of pdfkit 0.20.2 that the report generator uses. pdfkit ships no types and `@types/pdfkit` is not a
 * dependency of this project, so only what is called is declared here. `_font` is an internal property of pdfkit (the
 * font in use, a fontkit font); it is the only way to ask which characters a font can draw, and it is safe because the
 * version of pdfkit is pinned exactly. Extend this file when the generator needs more of the library.
 */
declare module 'pdfkit' {
  /** The fontkit font behind the font in use (only what the generator asks). */
  interface EmbeddedFont {
    hasGlyphForCodePoint(codePoint: number): boolean;
    readonly fullName: string;
  }

  /** The text options the generator uses. */
  interface TextOptions {
    width?: number;
    height?: number;
    lineGap?: number;
    paragraphGap?: number;
    align?: 'left' | 'center' | 'right';
    lineBreak?: boolean;
    ellipsis?: boolean;
    characterSpacing?: number;
  }

  /** A PDF document written to memory: listen to `data` and `end`, or use the `Buffer`s it emits. */
  class PDFDocument {
    constructor(options?: {
      autoFirstPage?: boolean;
      size?: string;
      margin?: number;
      margins?: { top: number; bottom: number; left: number; right: number };
      info?: Record<string, string | Date>;
    });
    x: number;
    y: number;
    readonly _font: { readonly font: EmbeddedFont };
    readonly page: {
      readonly width: number;
      readonly height: number;
      readonly margins: { top: number; bottom: number; left: number; right: number };
    };
    registerFont(name: string, source: string): this;
    font(source: string): this;
    fontSize(size: number): this;
    fillColor(color: string): this;
    strokeColor(color: string): this;
    lineWidth(width: number): this;
    rect(x: number, y: number, width: number, height: number): this;
    roundedRect(x: number, y: number, width: number, height: number, radius: number): this;
    moveTo(x: number, y: number): this;
    lineTo(x: number, y: number): this;
    fill(color?: string): this;
    stroke(color?: string): this;
    text(text: string, options?: TextOptions): this;
    text(text: string, x: number, y: number, options?: TextOptions): this;
    heightOfString(text: string, options?: TextOptions): number;
    widthOfString(text: string, options?: TextOptions): number;
    moveDown(lines?: number): this;
    addPage(): this;
    on(event: 'data', listener: (chunk: Buffer) => void): this;
    on(event: 'end' | 'pageAdded', listener: () => void): this;
    on(event: 'error', listener: (error: Error) => void): this;
    end(): void;
  }

  export default PDFDocument;
}
