/**
 * How the search compares text (FR-17; D-105 a). One definition, three uses: the list of character pairs below builds
 * the TypeScript function `normalizeText`, the `translate()` that PostgreSQL runs on the (short) names, and the regular
 * expression that PostgreSQL runs on the (long) searched texts, so none of them can drift.
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

/** Characters written as they are in a pattern: they are not special in a regular expression, inside or outside `[]`. */
const PLAIN = /^[A-Za-z0-9 ]$/;

/**
 * One character of a pattern. A letter, a digit or a space is written as it is; any other character is written as a
 * hexadecimal escape (`\uXXXX`, or `\UXXXXXXXX` outside the Basic Multilingual Plane), which no regular expression
 * reads as anything but that character. So `. * + ? ( ) [ ] { } | ^ $ \ -`, line breaks and the rest are literal,
 * inside a class and outside it.
 */
function literal(character: string): string {
  if (PLAIN.test(character)) return character;
  const code = character.codePointAt(0)!;
  return code > 0xffff ? `\\U${code.toString(16).padStart(8, '0')}` : `\\u${code.toString(16).padStart(4, '0')}`;
}

/** Every character that normalizes to `target`: the target itself and the sources of the pairs that map to it. */
function classMembers(target: string): string[] {
  return [target, ...NORMALIZATION_PAIRS.filter(([, to]) => to === target).map(([from]) => from)];
}

/**
 * The regular expression (PostgreSQL ARE, for the `~` operator) that matches, anywhere in a text, exactly the texts
 * whose normalization contains `normalizedQuery`. Each character of the query becomes the class of the characters that
 * normalize to it (`i` becomes `[iIíÍ]`), generated from the same `NORMALIZATION_PAIRS` as `normalizeText`; a character
 * that no pair produces is its own literal. This is the comparison "normalize both sides" without normalizing the long
 * side, which is what makes it fast on large texts. Characters are read by code point.
 *
 * @param normalizedQuery - The trimmed query, already normalized.
 */
export function matchPattern(normalizedQuery: string): string {
  return [...normalizedQuery]
    .map((character) => {
      const members = classMembers(character);
      return members.length === 1 ? literal(character) : `[${members.map(literal).join('')}]`;
    })
    .join('');
}
