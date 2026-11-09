/**
 * Helpers of the search tests: calls to `GET /search`, the shape of the responses, and fixtures for the text columns
 * and collection fields that the generic fixtures do not set. Everything runs on the disposable database of
 * `startTestApp`.
 */
import assert from 'node:assert/strict';
import { assertConformsToContract } from './contractResponse.js';
import type { TestApp } from './app.js';
import type { FixtureContext } from './fixtures.js';
import { asUser } from './users.js';

/** A result as the API returns it; the tests read a few keys. */
export type ResultBody = {
  type: 'SCREEN' | 'VARIABLE' | 'COLLECTION' | 'COMPONENT';
  id: number;
  name: string;
  matchedIn: string | null;
  snippet: string | null;
} & Record<string, unknown>;

/** The page envelope of a successful search. */
export type SearchBody = { data: ResultBody[]; page: number; pageSize: number; total: number };

/** Typed view of a search response. */
export const searchBodyOf = (res: { body: unknown }): SearchBody => res.body as SearchBody;

/** The query string of a search; values are encoded as UTF-8. */
export function searchUrl(params: Record<string, string | number | undefined>): string {
  const query = Object.entries(params)
    .filter((entry): entry is [string, string | number] => entry[1] !== undefined)
    .map(([key, value]) => `${key}=${encodeURIComponent(String(value))}`)
    .join('&');
  return `/search?${query}`;
}

/** `GET /search` as `token`. */
export function search(t: TestApp, params: Record<string, string | number | undefined>, token = t.users.admin.token) {
  return asUser(t, token).get(searchUrl(params));
}

/** `GET /search` that must answer 200 and conform to the contract (every variant). */
export async function searchOk(
  t: TestApp,
  params: Record<string, string | number | undefined>,
  token = t.users.admin.token,
): Promise<SearchBody> {
  const res = await search(t, params, token);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  await assertConformsToContract(res);
  return searchBodyOf(res);
}

/** `type:id` of each result, in the order of the page. */
export const keysOf = (body: SearchBody): string[] => body.data.map((r) => `${r.type}:${r.id}`);

/** `type:id` of an element. */
export const keyOf = (type: ResultBody['type'], id: number): string => `${type}:${id}`;

/** The names of the results, in the order of the page. */
export const namesOf = (body: SearchBody): string[] => body.data.map((r) => r.name);

/** Sets text columns of a subtype row directly in the database (the fixtures do not set them). */
export async function setColumns(
  t: FixtureContext,
  table: 'screen' | 'variable' | 'collection' | 'component',
  id: number,
  values: Record<string, string | null>,
): Promise<void> {
  const columns = Object.keys(values);
  const assignments = columns.map((column, i) => `${column} = $${i + 2}`).join(', ');
  await t.owner.query(`UPDATE ${table} SET ${assignments} WHERE id = $1`, [id, ...Object.values(values)]);
}

/** Adds a field to a collection and returns its id. */
export async function insertCollectionField(
  t: FixtureContext,
  collectionId: number,
  name: string,
  position: number,
): Promise<number> {
  const r = await t.owner.query<{ id: number }>(
    `INSERT INTO collection_field (collection_id, name, data_type, position) VALUES ($1, $2, 'TEXT', $3) RETURNING id`,
    [collectionId, name, position],
  );
  return r.rows[0]!.id;
}
