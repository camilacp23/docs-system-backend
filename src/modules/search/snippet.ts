/**
 * The snippet of a search result (FR-17; D-105 e): plain text of at most 300 characters around the first match, with
 * an ellipsis where the text was cut. The 300 include the ellipses, because the contract declares `maxLength: 300`.
 *
 * It is computed on the original text. The position of the match comes from the normalization of `./text.ts`, which
 * keeps the length, so a position in the normalized text is the same position in the original.
 *
 * @module modules/search/snippet
 */
import { normalizeText } from './text.js';

/** Longest snippet, ellipses included. */
export const SNIPPET_MAX_LENGTH = 300;

const ELLIPSIS = '…';

const isHighSurrogate = (unit: string): boolean => unit >= '\uD800' && unit <= '\uDBFF';
const isLowSurrogate = (unit: string): boolean => unit >= '\uDC00' && unit <= '\uDFFF';

/**
 * Builds the snippet of `text` around the first occurrence of `normalizedQuery`.
 *
 * A text of 300 characters or fewer is returned whole. Otherwise the window is centered on the match; the side that
 * reaches the start or the end of the text carries no ellipsis and gives its room to the text. A window edge that
 * would split a surrogate pair (an emoji) or a `\r\n` is moved inward, so the pair is left out whole.
 *
 * @param text - The original text where the query was found.
 * @param normalizedQuery - The trimmed query, already normalized (at most 100 characters).
 */
export function buildSnippet(text: string, normalizedQuery: string): string {
  if (text.length <= SNIPPET_MAX_LENGTH) return text;
  const found = normalizeText(text).indexOf(normalizedQuery);
  const position = found < 0 ? 0 : found; // PostgreSQL found it, so this is only a guard
  const room = SNIPPET_MAX_LENGTH - 2; // content when both ends are cut
  let start = Math.max(0, Math.min(position - Math.floor((room - normalizedQuery.length) / 2), text.length - room));
  let end = start + room;
  if (start === 0) end = SNIPPET_MAX_LENGTH - 1;
  else if (end === text.length) start = text.length - (SNIPPET_MAX_LENGTH - 1);

  if (start > 0 && (isLowSurrogate(text[start]!) || (text[start] === '\n' && text[start - 1] === '\r'))) start += 1;
  if (end < text.length && (isHighSurrogate(text[end - 1]!) || (text[end - 1] === '\r' && text[end] === '\n'))) {
    end -= 1;
  }
  return `${start > 0 ? ELLIPSIS : ''}${text.slice(start, end)}${end < text.length ? ELLIPSIS : ''}`;
}
