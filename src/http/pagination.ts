/**
 * Pagination, sorting and the collection envelope (SDD Table 44): `page` (default 1), `pageSize` (default 20,
 * maximum 100), `sort=field` / `sort=-field` over the whitelist that the contract declares per endpoint.
 *
 * @module http/pagination
 */
import type { Request } from 'express';
import { E } from '../security/errors.js';

export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;

export type PageParams = { page: number; pageSize: number; skip: number; take: number };
export type SortSpec = { field: string; direction: 'asc' | 'desc' };
export type Paged<T> = { data: T[]; page: number; pageSize: number; total: number };

const integerQuery = (value: unknown, name: string, min: number, max: number, fallback: number): number => {
  if (value === undefined) return fallback;
  const n = typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : NaN;
  if (!Number.isInteger(n) || n < min || n > max) {
    throw E.validation([{ field: name, rule: 'range', message: `Must be a whole number from ${min} to ${max}.` }]);
  }
  return n;
};

/**
 * Reads `page` and `pageSize` (the request validator already enforces the range; this guards direct use).
 *
 * @param query - `req.query`.
 * @returns Page numbers plus `skip` / `take` for Prisma.
 * @throws {ApiError} 400 VALIDATION_ERROR when out of range.
 */
export function parsePagination(query: Request['query']): PageParams {
  const page = integerQuery(query.page, 'page', 1, 1_000_000, 1);
  const pageSize = integerQuery(query.pageSize, 'pageSize', 1, MAX_PAGE_SIZE, DEFAULT_PAGE_SIZE);
  return { page, pageSize, skip: (page - 1) * pageSize, take: pageSize };
}

/**
 * Parses `sort` against a whitelist. `-field` is descending.
 *
 * @param raw - Value of `req.query.sort`.
 * @param allowed - Fields the contract allows (`req.policy.sort.allowed`).
 * @param fallback - Order used when `sort` is absent.
 * @returns The field and direction.
 * @throws {ApiError} 400 VALIDATION_ERROR when the field is not in the whitelist.
 */
export function parseSort(raw: unknown, allowed: readonly string[], fallback: SortSpec): SortSpec {
  if (raw === undefined) return fallback;
  const value = typeof raw === 'string' ? raw : '';
  const direction = value.startsWith('-') ? 'desc' : 'asc';
  const field = value.replace(/^-/, '');
  if (!allowed.includes(field)) {
    throw E.validation([{ field: 'sort', rule: 'enum', message: `Must be one of: ${allowed.join(', ')}.` }]);
  }
  return { field, direction };
}

/**
 * Builds the collection envelope.
 *
 * @param data - Items of the page.
 * @param params - Result of `parsePagination`.
 * @param total - Total rows matching the filters.
 * @returns `{ data, page, pageSize, total }`.
 */
export function paged<T>(data: T[], params: Pick<PageParams, 'page' | 'pageSize'>, total: number): Paged<T> {
  return { data, page: params.page, pageSize: params.pageSize, total };
}
