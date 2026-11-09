/**
 * How the search compares text (FR-17; D-105 a). One definition, two uses: the list of character pairs below builds
 * the TypeScript function `normalizeText` and the `translate()` that PostgreSQL runs, so both sides cannot drift.
 *
 * The map is fixed and one to one, and it does not depend on the locale of the database or of the runtime: `A-Z`
 * become `a-z`, `Ñ` becomes `ñ`, and the vowels with an acute accent or a diaeresis (`á é í ó ú ü`, in both cases)
 * become their plain lowercase vowel. `ñ` stays different from `n`. Every other character, including the letters of
 * other alphabets, is compared as it is. A mapped character is one UTF-16 unit before and after, so the text keeps
 * its length and a position found in the normalized text is the position in the original (the snippet needs that).
 *
 * @module modules/search/text
 */
import { Prisma } from '../../generated/prisma/client.js';
import { escapeLike } from '../../http/like.js';

const UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const LOWER = 'abcdefghijklmnopqrstuvwxyz';

/** The pairs `[from, to]` of the map, in the order they are written. The only definition of the normalization. */
export const NORMALIZATION_PAIRS: readonly (readonly [string, string])[] = [
  ...[...UPPER].map((c, i): [string, string] => [c, LOWER[i]!]),
  ['Ñ', 'ñ'],
  ['á', 'a'],
  ['é', 'e'],
  ['í', 'i'],
  ['ó', 'o'],
  ['ú', 'u'],
  ['ü', 'u'],
  ['Á', 'a'],
  ['É', 'e'],
  ['Í', 'i'],
  ['Ó', 'o'],
  ['Ú', 'u'],
  ['Ü', 'u'],
];

/** The characters to replace, for the `from` argument of `translate()`. */
export const SQL_FROM = NORMALIZATION_PAIRS.map(([from]) => from).join('');
/** Their replacements, for the `to` argument of `translate()`. */
export const SQL_TO = NORMALIZATION_PAIRS.map(([, to]) => to).join('');

const MAP: ReadonlyMap<string, string> = new Map(NORMALIZATION_PAIRS);

/**
 * Normalizes a text for comparison, one UTF-16 unit at a time. The result has the length of the original.
 *
 * @param text - Any text.
 */
export function normalizeText(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i += 1) {
    const unit = text[i]!;
    out += MAP.get(unit) ?? unit;
  }
  return out;
}

/**
 * The SQL expression that normalizes a column or an expression exactly like `normalizeText`. The map travels as two
 * bound parameters.
 *
 * @param expression - SQL of the text to normalize (a constant fragment written in the module, never user input).
 */
export function normalizedSql(expression: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`translate(${expression}, ${SQL_FROM}::text, ${SQL_TO}::text)`;
}

/**
 * The LIKE pattern (to use with `ESCAPE '\'`) that finds `normalizedQuery` anywhere in a normalized text. `%`, `_` and
 * `\` in the query are escaped, so they are ordinary characters (D-105 a).
 *
 * @param normalizedQuery - The trimmed query, already normalized.
 */
export const containsPattern = (normalizedQuery: string): string => `%${escapeLike(normalizedQuery)}%`;
