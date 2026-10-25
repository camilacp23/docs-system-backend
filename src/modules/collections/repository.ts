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

const DETAIL_SELECT = {
  ...SUMMARY_SELECT,
  creationCondition: true,
  description: true,
  element: {
    select: {
      environments: { select: { environment: true, notes: true }, orderBy: { environment: 'asc' } },
      outgoing: {
        where: { relationType: 'DERIVES_FROM' },
        select: { target: { select: { collection: { select: { id: true, name: true } } } } },
      },
    },
  },
  fields: {
    select: { id: true, name: true, dataType: true, description: true, position: true },
    orderBy: [{ position: 'asc' }, { id: 'asc' }],
  },
  variableLinks: {
    select: {
      id: true,
      assignmentFunction: true,
      tableFunction: true,
      usedIn: true,
      variable: { select: { id: true, name: true } },
      screen: { select: { id: true, name: true } },
    },
    orderBy: [{ variable: { name: 'asc' } }, { screen: { name: 'asc' } }, { usedIn: 'asc' }, { id: 'asc' }],
  },
} satisfies Prisma.CollectionSelect;

type SummaryRow = Prisma.CollectionGetPayload<{ select: typeof SUMMARY_SELECT }>;
type DetailRow = Prisma.CollectionGetPayload<{ select: typeof DETAIL_SELECT }>;

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

const toView = (row: DetailRow): CollectionView => ({
  ...toSummary(row),
  creationCondition: row.creationCondition,
  description: row.description,
  environmentDetails: row.element.environments,
  fields: row.fields,
  variableAssignments: row.variableLinks.map((a) => ({
    id: a.id,
    variable: a.variable,
    collection: { id: row.id, name: row.name },
    screen: a.screen,
    assignmentFunction: a.assignmentFunction,
    tableFunction: a.tableFunction,
    usedIn: a.usedIn,
  })),
  derivedFrom: row.element.outgoing
    .flatMap((d) => (d.target.collection ? [d.target.collection] : []))
    .sort((a, b) => a.name.localeCompare(b.name) || a.id - b.id),
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

/** Reads one collection with environments, fields, assignments and derivations. */
export async function findCollectionById(client: CollectionsClient, id: number): Promise<CollectionView | null> {
  const row = await client.collection.findUnique({ where: { id }, select: DETAIL_SELECT });
  return row ? toView(row) : null;
}

/** Reads the columns other rules need from a collection, or `null` when it does not exist. */
export async function findCollectionRef(
  client: Pick<CollectionsClient, 'collection'>,
  id: number,
): Promise<CollectionRef | null> {
  return client.collection.findUnique({ where: { id }, select: { id: true, name: true, applicationId: true } });
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
