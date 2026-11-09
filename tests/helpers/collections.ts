/**
 * Helpers of the collections tests: the contract's response shapes and typed readers of the responses.
 * Everything runs on the disposable database of `startTestApp`.
 */
import type { RefBody } from './variables.js';

/** A field as the API returns it. */
export type FieldBody = { id: number; name: string; dataType: string; description: string | null; position: number };

/** An assignment as the API returns it. */
export type AssignmentBody = {
  id: number;
  variable: RefBody;
  collection: RefBody;
  screen: RefBody;
  assignmentFunction: string;
  tableFunction: string | null;
  usedIn: string;
};

/** A collection as the listing returns it. */
export type CollectionSummaryBody = {
  id: number;
  applicationId: number;
  name: string;
  environments: string[];
  documented: boolean;
  fieldCount: number;
  createdAt: string;
  updatedAt: string;
};

/** A collection as GET, POST and PUT return it. */
export type CollectionBody = CollectionSummaryBody & {
  creationCondition: string | null;
  description: string | null;
  environmentDetails: { environment: string; notes: string | null }[];
  fields: FieldBody[];
  variableAssignments: AssignmentBody[];
  derivedFrom: RefBody[];
};

/** Typed view of a single-collection response. */
export const collectionOf = (res: { body: unknown }): CollectionBody => (res.body as { data: CollectionBody }).data;

/** Typed view of the collections page. */
export const collectionsPageOf = (res: { body: unknown }) =>
  res.body as { data: CollectionSummaryBody[]; page: number; pageSize: number; total: number };

/** Names of the collections of a page, in order. */
export const collectionNames = (res: { body: unknown }): string[] => collectionsPageOf(res).data.map((c) => c.name);

/** Typed view of a page of fields. */
export const fieldsPageOf = (res: { body: unknown }) =>
  res.body as { data: FieldBody[]; page: number; pageSize: number; total: number };

let counter = 0;

/** A unique valid collection name. */
export const uniqueCollectionName = (prefix = 'colTest'): string => `${prefix}${(counter += 1)}`;

/** A valid `POST /collections` body with optional overrides. */
export const createBodyOf = (applicationId: number, over: Record<string, unknown> = {}) => ({
  applicationId,
  name: uniqueCollectionName(),
  environments: [{ environment: 'DEV' }],
  ...over,
});

/** The body of a `PUT /collections/{id}` that changes nothing (ids included), with optional overrides. */
export const putBodyOf = (c: CollectionBody, over: Record<string, unknown> = {}) => ({
  name: c.name,
  creationCondition: c.creationCondition,
  description: c.description,
  environments: c.environmentDetails,
  fields: c.fields.map((f) => ({
    id: f.id,
    name: f.name,
    dataType: f.dataType,
    description: f.description,
    position: f.position,
  })),
  variableAssignments: c.variableAssignments.map((a) => ({
    id: a.id,
    variableId: a.variable.id,
    screenId: a.screen.id,
    assignmentFunction: a.assignmentFunction,
    tableFunction: a.tableFunction,
    usedIn: a.usedIn,
  })),
  derivedFrom: c.derivedFrom.map((d) => d.id),
  ...over,
});

/** A row of `audit_log` as the tests read it. */
export type AuditRow = { action: string; actor_user_id: number | null; changed_fields: string[] | null };

/** Audit rows of one entity (`entityId` may use LIKE wildcards), oldest first. */
export async function auditRows(
  t: { owner: { query: (sql: string, params: unknown[]) => Promise<{ rows: unknown[] }> } },
  entityType: string,
  entityId: string,
): Promise<AuditRow[]> {
  const r = await t.owner.query(
    `SELECT action, actor_user_id, changed_fields FROM audit_log
      WHERE entity_type = $1 AND entity_id LIKE $2 ORDER BY id`,
    [entityType, entityId],
  );
  return r.rows as AuditRow[];
}

/** Number of rows in `audit_log`. */
export async function auditCount(t: {
  owner: { query: (sql: string) => Promise<{ rows: unknown[] }> };
}): Promise<number> {
  const r = await t.owner.query('SELECT count(*) AS n FROM audit_log');
  return Number((r.rows[0] as { n: string }).n);
}
