/**
 * Prisma queries of the collections module (Module 3: FR-08, FR-09; SDD Table 49). No rules live here (SDD Table 6,
 * D-42): the service decides, this only reads and writes.
 *
 * A collection is stored in `documented_element` (supertype), `collection` (subtype), `element_environment` (D-04),
 * `collection_field`, `variable_collection` (assignments, FR-09) and `dependency` (DERIVES_FROM, D-29). The API
 * returns them as one resource.
 *
 * @module modules/collections/repository
 */
import { replaceElementEnvironments, type EnvironmentInput } from '../../db/elementEnvironments.js';
import type {
  AssignmentFunction,
  DataType,
  Environment,
  Prisma,
  PrismaClient,
  VariableScope,
} from '../../generated/prisma/client.js';
import { escapeLike } from '../../http/like.js';

export type { EnvironmentInput };

/** Clients accepted by the queries: the plain client or the transaction client of `auditedTransaction`. */
export type CollectionsClient = Pick<
  PrismaClient,
  | 'collection'
  | 'collectionField'
  | 'variableCollection'
  | 'variable'
  | 'screen'
  | 'dependency'
  | 'documentedElement'
  | 'elementEnvironment'
  | '$queryRaw'
>;

/** Reference to another resource (contract schema `Ref`). */
export type Ref = { id: number; name: string };

/** Presence of a collection in one environment, with its notes (contract schema `EnvironmentPresence`). */
export type EnvironmentDetail = EnvironmentInput;

/** A field of a collection (contract schema `CollectionField`). */
export type FieldView = { id: number; name: string; dataType: DataType; description: string | null; position: number };

/** An assignment of a variable from a collection (contract schema `VariableAssignment`). */
export type AssignmentView = {
  id: number;
  variable: Ref;
  collection: Ref;
  screen: Ref;
  assignmentFunction: AssignmentFunction;
  tableFunction: string | null;
  usedIn: string;
};

/** A collection as the listing returns it (contract schema `CollectionSummary`). */
export type CollectionSummaryView = {
  id: number;
  applicationId: number;
  name: string;
  environments: Environment[];
  documented: boolean;
  fieldCount: number;
  createdAt: Date;
  updatedAt: Date;
};

/** A collection as `GET`, `POST` and `PUT` return it (contract schema `Collection`). */
export type CollectionView = CollectionSummaryView & {
  creationCondition: string | null;
  description: string | null;
  environmentDetails: EnvironmentDetail[];
  fields: FieldView[];
  variableAssignments: AssignmentView[];
  derivedFrom: Ref[];
};

/** Editable columns of a collection (contract schema `CollectionWrite`, without the nested arrays). */
export type CollectionData = { name: string; creationCondition: string | null; description: string | null };

/** A field to write. */
export type FieldData = { name: string; dataType: DataType; description: string | null; position: number };

/** An assignment to write; `variableScope` is the scope the database has for the variable (FK composite). */
export type AssignmentData = {
  variableId: number;
  variableScope: VariableScope;
  screenId: number;
  assignmentFunction: AssignmentFunction;
  tableFunction: string | null;
  usedIn: string;
};

/** Sortable fields of `GET /collections` (the whitelist is the contract's description of `sort`). */
export type CollectionSortField = 'name' | 'updatedAt';

/** Filters, order and page of `GET /collections`. `id` breaks ties so pagination is stable. */
export type CollectionListQuery = {
  applicationId: number;
  q?: string | undefined;
  environment?: Environment | undefined;
  undocumented?: boolean | undefined;
  sort: { field: CollectionSortField; direction: 'asc' | 'desc' };
  skip: number;
  take: number;
};

/** The columns of a collection that other rules need (existence, application, name). */
export type CollectionRef = { id: number; name: string; applicationId: number };

const SUMMARY_SELECT = {
  id: true,
  applicationId: true,
  name: true,
  createdAt: true,
  updatedAt: true,
  element: { select: { environments: { select: { environment: true }, orderBy: { environment: 'asc' } } } },
  _count: { select: { fields: true, screenLinks: true } },
} satisfies Prisma.CollectionSelect;

/**
 * The collection itself: its columns and the two counts (no relation is selected, so the statement is one). The
 * environments, fields, assignments and derivations are read apart (see `findCollectionById`).
 */
const HEAD_SELECT = {
  id: true,
  applicationId: true,
  name: true,
  createdAt: true,
  updatedAt: true,
  creationCondition: true,
  description: true,
  _count: { select: { fields: true, screenLinks: true } },
} satisfies Prisma.CollectionSelect;

type SummaryRow = Prisma.CollectionGetPayload<{ select: typeof SUMMARY_SELECT }>;
type HeadRow = Prisma.CollectionGetPayload<{ select: typeof HEAD_SELECT }>;

const toSummary = (row: SummaryRow): CollectionSummaryView => ({
  id: row.id,
  applicationId: row.applicationId,
  name: row.name,
  environments: row.element.environments.map((e) => e.environment),
  documented: row._count.screenLinks > 0,
  fieldCount: row._count.fields,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

/** What the detail needs besides the head row, already ordered as the API returns it. */
type DetailParts = {
  environments: EnvironmentDetail[];
  fields: FieldView[];
  assignments: {
    id: number;
    assignmentFunction: AssignmentFunction;
    tableFunction: string | null;
    usedIn: string;
    variableId: number;
    screenId: number;
  }[];
  variables: Map<number, Ref>;
  screens: Map<number, Ref>;
  derivedFrom: Ref[];
};

const toView = (row: HeadRow, parts: DetailParts): CollectionView => ({
  id: row.id,
  applicationId: row.applicationId,
  name: row.name,
  environments: parts.environments.map((e) => e.environment),
  documented: row._count.screenLinks > 0,
  fieldCount: row._count.fields,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
  creationCondition: row.creationCondition,
  description: row.description,
  environmentDetails: parts.environments,
  fields: parts.fields,
  variableAssignments: parts.assignments.map((a) => ({
    id: a.id,
    variable: parts.variables.get(a.variableId)!,
    collection: { id: row.id, name: row.name },
    screen: parts.screens.get(a.screenId)!,
    assignmentFunction: a.assignmentFunction,
    tableFunction: a.tableFunction,
    usedIn: a.usedIn,
  })),
  derivedFrom: parts.derivedFrom.sort((a, b) => a.name.localeCompare(b.name) || a.id - b.id),
});

/** A page of collections of one application and the total that matches the filters. */
export async function listCollections(
  client: CollectionsClient,
  query: CollectionListQuery,
): Promise<[CollectionSummaryView[], number]> {
  const where: Prisma.CollectionWhereInput = {
    applicationId: query.applicationId,
    ...(query.q === undefined ? {} : { name: { contains: escapeLike(query.q), mode: 'insensitive' } }),
    ...(query.environment === undefined
      ? {}
      : { element: { environments: { some: { environment: query.environment } } } }),
    // D-14: undocumented = no row in screen_collection.
    ...(query.undocumented === true ? { screenLinks: { none: {} } } : {}),
  };
  const [rows, total] = await Promise.all([
    client.collection.findMany({
      where,
      select: SUMMARY_SELECT,
      orderBy: [{ [query.sort.field]: query.sort.direction }, { id: 'asc' }],
      skip: query.skip,
      take: query.take,
    }),
    client.collection.count({ where }),
  ]);
  return [rows.map(toSummary), total];
}

/**
 * Reads one collection with environments, fields, assignments and derivations.
 *
 * One nested `select` would make Prisma send the statements of every relation at once on the connection, and inside a
 * transaction that is one connection: `pg` queues them (deprecated, a failure in pg 9) and the transaction stays open
 * longer. So each part is a flat read awaited before the next, with the same `ORDER BY` the nested form had.
 */
export async function findCollectionById(client: CollectionsClient, id: number): Promise<CollectionView | null> {
  const row = await client.collection.findUnique({ where: { id }, select: HEAD_SELECT });
  if (!row) return null;

  const environments = await client.elementEnvironment.findMany({
    where: { elementId: id, elementType: 'COLLECTION' },
    select: { environment: true, notes: true },
    orderBy: { environment: 'asc' },
  });
  const fields = await client.collectionField.findMany({
    where: { collectionId: id },
    select: { id: true, name: true, dataType: true, description: true, position: true },
    orderBy: [{ position: 'asc' }, { id: 'asc' }],
  });
  const assignments = await client.variableCollection.findMany({
    where: { collectionId: id },
    select: { id: true, assignmentFunction: true, tableFunction: true, usedIn: true, variableId: true, screenId: true },
    orderBy: [{ variable: { name: 'asc' } }, { screen: { name: 'asc' } }, { usedIn: 'asc' }, { id: 'asc' }],
  });
  const variableIds = [...new Set(assignments.map((a) => a.variableId))];
  const variables =
    variableIds.length === 0
      ? []
      : await client.variable.findMany({ where: { id: { in: variableIds } }, select: { id: true, name: true } });
  const screenIds = [...new Set(assignments.map((a) => a.screenId))];
  const screens =
    screenIds.length === 0
      ? []
      : await client.screen.findMany({ where: { id: { in: screenIds } }, select: { id: true, name: true } });

  const derivations = await client.dependency.findMany({
    where: { sourceId: id, relationType: 'DERIVES_FROM' },
    select: { targetId: true },
  });
  const derivedIds = [...new Set(derivations.map((d) => d.targetId))];
  const derivedFrom =
    derivedIds.length === 0
      ? []
      : await client.collection.findMany({ where: { id: { in: derivedIds } }, select: { id: true, name: true } });

  return toView(row, {
    environments,
    fields,
    assignments,
    variables: new Map(variables.map((v) => [v.id, v])),
    screens: new Map(screens.map((x) => [x.id, x])),
    derivedFrom,
  });
}

/** Reads the columns other rules need from a collection, or `null` when it does not exist. */
export async function findCollectionRef(
  client: Pick<CollectionsClient, 'collection'>,
  id: number,
): Promise<CollectionRef | null> {
  return client.collection.findUnique({ where: { id }, select: { id: true, name: true, applicationId: true } });
}

/**
 * Reads the reference of a collection and locks its row FOR SHARE until the end of the transaction: a concurrent
 * delete waits, so a link written meanwhile never points at a vanished collection.
 */
export async function findCollectionRefShared(
  client: Pick<CollectionsClient, '$queryRaw'>,
  id: number,
): Promise<CollectionRef | null> {
  const rows = await client.$queryRaw<
    { id: number; name: string; application_id: number }[]
  >`SELECT id, name, application_id FROM collection WHERE id = ${id} FOR SHARE`;
  const row = rows[0];
  return row ? { id: row.id, name: row.name, applicationId: row.application_id } : null;
}

/** A page of the fields of a collection, by position and then id, and the total. */
export async function listFields(
  client: Pick<CollectionsClient, 'collectionField'>,
  collectionId: number,
  skip: number,
  take: number,
): Promise<[FieldView[], number]> {
  const where = { collectionId };
  return Promise.all([
    client.collectionField.findMany({
      where,
      select: { id: true, name: true, dataType: true, description: true, position: true },
      orderBy: [{ position: 'asc' }, { id: 'asc' }],
      skip,
      take,
    }),
    client.collectionField.count({ where }),
  ]);
}

/** Locks the collection row until the end of the transaction (PUT, DELETE), so the ETag and the items read are current. */
export async function lockCollectionForUpdate(client: Pick<CollectionsClient, '$queryRaw'>, id: number): Promise<void> {
  await client.$queryRaw`SELECT id FROM collection WHERE id = ${id} FOR UPDATE`;
}

/** Whether another collection of the application already has the name (SDD Table 31). */
export async function nameIsTaken(
  client: Pick<CollectionsClient, 'collection'>,
  key: { applicationId: number; name: string },
  exceptId: number | undefined,
): Promise<boolean> {
  const found = await client.collection.findFirst({
    where: {
      applicationId: key.applicationId,
      name: key.name,
      ...(exceptId === undefined ? {} : { id: { not: exceptId } }),
    },
    select: { id: true },
  });
  return found !== null;
}

/** Inserts the element, the collection, its environments, fields, assignments and derivations; returns the id. */
export async function createCollection(
  client: Pick<CollectionsClient, 'documentedElement'>,
  applicationId: number,
  data: CollectionData,
  environments: readonly EnvironmentInput[],
  fields: readonly FieldData[],
  assignments: readonly AssignmentData[],
  derivedFrom: readonly number[],
): Promise<number> {
  const element = await client.documentedElement.create({
    data: {
      type: 'COLLECTION',
      applicationId,
      collection: {
        create: {
          name: data.name,
          creationCondition: data.creationCondition,
          description: data.description,
          fields: { create: fields.map((f) => ({ ...f })) },
          variableLinks: { create: assignments.map((a) => ({ ...a })) },
        },
      },
      environments: { create: environments.map((e) => ({ environment: e.environment, notes: e.notes })) },
      outgoing: {
        create: derivedFrom.map((targetId) => ({
          targetId,
          targetType: 'COLLECTION' as const,
          relationType: 'DERIVES_FROM' as const,
        })),
      },
    },
    select: { id: true },
  });
  return element.id;
}

/** Writes only the given columns (`updated_at` follows by `@updatedAt`). */
export async function updateCollectionColumns(
  client: Pick<CollectionsClient, 'collection'>,
  id: number,
  changes: Partial<CollectionData>,
): Promise<void> {
  await client.collection.update({ where: { id }, data: changes });
}

/** Touches `updated_at` of the collection, so a change of its nested arrays changes its ETag (D-62). */
export async function touchCollection(client: Pick<CollectionsClient, 'collection'>, id: number): Promise<void> {
  await client.collection.update({ where: { id }, data: { updatedAt: new Date() } });
}

/** Makes the environments of the collection equal to `wanted` by difference: delete, update notes, insert. */
export const replaceEnvironments = (
  client: Pick<CollectionsClient, 'elementEnvironment'>,
  collectionId: number,
  current: readonly EnvironmentInput[],
  wanted: readonly EnvironmentInput[],
): Promise<void> => replaceElementEnvironments(client, collectionId, 'COLLECTION', current, wanted);

/** Deletes fields by id. */
export async function deleteFields(client: Pick<CollectionsClient, 'collectionField'>, ids: number[]): Promise<void> {
  await client.collectionField.deleteMany({ where: { id: { in: ids } } });
}

/** Writes the given columns of a field. */
export async function updateField(
  client: Pick<CollectionsClient, 'collectionField'>,
  id: number,
  data: Partial<FieldData>,
): Promise<void> {
  await client.collectionField.update({ where: { id }, data });
}

/** Inserts a field. */
export async function createField(
  client: Pick<CollectionsClient, 'collectionField'>,
  collectionId: number,
  data: FieldData,
): Promise<void> {
  await client.collectionField.create({ data: { collectionId, ...data } });
}

/** Deletes assignments by id. */
export async function deleteAssignments(
  client: Pick<CollectionsClient, 'variableCollection'>,
  ids: number[],
): Promise<void> {
  await client.variableCollection.deleteMany({ where: { id: { in: ids } } });
}

/** Writes the given columns of an assignment. */
export async function updateAssignment(
  client: Pick<CollectionsClient, 'variableCollection'>,
  id: number,
  data: Partial<AssignmentData>,
): Promise<void> {
  await client.variableCollection.update({ where: { id }, data });
}

/** Inserts an assignment. */
export async function createAssignment(
  client: Pick<CollectionsClient, 'variableCollection'>,
  collectionId: number,
  data: AssignmentData,
): Promise<void> {
  await client.variableCollection.create({ data: { collectionId, ...data } });
}

/** Deletes the derivations (DERIVES_FROM) of the collection that point at the given collections. */
export async function deleteDerivations(
  client: Pick<CollectionsClient, 'dependency'>,
  collectionId: number,
  targetIds: number[],
): Promise<void> {
  await client.dependency.deleteMany({
    where: { sourceId: collectionId, relationType: 'DERIVES_FROM', targetId: { in: targetIds } },
  });
}

/** Inserts one derivation: the collection is built from `targetId` (SDD Table 32). */
export async function createDerivation(
  client: Pick<CollectionsClient, 'dependency'>,
  collectionId: number,
  targetId: number,
): Promise<void> {
  await client.dependency.create({
    data: {
      sourceId: collectionId,
      sourceType: 'COLLECTION',
      targetId,
      targetType: 'COLLECTION',
      relationType: 'DERIVES_FROM',
    },
  });
}

/** Deletes the collection; the database cascades fields, assignments, screen links and dependencies both ways. */
export async function deleteCollection(client: Pick<CollectionsClient, 'collection'>, id: number): Promise<void> {
  await client.collection.delete({ where: { id } });
}
