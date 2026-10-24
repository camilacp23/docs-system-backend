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
import { escapeLike } from '../../http/like.js';

/** Clients accepted by the queries: the plain client or the transaction client of `auditedTransaction`. */
export type VariablesClient = Pick<
  PrismaClient,
  'variable' | 'screenVariable' | 'variableCollection' | 'dependency' | '$queryRaw'
>;

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
  environmentDetails: EnvironmentDetail[];
};

/** Editable columns of a variable (contract schema `VariableWrite`, without the environments). */
export type VariableData = {
  name: string;
  dataType: DataType;
  scope: VariableScope;
  description: string | null;
  originScreenId: number | null;
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

/** Reads one variable with its environments. */
export async function findVariableById(client: VariablesClient, id: number): Promise<VariableView | null> {
  const row = await client.variable.findUnique({ where: { id }, select: VARIABLE_SELECT });
  return row ? toView(row) : null;
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
