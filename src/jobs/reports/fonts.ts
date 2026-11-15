/**
 * The fonts embedded in the PDF reports (IBM Plex, SIL OFL 1.1; see `fonts/SOURCE.md`). The files sit next to this
 * module, in `src/jobs/reports/fonts/` and, after `npm run build`, in `dist/jobs/reports/fonts/`, so the same relative
 * URL finds them in both. Only the paths live here; the PDF generator loads them.
 *
 * @module jobs/reports/fonts
 */
import { fileURLToPath } from 'node:url';

/** The three font files, by the role they play in the PDF. */
export const FONT_FILES = {
  regular: 'IBMPlexSans-Regular.ttf',
  bold: 'IBMPlexSans-Bold.ttf',
  mono: 'IBMPlexMono-Regular.ttf',
} as const;

/** A role of {@link FONT_FILES}. */
export type FontRole = keyof typeof FONT_FILES;

/**
 * Absolute path of a font file.
 *
 * @param role - `regular` and `bold` (IBM Plex Sans) or `mono` (IBM Plex Mono).
 * @returns The path of the TrueType file, in `src/` or in `dist/` depending on where this module runs.
 */
export function fontPath(role: FontRole): string {
  return fileURLToPath(new URL(`./fonts/${FONT_FILES[role]}`, import.meta.url));
}
