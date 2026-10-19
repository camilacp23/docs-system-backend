/**
 * Identifier helpers. Ids are PostgreSQL `integer` (SDD Table 44): a larger number cannot exist, so it is answered
 * as 404 NOT_FOUND without reaching Prisma (D-62). A non-numeric id is a 400 produced by the request validator.
 *
 * @module http/ids
 */
import { E } from '../security/errors.js';

/** Largest value of a PostgreSQL integer. */
export const INT32_MAX = 2_147_483_647;

/** Singular noun of each resource, by the first segment of its contract path. */
const RESOURCE_ELEMENT: Readonly<Record<string, string>> = {
  users: 'user',
  applications: 'application',
  variables: 'variable',
  collections: 'collection',
  screens: 'screen',
  comments: 'comment',
  reports: 'report',
  dependencies: 'element',
};

/**
 * Noun of the resource an operation works on, for NOT_FOUND messages.
 *
 * @param contractPath - Path of the operation in the contract (for example `/screens/{id}/status`).
 * @returns The singular noun (`resource` when the path is unknown).
 */
export function elementOfPath(contractPath: string | undefined): string {
  const first = (contractPath ?? '').split('/')[1] ?? '';
  return RESOURCE_ELEMENT[first] ?? 'resource';
}

/**
 * Throws 404 NOT_FOUND when `value` is a whole number that cannot be a stored id.
 * Services call it for ids that arrive in the body or the query (path ids are checked by the router).
 *
 * @param value - Candidate id (already validated as a positive integer by the contract).
 * @param element - Noun for the message.
 * @throws {ApiError} 404 NOT_FOUND.
 */
export function assertIdInRange(value: number | string, element: string): void {
  const n = Number(value);
  if (Number.isInteger(n) && n > INT32_MAX) throw E.notFound(element, String(value));
}
