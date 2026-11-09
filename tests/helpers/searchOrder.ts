/**
 * The order of the search results written a second time, in TypeScript, as an oracle for the tests (D-105 f): the
 * exact name match first (only with a text), then the normalized name by code point, the type and the id. The code
 * is deliberately independent of the SQL of the repository.
 */
import { normalizeText } from '../../src/modules/search/text.js';

const TYPE_ORDER: Record<string, number> = { SCREEN: 1, VARIABLE: 2, COLLECTION: 3, COMPONENT: 4 };

/**
 * Compares two texts by Unicode code point, the order of PostgreSQL's `COLLATE "C"` on UTF-8 (and not the order of
 * UTF-16 units, which differs for characters outside the Basic Multilingual Plane).
 */
export function compareCodePoints(a: string, b: string): number {
  const x = [...a];
  const y = [...b];
  for (let i = 0; i < Math.min(x.length, y.length); i += 1) {
    const diff = x[i]!.codePointAt(0)! - y[i]!.codePointAt(0)!;
    if (diff !== 0) return diff;
  }
  return x.length - y.length;
}

/** What the comparator needs of a result. */
export type Orderable = { type: string; id: number; name: string };

/**
 * The comparator of the results.
 *
 * @param query - The trimmed text of the search, or `undefined` when there is none (then no exact-match term exists).
 */
export function resultComparator(query: string | undefined): (a: Orderable, b: Orderable) => number {
  const needle = query === undefined ? undefined : normalizeText(query);
  return (a, b) => {
    const keyA = normalizeText(a.name);
    const keyB = normalizeText(b.name);
    if (needle !== undefined) {
      const exact = Number(keyB === needle) - Number(keyA === needle);
      if (exact !== 0) return exact;
    }
    return compareCodePoints(keyA, keyB) || (TYPE_ORDER[a.type] ?? 9) - (TYPE_ORDER[b.type] ?? 9) || a.id - b.id;
  };
}
