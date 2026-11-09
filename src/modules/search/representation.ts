/**
 * The variants of a search result as the contract declares them (`SearchResult`, chosen by `type`): each variant
 * carries only its own fields, and the fields that do not apply are absent (D-105 g).
 *
 * @module modules/search/representation
 */
import { buildSnippet } from './snippet.js';
import type { SearchRow } from './repository.js';

/** Where the text was found, by priority: the first one that matches wins (D-105 d). The rank is the index plus 1. */
export const MATCHED_IN = [
  'name',
  'description',
  'template',
  'creationCondition',
  'fieldName',
  'onSelect',
  'type',
  'usedIn',
] as const;

/** A value of `matchedIn`. */
export type MatchedIn = (typeof MATCHED_IN)[number];

/** A compact reference to a screen. */
export type Ref = { id: number; name: string };

type Common = { id: number; name: string; matchedIn: MatchedIn | null; snippet: string | null };

/** One element found. */
export type SearchResult =
  | (Common & { type: 'SCREEN'; documentationStatus: string })
  | (Common & { type: 'VARIABLE'; screen: Ref | null; environments: string[] })
  | (Common & { type: 'COLLECTION'; environments: string[] })
  | (Common & { type: 'COMPONENT'; screen: Ref });

/**
 * Turns a row into its variant.
 *
 * @param row - A row of the page.
 * @param normalizedQuery - The trimmed and normalized text, or `undefined` without one.
 */
export function toSearchResult(row: SearchRow, normalizedQuery: string | undefined): SearchResult {
  const matchedIn = row.rank === null ? null : (MATCHED_IN[row.rank - 1] ?? null);
  // The name is already the result's label; without a text there is nothing to show around.
  const snippet =
    matchedIn === null || matchedIn === 'name' || row.src === null || normalizedQuery === undefined
      ? null
      : buildSnippet(row.src, normalizedQuery);
  const common: Common = { id: row.id, name: row.name, matchedIn, snippet };
  const screen: Ref | null = row.screenId === null ? null : { id: row.screenId, name: row.screenName ?? '' };
  switch (row.type) {
    case 'SCREEN':
      return { type: 'SCREEN', ...common, documentationStatus: row.documentationStatus ?? 'UNDOCUMENTED' };
    case 'VARIABLE':
      return { type: 'VARIABLE', ...common, screen, environments: row.environments ?? [] };
    case 'COLLECTION':
      return { type: 'COLLECTION', ...common, environments: row.environments ?? [] };
    case 'COMPONENT':
      if (screen === null) throw new Error(`component ${row.id} has no screen`);
      return { type: 'COMPONENT', ...common, screen };
  }
}
