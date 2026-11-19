/**
 * Prisma queries of the variables module (Module 2: FR-05, FR-06, FR-07; SDD Table 48). No rules live here (SDD
 * Table 6, D-42): the service decides, this only reads and writes.
 *
 * A variable is stored in three tables: `documented_element` (supertype), `variable` (subtype) and
 * `element_environment` (presence in DEV / PROD, D-04). The API returns them as one resource.
 *
 * @module modules/variables/repository
 */
import type { DataType, Environment, Prisma, PrismaClient, VariableScope } from '../../generated/prisma/client.js';
import { replaceElementEnvironments, type EnvironmentInput } from '../../db/elementEnvironments.js';
import { escapeLike } from '../../http/like.js';

export type { EnvironmentInput };

/** Clients accepted by the queries: the plain client or the transaction client of `auditedTransaction`. */
export type VariablesClient = Pick<
  PrismaClient,
  | 'variable'
  | 'documentedElement'
  | 'elementEnvironment'
  | 'screenVariable'
  | 'variableCollection'
  | 'dependency'
  | '$queryRaw'
  | '$executeRaw'
>;

/** First argument of `pg_advisory_xact_lock` reserved for the names of context variables without origin (D-69). */
export const VARIABLE_NAME_LOCK_SPACE = 20_261_069;

/** Reference to another resource (contract schema `Ref`). */
export type Ref = { id: number; name: string };

/** Presence of a variable in one environment, with its notes (contract schema `EnvironmentPresence`). */
export type EnvironmentDetail = { environment: Environment; notes: string | null };

/** A variable as the listing returns it (contract schema `VariableSummary`). */
export type VariableSummaryView = {
  id: number;
  applicationId: number;
  name: string;
  dataType: DataType;
  scope: VariableScope;
  originScreen: Ref | null;
  fullTraceability: boolean;
  environments: Environment[];
  createdAt: Date;
  updatedAt: Date;
};

/** A variable as `GET`, `POST` and `PUT` return it (contract schema `Variable`). */
export type VariableView = VariableSummaryView & {
  description: string | null;
  /** Event or property of the origin screen where the variable is created (D-150); `null` without origin screen. */
  originUsedIn: string | null;
  environmentDetails: EnvironmentDetail[];
};

/** Editable columns of a variable (contract schema `VariableWrite`, without the environments). */
export type VariableData = {
  name: string;
  dataType: DataType;
  scope: VariableScope;
  description: string | null;
  originScreenId: number | null;
  originUsedIn: string | null;
};

/** Sortable fields of `GET /variables` (the whitelist is the contract's description of `sort`). */
export type VariableSortField = 'name' | 'scope' | 'dataType' | 'updatedAt';

/** Filters, order and page of `GET /variables`. `id` breaks ties so pagination is stable. */
export type VariableListQuery = {
  applicationId: number;
  q?: string | undefined;
  scope?: VariableScope | undefined;
  dataType?: DataType | undefined;
  environment?: Environment | undefined;
  originScreenId?: number | undefined;
  untraced?: boolean | undefined;
  sort: { field: VariableSortField; direction: 'asc' | 'desc' };
  skip: number;
  take: number;
};

/** Where a variable is created and used (contract schema `VariableDependenciesEnvelope.data`). */
export type VariableDependenciesView = {
  variable: Ref;
  originScreen: Ref | null;
  screens: { screen: Ref; accessMode: 'READ' | 'WRITE' | 'READ_WRITE'; usedIn: string }[];
  collections: {
    id: number;
    variable: Ref;
    collection: Ref;
    screen: Ref;
    assignmentFunction: 'SET' | 'UPDATE_CONTEXT';
    tableFunction: string | null;
    usedIn: string;
  }[];
  components: { component: Ref; screen: Ref; description: string | null }[];
};

const VARIABLE_SELECT = {
  id: true,
  applicationId: true,
  name: true,
  dataType: true,
  scope: true,
  description: true,
  originUsedIn: true,
  createdAt: true,
  updatedAt: true,
  originScreen: { select: { id: true, name: true } },
  element: {
    select: {
      environments: { select: { environment: true, notes: true }, orderBy: { environment: 'asc' } },
    },
  },
} as const;

type Row = Prisma.VariableGetPayload<{ select: typeof VARIABLE_SELECT }>;

const toSummary = (row: Row): VariableSummaryView => ({
  id: row.id,
  applicationId: row.applicationId,
  name: row.name,
  dataType: row.dataType,
  scope: row.scope,
  originScreen: row.originScreen,
  fullTraceability: row.originScreen !== null,
  environments: row.element.environments.map((e) => e.environment),
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

const toView = (row: Row): VariableView => ({
  ...toSummary(row),
  description: row.description,
  originUsedIn: row.originScreen === null ? null : row.originUsedIn,
  environmentDetails: row.element.environments,
});

/** A page of variables of one application and the total that matches the filters. */
export async function listVariables(
  client: VariablesClient,
  query: VariableListQuery,
): Promise<[VariableSummaryView[], number]> {
  const and: Prisma.VariableWhereInput[] = [];
  if (query.originScreenId !== undefined) and.push({ originScreenId: query.originScreenId });
  if (query.untraced === true) and.push({ originScreenId: null });
  const where: Prisma.VariableWhereInput = {
    applicationId: query.applicationId,
    ...(query.q === undefined ? {} : { name: { contains: escapeLike(query.q), mode: 'insensitive' } }),
    ...(query.scope === undefined ? {} : { scope: query.scope }),
    ...(query.dataType === undefined ? {} : { dataType: query.dataType }),
    ...(query.environment === undefined
      ? {}
      : { element: { environments: { some: { environment: query.environment } } } }),
    ...(and.length === 0 ? {} : { AND: and }),
  };
  const [rows, total] = await Promise.all([
    client.variable.findMany({
      where,
      select: VARIABLE_SELECT,
      orderBy: [{ [query.sort.field]: query.sort.direction }, { id: 'asc' }],
      skip: query.skip,
      take: query.take,
    }),
    client.variable.count({ where }),
  ]);
  return [rows.map(toSummary), total];
}

/** The variable and its origin screen (one relation, so Prisma sends its statements one after the other). */
const HEAD_SELECT = {
  id: true,
  applicationId: true,
  name: true,
  dataType: true,
  scope: true,
  description: true,
  originUsedIn: true,
  createdAt: true,
  updatedAt: true,
  originScreen: { select: { id: true, name: true } },
} as const;

/**
 * Reads one variable with its environments.
 *
 * `VARIABLE_SELECT` has two relations (origin screen and environments), and Prisma sends the statements of two
 * relations at once on the connection; inside a transaction that is one connection, where `pg` queues them
 * (deprecated, a failure in pg 9). So the environments are read apart, after the variable, with the same `ORDER BY`.
 */
export async function findVariableById(client: VariablesClient, id: number): Promise<VariableView | null> {
  const head = await client.variable.findUnique({ where: { id }, select: HEAD_SELECT });
  if (!head) return null;
  const environments = await client.elementEnvironment.findMany({
    where: { elementId: id, elementType: 'VARIABLE' },
    select: { environment: true, notes: true },
    orderBy: { environment: 'asc' },
  });
  return toView({ ...head, element: { environments } });
}

/** Reads where a variable is created and used: screen links (without the origin row), assignments and components. */
export async function findVariableDependencies(
  client: VariablesClient,
  id: number,
): Promise<VariableDependenciesView | null> {
  const variable = await client.variable.findUnique({
    where: { id },
    select: { id: true, name: true, originScreen: { select: { id: true, name: true } } },
  });
  if (!variable) return null;
  const self: Ref = { id: variable.id, name: variable.name };

  const [screenLinks, assignments, uses] = await Promise.all([
    // The row maintained by ensure_origin_write_link (`used_in = 'origin'`) is reported as `originScreen` instead.
    client.screenVariable.findMany({
      where: { variableId: id, NOT: { usedIn: 'origin' } },
      select: { accessMode: true, usedIn: true, screen: { select: { id: true, name: true } } },
      orderBy: [{ screen: { name: 'asc' } }, { usedIn: 'asc' }, { id: 'asc' }],
    }),
    client.variableCollection.findMany({
      where: { variableId: id },
      select: {
        id: true,
        assignmentFunction: true,
        tableFunction: true,
        usedIn: true,
        collection: { select: { id: true, name: true } },
        screen: { select: { id: true, name: true } },
      },
      orderBy: [{ collection: { name: 'asc' } }, { screen: { name: 'asc' } }, { usedIn: 'asc' }, { id: 'asc' }],
    }),
    client.dependency.findMany({
      where: { targetId: id, targetType: 'VARIABLE', sourceType: 'COMPONENT', relationType: 'USES' },
      select: {
        description: true,
        source: {
          select: { component: { select: { id: true, name: true, screen: { select: { id: true, name: true } } } } },
        },
      },
      orderBy: { id: 'asc' },
    }),
  ]);

  return {
    variable: self,
    originScreen: variable.originScreen,
    screens: screenLinks.map((l) => ({ screen: l.screen, accessMode: l.accessMode, usedIn: l.usedIn })),
    collections: assignments.map((a) => ({
      id: a.id,
      variable: self,
      collection: a.collection,
      screen: a.screen,
      assignmentFunction: a.assignmentFunction,
      tableFunction: a.tableFunction,
      usedIn: a.usedIn,
    })),
    components: uses.flatMap((d) => {
      const component = d.source.component;
      // A COMPONENT dependency always has its component row (check_element_has_subtype); skip defensively.
      return component
        ? [
            {
              component: { id: component.id, name: component.name },
              screen: component.screen,
              description: d.description,
            },
          ]
        : [];
    }),
  };
}

/** The first link that the context-screen rule (CP-07, D-52) would reject, or `null` when there is none. */
export type ForbiddenContextLink = { screenId: number; screenName: string };

/** Locks the variable row until the end of the transaction (PUT, DELETE), so the ETag and the links read are current. */
export async function lockVariableForUpdate(client: Pick<VariablesClient, '$queryRaw'>, id: number): Promise<void> {
  await client.$queryRaw`SELECT id FROM variable WHERE id = ${id} FOR UPDATE`;
}

/**
 * Serializes the writers of context variables WITHOUT origin screen of one application until the end of the
 * transaction (D-69): the unique index does not compare NULL, so the service checks the name itself.
 */
export async function lockNamelessContextNames(
  client: Pick<VariablesClient, '$executeRaw'>,
  applicationId: number,
): Promise<void> {
  await client.$executeRaw`SELECT pg_advisory_xact_lock(${VARIABLE_NAME_LOCK_SPACE}::int, ${applicationId}::int)`;
}

/**
 * Whether another variable already holds the name where it must be unique (SDD Table 31, D-63, D-69): GLOBAL, in the
 * application; CONTEXT with origin, in that screen; CONTEXT without origin, among the nameless ones of the application.
 *
 * @param exceptId - The variable being updated (it does not collide with itself); `undefined` on create.
 */
export async function nameIsTaken(
  client: Pick<VariablesClient, 'variable'>,
  key: { applicationId: number; name: string; scope: VariableScope; originScreenId: number | null },
  exceptId: number | undefined,
): Promise<boolean> {
  const where: Prisma.VariableWhereInput = {
    name: key.name,
    scope: key.scope,
    ...(exceptId === undefined ? {} : { id: { not: exceptId } }),
    ...(key.scope === 'CONTEXT' && key.originScreenId !== null
      ? { originScreenId: key.originScreenId }
      : { applicationId: key.applicationId, ...(key.scope === 'CONTEXT' ? { originScreenId: null } : {}) }),
  };
  return (await client.variable.findFirst({ where, select: { id: true } })) !== null;
}

/** Whether the variable has assignments (`variable_collection`) made with `assignmentFunction`. */
export async function hasAssignmentsWith(
  client: Pick<VariablesClient, 'variableCollection'>,
  variableId: number,
  assignmentFunction: 'SET' | 'UPDATE_CONTEXT',
): Promise<boolean> {
  return (
    (await client.variableCollection.findFirst({ where: { variableId, assignmentFunction }, select: { id: true } })) !==
    null
  );
}

/**
 * The first link that would break the rule "a context variable is used only in its origin screen" if its origin were
 * `originScreenId` (CP-07, D-52; same judgement and order as `check_context_screen_links`): a READ or READ_WRITE
 * `screen_variable` row or any `variable_collection` row in another screen, or any link at all when there is no origin.
 * The `origin` row of `screen_variable` is ignored: the trigger `ensure_origin_write_link` moves or removes it.
 */
export async function findForbiddenContextLink(
  client: Pick<VariablesClient, 'screenVariable' | 'variableCollection'>,
  variableId: number,
  originScreenId: number | null,
): Promise<ForbiddenContextLink | null> {
  const screenLink = await client.screenVariable.findFirst({
    where: {
      variableId,
      usedIn: { not: 'origin' },
      ...(originScreenId === null
        ? {}
        : { screenId: { not: originScreenId }, accessMode: { in: ['READ', 'READ_WRITE'] } }),
    },
    orderBy: { id: 'asc' },
    select: { screenId: true, screen: { select: { name: true } } },
  });
  if (screenLink) return { screenId: screenLink.screenId, screenName: screenLink.screen.name };
  const assignment = await client.variableCollection.findFirst({
    where: { variableId, ...(originScreenId === null ? {} : { screenId: { not: originScreenId } }) },
    orderBy: { id: 'asc' },
    select: { screenId: true, screen: { select: { name: true } } },
  });
  return assignment ? { screenId: assignment.screenId, screenName: assignment.screen.name } : null;
}

/** Inserts the element, the variable and its environments in one nested write; returns the id. */
export async function createVariable(
  client: Pick<VariablesClient, 'documentedElement'>,
  applicationId: number,
  data: VariableData,
  environments: readonly EnvironmentInput[],
): Promise<number> {
  const element = await client.documentedElement.create({
    data: {
      type: 'VARIABLE',
      applicationId,
      variable: {
        create: {
          name: data.name,
          dataType: data.dataType,
          scope: data.scope,
          description: data.description,
          originUsedIn: data.originUsedIn,
          ...(data.originScreenId === null ? {} : { originScreen: { connect: { id: data.originScreenId } } }),
        },
      },
      environments: {
        create: environments.map((e) => ({ environment: e.environment, notes: e.notes })),
      },
    },
    select: { id: true },
  });
  return element.id;
}

/** Writes only the given columns (`updated_at` follows by `@updatedAt`). */
export async function updateVariableColumns(
  client: Pick<VariablesClient, 'variable'>,
  id: number,
  changes: Partial<VariableData>,
): Promise<void> {
  await client.variable.update({ where: { id }, data: changes });
}

/** Touches `updated_at` of the variable, so a change of its environments changes its ETag (D-62). */
export async function touchVariable(client: Pick<VariablesClient, 'variable'>, id: number): Promise<void> {
  await client.variable.update({ where: { id }, data: { updatedAt: new Date() } });
}

/** Makes the environments of the variable equal to `wanted` by difference: delete, update notes, insert. */
export const replaceEnvironments = (
  client: Pick<VariablesClient, 'elementEnvironment'>,
  variableId: number,
  current: readonly EnvironmentInput[],
  wanted: readonly EnvironmentInput[],
): Promise<void> => replaceElementEnvironments(client, variableId, 'VARIABLE', current, wanted);

/** The columns of a variable that other modules need to validate a reference to it (CP-07, FR-09). */
export type VariableRef = {
  id: number;
  name: string;
  applicationId: number;
  scope: VariableScope;
  originScreen: Ref | null;
};

/**
 * Reads a variable and locks its row FOR SHARE until the end of the transaction: a concurrent change of its scope or
 * origin waits, and the reader sees the committed version if it had to wait.
 */
export async function findVariableRefShared(
  client: Pick<VariablesClient, '$queryRaw'>,
  id: number,
): Promise<VariableRef | null> {
  const rows = await client.$queryRaw<
    {
      id: number;
      name: string;
      application_id: number;
      scope: VariableScope;
      origin_id: number | null;
      origin_name: string | null;
    }[]
  >`SELECT v.id, v.name, v.application_id, v.scope, s.id AS origin_id, s.name AS origin_name
      FROM variable v LEFT JOIN screen s ON s.id = v.origin_screen_id
     WHERE v.id = ${id} FOR SHARE OF v`;
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    applicationId: row.application_id,
    scope: row.scope,
    originScreen: row.origin_id === null ? null : { id: row.origin_id, name: row.origin_name! },
  };
}

/** Deletes the variable; the database cascades its links, assignments, environments and dependencies. */
export async function deleteVariable(client: Pick<VariablesClient, 'variable'>, id: number): Promise<void> {
  await client.variable.delete({ where: { id } });
}
