/**
 * Reads of the contents of a report (D-116): one function per part, all on the client of ONE transaction (the worker's
 * snapshot) and run one after the other, never in parallel. Every list is ordered by name compared by code point
 * (`COLLATE "C"`, as in the search, D-110) and then by `id`, unless the part has its own order, and is cut at `limit + 1`
 * rows so a huge application is never loaded whole: the caller turns one row more than the limit into "too large".
 *
 * Only plain SQL with bound parameters; nothing is concatenated.
 *
 * @module modules/reports/contentRepository
 */
import { Prisma } from '../../generated/prisma/client.js';
import type { ReportDocumentationStatus } from './scope.js';

/** The transaction client the reads run on. */
export type ContentClient = Pick<Prisma.TransactionClient, '$queryRaw'>;

/** The filters of the screens (and, through them, of the components). `undefined` = no filter. */
export type ScreenFilter = {
  screenIds?: readonly number[] | undefined;
  statuses?: readonly ReportDocumentationStatus[] | undefined;
};

export type ScreenRow = {
  id: number;
  name: string;
  status: string;
  author: string;
  updatedAt: Date;
  miroLink: string | null;
  onStart: string | null;
  workingProcess: string | null;
  architecture: string | null;
  dataModel: string | null;
  requirements: string | null;
  knownIssues: string | null;
  risks: string | null;
};
export type ComponentRow = {
  id: number;
  screen: string;
  name: string;
  type: string;
  description: string | null;
  onSelect: string | null;
};
export type VariableRow = {
  id: number;
  name: string;
  dataType: string;
  scope: string;
  originScreen: string | null;
  description: string | null;
  environments: string;
};
export type CollectionRow = {
  id: number;
  name: string;
  creationCondition: string | null;
  description: string | null;
  environments: string;
  linked: boolean;
};
export type CollectionFieldRow = {
  collection: string;
  position: number;
  name: string;
  dataType: string;
  description: string | null;
};

const screenConditions = (filter: ScreenFilter): Prisma.Sql =>
  Prisma.sql`${filter.screenIds === undefined ? Prisma.empty : Prisma.sql`AND s.id = ANY(${[...filter.screenIds]}::int[])`}
             ${filter.statuses === undefined ? Prisma.empty : Prisma.sql`AND s.documentation_status::text = ANY(${[...filter.statuses]}::text[])`}`;

/** The name of the application, or `null` when it does not exist. */
export async function readApplicationName(client: ContentClient, applicationId: number): Promise<string | null> {
  const rows = await client.$queryRaw<{ name: string }[]>`SELECT name FROM application WHERE id = ${applicationId}`;
  return rows[0]?.name ?? null;
}

/** How many of `screenIds` are screens of the application (a deleted one makes the count smaller). */
export async function countScreens(
  client: ContentClient,
  applicationId: number,
  screenIds: readonly number[],
): Promise<number> {
  const rows = await client.$queryRaw<{ n: number }[]>`
    SELECT count(*)::int AS n FROM screen WHERE application_id = ${applicationId} AND id = ANY(${[...screenIds]}::int[])`;
  return rows[0]?.n ?? 0;
}

/** The screens of the report. */
export function readScreens(client: ContentClient, applicationId: number, filter: ScreenFilter, limit: number) {
  return client.$queryRaw<ScreenRow[]>`
    SELECT s.id, s.name, s.documentation_status::text AS status, u.name AS author, s.updated_at AS "updatedAt",
           s.miro_link AS "miroLink", s.on_start AS "onStart", s.working_process AS "workingProcess", s.architecture,
           s.data_model AS "dataModel", s.requirements, s.known_issues AS "knownIssues", s.risks
      FROM screen s JOIN app_user u ON u.id = s.author_id
     WHERE s.application_id = ${applicationId} ${screenConditions(filter)}
     ORDER BY s.name COLLATE "C", s.id
     LIMIT ${limit}`;
}

/** The components of the screens of the report, ordered by screen, component and id. */
export function readComponents(client: ContentClient, applicationId: number, filter: ScreenFilter, limit: number) {
  return client.$queryRaw<ComponentRow[]>`
    SELECT c.id, s.name AS screen, c.name, c.type, c.description, c.on_select AS "onSelect"
      FROM component c JOIN screen s ON s.id = c.screen_id
     WHERE c.application_id = ${applicationId} ${screenConditions(filter)}
     ORDER BY s.name COLLATE "C", s.id, c.name COLLATE "C", c.id
     LIMIT ${limit}`;
}

/** The variables of the application, with their environments as `DEV, PROD`. */
export function readVariables(client: ContentClient, applicationId: number, limit: number) {
  return client.$queryRaw<VariableRow[]>`
    SELECT v.id, v.name, v.data_type::text AS "dataType", v.scope::text AS scope, o.name AS "originScreen", v.description,
           COALESCE((SELECT string_agg(ee.environment::text, ', ' ORDER BY ee.environment::text)
                       FROM element_environment ee WHERE ee.element_id = v.id), '') AS environments
      FROM variable v LEFT JOIN screen o ON o.id = v.origin_screen_id
     WHERE v.application_id = ${applicationId}
     ORDER BY v.name COLLATE "C", v.id
     LIMIT ${limit}`;
}

/** The collections of the application, with their environments and whether a screen is linked to them. */
export function readCollections(client: ContentClient, applicationId: number, limit: number) {
  return client.$queryRaw<CollectionRow[]>`
    SELECT c.id, c.name, c.creation_condition AS "creationCondition", c.description,
           COALESCE((SELECT string_agg(ee.environment::text, ', ' ORDER BY ee.environment::text)
                       FROM element_environment ee WHERE ee.element_id = c.id), '') AS environments,
           EXISTS (SELECT 1 FROM screen_collection sc WHERE sc.collection_id = c.id) AS linked
      FROM collection c
     WHERE c.application_id = ${applicationId}
     ORDER BY c.name COLLATE "C", c.id
     LIMIT ${limit}`;
}

/** The fields of the collections, ordered by collection name, collection id, position and field id. */
export function readCollectionFields(client: ContentClient, applicationId: number, limit: number) {
  return client.$queryRaw<CollectionFieldRow[]>`
    SELECT c.name AS collection, f.position::int AS position, f.name, f.data_type::text AS "dataType", f.description
      FROM collection_field f JOIN collection c ON c.id = f.collection_id
     WHERE c.application_id = ${applicationId}
     ORDER BY c.name COLLATE "C", c.id, f.position, f.id
     LIMIT ${limit}`;
}

/** The parts of a report that the size check counts (the same ones `buildReportContent` reads). */
export type SizedParts = {
  screens: boolean;
  components: boolean;
  variables: boolean;
  collections: boolean;
};

/** How many rows and how many characters of text the parts of a report hold. */
export type ReportSize = { rows: number; chars: number };

/**
 * The size of the report BEFORE its text is read: ONE statement that counts rows and adds up `char_length` of the text
 * columns of the parts that enter the report, with the same filters of the scope, on the same transaction and snapshot as
 * the reads that follow. It does not bring any text back. `Dependencies` is not counted here (its rows come from the
 * graph and are counted when they are known); the Summary is a few rows and is not counted.
 *
 * @param client - The transaction client of the report.
 * @param applicationId - The application.
 * @param filter - The filters of the screens (they apply to the components through their screen).
 * @param parts - Which parts are in the report.
 */
export async function readReportSize(
  client: ContentClient,
  applicationId: number,
  filter: ScreenFilter,
  parts: SizedParts,
): Promise<ReportSize> {
  const len = (column: string): Prisma.Sql => Prisma.raw(`COALESCE(char_length(${column}), 0)`);
  const none = Prisma.sql`SELECT 0::bigint AS rows, 0::bigint AS chars`;
  const screens = parts.screens
    ? Prisma.sql`SELECT count(*) AS rows,
                        COALESCE(sum(${len('s.name')} + ${len('s.miro_link')} + ${len('s.on_start')} + ${len('s.working_process')}
                                     + ${len('s.architecture')} + ${len('s.data_model')} + ${len('s.requirements')}
                                     + ${len('s.known_issues')} + ${len('s.risks')}), 0) AS chars
                   FROM screen s WHERE s.application_id = ${applicationId} ${screenConditions(filter)}`
    : none;
  const components = parts.components
    ? Prisma.sql`SELECT count(*) AS rows,
                        COALESCE(sum(${len('c.name')} + ${len('c.type')} + ${len('c.description')} + ${len('c.on_select')}), 0) AS chars
                   FROM component c JOIN screen s ON s.id = c.screen_id
                  WHERE c.application_id = ${applicationId} ${screenConditions(filter)}`
    : none;
  const variables = parts.variables
    ? Prisma.sql`SELECT count(*) AS rows, COALESCE(sum(${len('v.name')} + ${len('v.description')}), 0) AS chars
                   FROM variable v WHERE v.application_id = ${applicationId}`
    : none;
  const collections = parts.collections
    ? Prisma.sql`SELECT count(*) AS rows,
                        COALESCE(sum(${len('c.name')} + ${len('c.creation_condition')} + ${len('c.description')}), 0) AS chars
                   FROM collection c WHERE c.application_id = ${applicationId}`
    : none;
  const fields = parts.collections
    ? Prisma.sql`SELECT count(*) AS rows, COALESCE(sum(${len('f.name')} + ${len('f.description')}), 0) AS chars
                   FROM collection_field f JOIN collection c ON c.id = f.collection_id WHERE c.application_id = ${applicationId}`
    : none;
  const rows = await client.$queryRaw<{ rows: bigint; chars: bigint }[]>`
    SELECT (a.rows + b.rows + c.rows + d.rows + e.rows) AS rows, (a.chars + b.chars + c.chars + d.chars + e.chars) AS chars
      FROM (${screens}) a, (${components}) b, (${variables}) c, (${collections}) d, (${fields}) e`;
  return { rows: Number(rows[0]?.rows ?? 0n), chars: Number(rows[0]?.chars ?? 0n) };
}
