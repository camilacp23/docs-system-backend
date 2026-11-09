/**
 * Text search helpers shared by the repositories.
 *
 * @module http/like
 */

/**
 * Escapes the LIKE wildcards of a user supplied text: Prisma's `contains` does not, so `q=%` would match every row.
 * PostgreSQL's default escape character is the backslash, so the result also works in raw `ILIKE`.
 *
 * @param text - Text typed by the user.
 * @returns The text with `\`, `%` and `_` escaped.
 */
export const escapeLike = (text: string): string => text.replace(/[\\%_]/g, (c) => `\\${c}`);
