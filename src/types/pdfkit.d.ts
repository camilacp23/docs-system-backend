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

  /** A PDF document written to memory: listen to `data` and `end`, or use the `Buffer`s it emits. */
  class PDFDocument {
    constructor(options?: {
      autoFirstPage?: boolean;
      size?: string;
      margin?: number;
      info?: Record<string, string | Date>;
    });
    readonly _font: { readonly font: EmbeddedFont };
    readonly page: { readonly width: number; readonly margins: { readonly left: number; readonly right: number } };
    registerFont(name: string, source: string): this;
    font(source: string): this;
    fontSize(size: number): this;
    text(text: string, options?: { width?: number; lineGap?: number; paragraphGap?: number }): this;
    moveDown(lines?: number): this;
    addPage(): this;
    on(event: 'data', listener: (chunk: Buffer) => void): this;
    on(event: 'end', listener: () => void): this;
    on(event: 'error', listener: (error: Error) => void): this;
    end(): void;
  }

  export default PDFDocument;
}
