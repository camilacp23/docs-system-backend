/**
 * Queries of the advanced search (Module 6: FR-17, FR-18; SDD Table 6). Read only: nothing here writes.
 *
 * One read is one snapshot: the application check, the page and, when needed, the total run in a `REPEATABLE READ`
 * transaction opened `READ ONLY`, one statement after the other on the connection of the transaction (never in
 * parallel). The page carries the total in the same statement (`count(*) OVER ()`), so both come from the same scan:
 * about twice as fast as counting and paging separately, which the performance test measures. Only a page beyond the
 * end has no row to carry the total, and then a second statement counts, in the same snapshot, so it still agrees.
 *
 * The result set is built in SQL, once per statement, from constant fragments; every value (the application, the
 * filters, the regular expression of the normalized query, the page) is a bound parameter:
 *
 * 1. `base`: the elements of the selected types that pass the filters of their type (D-105 b).
 * 2. `hits`: one row per element and field that contains the text, with a `rank` (the priority of `matchedIn`), a
 *    tie-break inside that rank and the original text (`src`) for the snippet.
 * 3. `matched`: one row per element, with the best hit (`DISTINCT ON`, lowest rank), so an element is never repeated.
 * 4. The order is `exact name match first (only with a text)`, the normalized name by code point (`COLLATE "C"`, so it
 *    does not depend on the collation of the database), the type and the id. The page is `LIMIT/OFFSET` on that.
 *
 * The text is compared with the regular expression of `matchPattern` (the `~` operator), one class of characters per
 * character of the query, which equals normalizing both sides but does not rewrite the long texts (translate() over about
 * 17 MB of templates took 3 to 8 s; the expression takes about 0.16 s). No index supports the text search (D-22); at
 * department scale a sequential scan answers in milliseconds, and the performance test measures it.
 *
 * @module modules/search/repository
 */
import { Prisma } from '../../generated/prisma/client.js';
import type { Database } from '../../db/prisma.js';
import { matchPattern, normalizedSql } from './text.js';

/** The four types of element that can be found. */
export type ElementType = 'SCREEN' | 'VARIABLE' | 'COLLECTION' | 'COMPONENT';

/** The search, validated by the service. `query` is the trimmed and NORMALIZED text, if there is one. */
export type SearchFilters = {
  applicationId: number;
  query?: string | undefined;
  types: readonly ElementType[];
  environment?: string | undefined;
  documentationStatus?: string | undefined;
  scope?: string | undefined;
};

/** A row of the page, before it becomes a variant of the contract. */
export type SearchRow = {
  type: ElementType;
  id: number;
  name: string;
  /** Priority of `matchedIn` (1 `name` ... 8 `usedIn`); null without a text. */
  rank: number | null;
  /** The original text where the query was found (null for `name` and without a text). */
  src: string | null;
  documentationStatus: string | null;
  /** Elements that match (`count(*) OVER ()`), the same in every row of the page. */
  total?: bigint;
  screenId: number | null;
  screenName: string | null;
  environments: string[] | null;
};

/** A page and the number of elements that match; `null` when the application does not exist. */
export type SearchPage = { rows: SearchRow[]; total: number } | null;

/** Hooks of the repository; production passes none. */
export type SearchHooks = {
  /**
   * Runs inside the snapshot, after the page was read and before the total is counted. That second statement exists
   * only for a page beyond the end, so the hook runs only then (tests only).
   */
  afterPage?: () => Promise<void>;
};

/** The reads of the search. */
export type SearchRepository = {
  /** The total and the page of the elements that match, in one snapshot. */
  readPage(filters: SearchFilters, skip: number, take: number): Promise<SearchPage>;
};

type Tx = Prisma.TransactionClient;

const sql = Prisma.sql;
/** `normalizedSql` of a constant fragment. */
const normalized = (expression: string): Prisma.Sql => normalizedSql(Prisma.raw(expression));

/** The elements of the selected types, with the filters that apply to each type (D-105 b). */
function baseOf(f: SearchFilters): Prisma.Sql {
  const environment = (alias: string): Prisma.Sql =>
    f.environment === undefined
      ? Prisma.empty
      : sql` AND EXISTS (SELECT 1 FROM element_environment ee WHERE ee.element_id = ${Prisma.raw(alias)}.id AND ee.environment = ${f.environment}::environment)`;
  const parts: Prisma.Sql[] = [];
  if (f.types.includes('SCREEN')) {
    const status =
      f.documentationStatus === undefined
        ? Prisma.empty
        : sql` AND s.documentation_status = ${f.documentationStatus}::documentation_status`;
    parts.push(
      sql`SELECT 'SCREEN'::text AS type, 1 AS type_order, s.id, s.name FROM screen s WHERE s.application_id = ${f.applicationId}${status}`,
    );
  }
  if (f.types.includes('VARIABLE')) {
    const scope = f.scope === undefined ? Prisma.empty : sql` AND v.scope = ${f.scope}::variable_scope`;
    parts.push(
      sql`SELECT 'VARIABLE'::text AS type, 2 AS type_order, v.id, v.name FROM variable v WHERE v.application_id = ${f.applicationId}${scope}${environment('v')}`,
    );
  }
  if (f.types.includes('COLLECTION')) {
    parts.push(
      sql`SELECT 'COLLECTION'::text AS type, 3 AS type_order, c.id, c.name FROM collection c WHERE c.application_id = ${f.applicationId}${environment('c')}`,
    );
  }
  if (f.types.includes('COMPONENT')) {
    parts.push(
      sql`SELECT 'COMPONENT'::text AS type, 4 AS type_order, m.id, m.name FROM component m WHERE m.application_id = ${f.applicationId}`,
    );
  }
  return Prisma.join(parts, ' UNION ALL ');
}

/**
 * The rows that say where the text was found: `(type, id, rank, s1, s2, src)`. `rank` is the priority of `matchedIn`;
 * `s1`, `s2` choose among several hits of the same rank (D-105 d, D-109, D-110):
 * the first template field in the order of the table; the first field of a collection by position and id; and for
 * `usedIn` first the links of a screen (the lowest id) and only then the assignments of `variable_collection`.
 */
function hitsOf(f: SearchFilters, pattern: string): Prisma.Sql {
  const like = (expression: string): Prisma.Sql => sql`${Prisma.raw(expression)} ~ ${pattern}`;
  const has = (type: ElementType): boolean => f.types.includes(type);
  const parts: Prisma.Sql[] = [
    sql`SELECT b.type, b.id, 1 AS rank, 0 AS s1, 0 AS s2, NULL::text AS src FROM base b WHERE ${like('b.name')}`,
  ];
  if (has('SCREEN')) {
    parts.push(sql`SELECT 'SCREEN'::text, s.id, 3, t.ord, 0, t.txt
      FROM screen s JOIN base b ON b.type = 'SCREEN' AND b.id = s.id
      CROSS JOIN LATERAL (VALUES (1, s.on_start), (2, s.working_process), (3, s.architecture), (4, s.data_model),
                                 (5, s.requirements), (6, s.known_issues), (7, s.risks)) AS t(ord, txt)
      WHERE ${like('t.txt')}`);
  }
  if (has('VARIABLE')) {
    parts.push(
      sql`SELECT 'VARIABLE'::text, v.id, 2, 0, 0, v.description
        FROM variable v JOIN base b ON b.type = 'VARIABLE' AND b.id = v.id WHERE ${like('v.description')}`,
      sql`SELECT 'VARIABLE'::text, l.variable_id, 8, 0, l.id, l.used_in
        FROM screen_variable l JOIN base b ON b.type = 'VARIABLE' AND b.id = l.variable_id
        WHERE l.used_in <> 'origin' AND ${like('l.used_in')}`,
      sql`SELECT 'VARIABLE'::text, l.variable_id, 8, 1, l.id, l.used_in
        FROM variable_collection l JOIN base b ON b.type = 'VARIABLE' AND b.id = l.variable_id WHERE ${like('l.used_in')}`,
    );
  }
  if (has('COLLECTION')) {
    parts.push(
      sql`SELECT 'COLLECTION'::text, c.id, 2, 0, 0, c.description
        FROM collection c JOIN base b ON b.type = 'COLLECTION' AND b.id = c.id WHERE ${like('c.description')}`,
      sql`SELECT 'COLLECTION'::text, c.id, 4, 0, 0, c.creation_condition
        FROM collection c JOIN base b ON b.type = 'COLLECTION' AND b.id = c.id WHERE ${like('c.creation_condition')}`,
      sql`SELECT 'COLLECTION'::text, f.collection_id, 5, f.position, f.id, f.name
        FROM collection_field f JOIN base b ON b.type = 'COLLECTION' AND b.id = f.collection_id WHERE ${like('f.name')}`,
      sql`SELECT 'COLLECTION'::text, l.collection_id, 8, 0, l.id, l.used_in
        FROM screen_collection l JOIN base b ON b.type = 'COLLECTION' AND b.id = l.collection_id WHERE ${like('l.used_in')}`,
      sql`SELECT 'COLLECTION'::text, l.collection_id, 8, 1, l.id, l.used_in
        FROM variable_collection l JOIN base b ON b.type = 'COLLECTION' AND b.id = l.collection_id WHERE ${like('l.used_in')}`,
    );
  }
  if (has('COMPONENT')) {
    parts.push(
      sql`SELECT 'COMPONENT'::text, m.id, 2, 0, 0, m.description
        FROM component m JOIN base b ON b.type = 'COMPONENT' AND b.id = m.id WHERE ${like('m.description')}`,
      sql`SELECT 'COMPONENT'::text, m.id, 6, 0, 0, m.on_select
        FROM component m JOIN base b ON b.type = 'COMPONENT' AND b.id = m.id WHERE ${like('m.on_select')}`,
      sql`SELECT 'COMPONENT'::text, m.id, 7, 0, 0, m.type
        FROM component m JOIN base b ON b.type = 'COMPONENT' AND b.id = m.id WHERE ${like('m.type')}`,
    );
  }
  return Prisma.join(parts, ' UNION ALL ');
}

/** The common table expressions up to `matched`: one row per element that matches. */
function matchedOf(f: SearchFilters): Prisma.Sql {
  const base = sql`base AS (${baseOf(f)})`;
  if (f.query === undefined) {
    return sql`WITH ${base},
      matched AS (SELECT b.type, b.type_order, b.id, b.name, ${normalized('b.name')} AS name_key,
                         NULL::int AS rank, NULL::text AS src FROM base b)`;
  }
  return sql`WITH ${base},
    hits AS (${hitsOf(f, matchPattern(f.query))}),
    matched AS (
      SELECT b.type, b.type_order, b.id, b.name, ${normalized('b.name')} AS name_key,
             (${normalized('b.name')} = ${f.query}) AS is_exact, h.rank, h.src
        FROM base b
        JOIN (SELECT DISTINCT ON (type, id) type, id, rank, src
                FROM hits ORDER BY type, id, rank, s1, s2) h ON h.type = b.type AND h.id = b.id)`;
}

/**
 * The order (D-105 f): the exact name match first (only when there is a text; without one the term does not exist, so
 * no NULL enters the ORDER BY), then the normalized name by code point, the type and the id.
 */
function orderOf(prefix: '' | 'p.', hasQuery: boolean): Prisma.Sql {
  const p = Prisma.raw(prefix);
  const exact = hasQuery ? sql`${p}is_exact DESC, ` : Prisma.empty;
  return sql`${exact}${p}name_key COLLATE "C", ${p}type_order, ${p}id`;
}

/**
 * The statement that counts the elements that match. Exported so a test can ask PostgreSQL for its plan.
 *
 * @param filters - The search.
 */
export function countStatement(filters: SearchFilters): Prisma.Sql {
  return sql`${matchedOf(filters)} SELECT count(*) AS total FROM matched`;
}

/**
 * The statement that reads one page. Exported so a test can ask PostgreSQL for its plan.
 *
 * @param filters - The search.
 * @param skip - Elements to skip.
 * @param take - Elements in the page.
 * @param withTotal - Also return, in every row, the number of elements that match (`count(*) OVER ()`); `false` is for
 *   the performance test, which compares it with counting in a separate statement.
 */
export function pageStatement(filters: SearchFilters, skip: number, take: number, withTotal = true): Prisma.Sql {
  const hasQuery = filters.query !== undefined;
  const windowTotal = withTotal ? sql`, count(*) OVER () AS total` : Prisma.empty;
  const pageTotal = withTotal ? sql`, p.total` : Prisma.empty;
  return sql`${matchedOf(filters)},
    page AS (SELECT *${windowTotal} FROM matched ORDER BY ${orderOf('', hasQuery)} LIMIT ${take} OFFSET ${skip})
    SELECT p.type, p.id, p.name, p.rank, p.src${pageTotal},
           ss.documentation_status::text AS "documentationStatus",
           rs.id AS "screenId", rs.name AS "screenName",
           CASE WHEN p.type IN ('VARIABLE', 'COLLECTION') THEN
             (SELECT coalesce(array_agg(ee.environment::text ORDER BY ee.environment), ARRAY[]::text[])
                FROM element_environment ee WHERE ee.element_id = p.id) END AS environments
      FROM page p
      LEFT JOIN screen ss ON p.type = 'SCREEN' AND ss.id = p.id
      LEFT JOIN component c ON p.type = 'COMPONENT' AND c.id = p.id
      LEFT JOIN variable v ON p.type = 'VARIABLE' AND v.id = p.id
      LEFT JOIN screen rs ON rs.id = coalesce(c.screen_id, v.origin_screen_id)
     ORDER BY ${orderOf('p.', hasQuery)}`;
}

/**
 * Creates the repository.
 *
 * @param db - Database connected as docs_app (only the plain client is used).
 * @param hooks - Test hooks; omit in production.
 */
export function createSearchRepository(db: Pick<Database, 'base'>, hooks: SearchHooks = {}): SearchRepository {
  return {
    readPage: (filters, skip, take) =>
      db.base.$transaction(
        async (tx: Tx) => {
          await tx.$executeRaw`SET TRANSACTION READ ONLY`;
          const application = await tx.$queryRaw<{ found: number }[]>`
            SELECT 1 AS found FROM application WHERE id = ${filters.applicationId}`;
          if (application.length === 0) return null;
          const rows = await tx.$queryRaw<SearchRow[]>(pageStatement(filters, skip, take));
          if (rows.length > 0) return { rows, total: Number(rows[0]!.total ?? 0n) };
          // Nothing to carry the total: no element matches, or the page is beyond the end.
          if (skip === 0) return { rows, total: 0 };
          await hooks.afterPage?.();
          const counted = await tx.$queryRaw<{ total: bigint }[]>(countStatement(filters));
          return { rows, total: Number(counted[0]?.total ?? 0n) };
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
      ),
  };
}
