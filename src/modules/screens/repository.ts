/**
 * Prisma queries of the screens module. No rules live here (SDD Table 6, D-42).
 *
 * A screen is stored in `documented_element` (supertype) and `screen` (subtype); each component the same way
 * (`component`); the links in `screen_variable` and `screen_collection`; the uses of a component (USES) and the
 * navigations of the screen (NAVIGATES_TO) in `dependency` (D-29). The API returns them as one resource.
 *
 * The listing uses one SQL statement because it must order by `pendingSubtasks` (Subtasks whose status category is
 * not DONE, D-14) over ALL the screens of the application before paginating, which Prisma cannot express. The sort
 * column and direction come from fixed maps, never from the request text; every value is a bound parameter.
 *
 * @module modules/screens/repository
 */
import { Prisma, type AccessMode, type DocumentationStatus, type PrismaClient } from '../../generated/prisma/client.js';
import { escapeLike } from '../../http/like.js';
import type { TemplateContent } from './documentationWorkflow.js';

/** Clients accepted by the queries: the plain client or the transaction client of `auditedTransaction`. */
export type ScreensClient = Pick<
  PrismaClient,
  | 'screen'
  | 'component'
  | 'screenVariable'
  | 'screenCollection'
  | 'dependency'
  | 'documentedElement'
  | '$queryRaw'
  | '$executeRaw'
>;

/** A screen as the listing returns it (contract schema `ScreenSummary`). */
export type ScreenSummaryView = {
  id: number;
  applicationId: number;
  name: string;
  isAppContext: boolean;
  documentationStatus: DocumentationStatus;
  author: { id: number; name: string };
  pendingSubtasks: number;
  commentCount: number;
  createdAt: Date;
  updatedAt: Date;
};

/** The columns of a screen that other modules need to validate a reference to it. */
export type ScreenRef = { id: number; name: string; applicationId: number; isAppContext: boolean };

/** Fields the contract allows in `sort` of `GET /screens`. */
export type ScreenSortField = 'name' | 'documentationStatus' | 'updatedAt' | 'pendingSubtasks';

/** Filters, order and page of `GET /screens`. The App (OnStart) screen is always first; `id` breaks ties. */
export type ScreenListQuery = {
  applicationId: number;
  q?: string | undefined;
  documentationStatus?: DocumentationStatus | undefined;
  authorId?: number | undefined;
  sort: { field: ScreenSortField; direction: 'asc' | 'desc' };
  skip: number;
  take: number;
};

const SORT_COLUMN: Readonly<Record<ScreenSortField, Prisma.Sql>> = {
  name: Prisma.raw('s.name'),
  documentationStatus: Prisma.raw('s.documentation_status'),
  updatedAt: Prisma.raw('s.updated_at'),
  pendingSubtasks: Prisma.raw('pending_subtasks'),
};

type Row = {
  id: number;
  application_id: number;
  name: string;
  is_app_context: boolean;
  documentation_status: DocumentationStatus;
  author_id: number;
  author_name: string;
  pending_subtasks: number;
  comment_count: number;
  created_at: Date;
  updated_at: Date;
};

const toView = (r: Row): ScreenSummaryView => ({
  id: r.id,
  applicationId: r.application_id,
  name: r.name,
  isAppContext: r.is_app_context,
  documentationStatus: r.documentation_status,
  author: { id: r.author_id, name: r.author_name },
  pendingSubtasks: r.pending_subtasks,
  commentCount: r.comment_count,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

/** A page of screens of one application and the total that matches the filters. */
export async function listScreens(
  client: Pick<ScreensClient, '$queryRaw'>,
  query: ScreenListQuery,
): Promise<[ScreenSummaryView[], number]> {
  const conditions: Prisma.Sql[] = [Prisma.sql`s.application_id = ${query.applicationId}`];
  if (query.q !== undefined) conditions.push(Prisma.sql`s.name ILIKE ${`%${escapeLike(query.q)}%`}`);
  if (query.documentationStatus !== undefined) {
    conditions.push(Prisma.sql`s.documentation_status = ${query.documentationStatus}::documentation_status`);
  }
  if (query.authorId !== undefined) conditions.push(Prisma.sql`s.author_id = ${query.authorId}`);
  const where = Prisma.join(conditions, ' AND ');
  const direction = Prisma.raw(query.sort.direction === 'desc' ? 'DESC' : 'ASC');

  const [rows, count] = await Promise.all([
    client.$queryRaw<Row[]>`
      SELECT s.id, s.application_id, s.name, s.is_app_context, s.documentation_status, s.author_id,
             u.name AS author_name, s.created_at, s.updated_at,
             (SELECT count(*)::int FROM jira_ticket j
               WHERE j.screen_id = s.id AND j.hierarchy_level = 'SUBTASK' AND j.status_category <> 'DONE')
               AS pending_subtasks,
             (SELECT count(*)::int FROM comment c WHERE c.screen_id = s.id) AS comment_count
        FROM screen s
        JOIN app_user u ON u.id = s.author_id
       WHERE ${where}
       ORDER BY s.is_app_context DESC, ${SORT_COLUMN[query.sort.field]} ${direction}, s.id ASC
       LIMIT ${query.take} OFFSET ${query.skip}`,
    client.$queryRaw<{ total: number }[]>`SELECT count(*)::int AS total FROM screen s WHERE ${where}`,
  ]);
  return [rows.map(toView), count[0]?.total ?? 0];
}

/** Reads the columns of a screen that other modules validate (existence, application, App (OnStart) flag). */
export async function findScreenRef(client: Pick<PrismaClient, 'screen'>, id: number): Promise<ScreenRef | null> {
  return client.screen.findUnique({
    where: { id },
    select: { id: true, name: true, applicationId: true, isAppContext: true },
  });
}

// ------------------------------------------------------------------------------------------------- detail

/** Reference to another resource (contract schema `Ref`). */
export type Ref = { id: number; name: string };

/** A use of a variable or a collection by a component (contract `Screen.components[].uses[]`). */
export type UseView = {
  id: number;
  targetType: 'VARIABLE' | 'COLLECTION';
  target: Ref;
  description: string | null;
};

/** A component of a screen (contract `Screen.components[]`). */
export type ComponentView = {
  id: number;
  name: string;
  type: string;
  onSelect: string | null;
  description: string | null;
  uses: UseView[];
};

/** A link to a variable; `isOrigin` rows are maintained by the variables module (contract `variableLinks[]`). */
export type VariableLinkView = { id: number; variable: Ref; accessMode: AccessMode; usedIn: string; isOrigin: boolean };

/** A link to a collection (contract `collectionLinks[]`). */
export type CollectionLinkView = { id: number; collection: Ref; accessMode: AccessMode; usedIn: string };

/** A navigation to another screen (contract `navigations[]`). */
export type NavigationView = { id: number; targetScreen: Ref; description: string | null };

/** A screen as `GET`, `POST` and `PUT` return it (contract schema `Screen`). */
export type ScreenView = ScreenSummaryView & {
  miroLink: string | null;
  template: TemplateContent;
  components: ComponentView[];
  variableLinks: VariableLinkView[];
  collectionLinks: CollectionLinkView[];
  navigations: NavigationView[];
};

/** Editable columns of a screen (contract `ScreenWrite`, without the nested arrays) and its status (D-81). */
export type ScreenData = {
  name: string;
  miroLink: string | null;
  documentationStatus: DocumentationStatus;
} & { -readonly [K in keyof TemplateContent]: TemplateContent[K] };

/** A component to write. */
export type ComponentData = { name: string; type: string; onSelect: string | null; description: string | null };

/** A link to a variable to write. */
export type VariableLinkData = { variableId: number; accessMode: AccessMode; usedIn: string };

/** A link to a collection to write. */
export type CollectionLinkData = { collectionId: number; accessMode: AccessMode; usedIn: string };

/** A dependency to write; the types are derived by the service (SDD Table 32). */
export type DependencyData = {
  targetId: number;
  targetType: 'VARIABLE' | 'COLLECTION' | 'SCREEN';
  description: string | null;
};

const REF_SELECT = { select: { id: true, name: true } } as const;

/**
 * The screen itself: its columns, its author and the two counts (one level of relations, so Prisma sends its
 * statements one after the other). The components, links and navigations are read apart (see `findScreenById`).
 */
const SCREEN_SELECT = {
  id: true,
  applicationId: true,
  name: true,
  isAppContext: true,
  documentationStatus: true,
  onStart: true,
  workingProcess: true,
  architecture: true,
  dataModel: true,
  requirements: true,
  knownIssues: true,
  risks: true,
  miroLink: true,
  createdAt: true,
  updatedAt: true,
  author: REF_SELECT,
  _count: {
    select: {
      comments: true,
      jiraTickets: { where: { hierarchyLevel: 'SUBTASK', statusCategory: { not: 'DONE' } } },
    },
  },
} satisfies Prisma.ScreenSelect;

type ScreenRow = Prisma.ScreenGetPayload<{ select: typeof SCREEN_SELECT }>;

/** What the detail needs besides the screen row: the rows of its items, already ordered as the API returns them. */
type DetailParts = {
  components: { id: number; name: string; type: string; onSelect: string | null; description: string | null }[];
  uses: { id: number; sourceId: number; targetId: number; targetType: string; description: string | null }[];
  variables: Map<number, Ref>;
  collections: Map<number, Ref>;
  variableLinks: { id: number; accessMode: AccessMode; usedIn: string; variable: Ref }[];
  collectionLinks: CollectionLinkView[];
  navigations: { id: number; targetId: number; description: string | null }[];
  screens: Map<number, Ref>;
};

const toDetail = (row: ScreenRow, parts: DetailParts): ScreenView => {
  const usesOf = new Map<number, UseView[]>();
  for (const u of parts.uses) {
    const target = parts.variables.get(u.targetId) ?? parts.collections.get(u.targetId);
    if (target && (u.targetType === 'VARIABLE' || u.targetType === 'COLLECTION')) {
      const list = usesOf.get(u.sourceId) ?? [];
      list.push({ id: u.id, targetType: u.targetType, target, description: u.description });
      usesOf.set(u.sourceId, list);
    }
  }
  return {
    id: row.id,
    applicationId: row.applicationId,
    name: row.name,
    isAppContext: row.isAppContext,
    documentationStatus: row.documentationStatus,
    author: row.author,
    pendingSubtasks: row._count.jiraTickets,
    commentCount: row._count.comments,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    miroLink: row.miroLink,
    template: {
      onStart: row.onStart,
      workingProcess: row.workingProcess,
      architecture: row.architecture,
      dataModel: row.dataModel,
      requirements: row.requirements,
      knownIssues: row.knownIssues,
      risks: row.risks,
    },
    components: parts.components.map((c) => ({
      id: c.id,
      name: c.name,
      type: c.type,
      onSelect: c.onSelect,
      description: c.description,
      uses: (usesOf.get(c.id) ?? []).sort((a, b) => a.target.name.localeCompare(b.target.name) || a.id - b.id),
    })),
    variableLinks: parts.variableLinks.map((l) => ({
      id: l.id,
      variable: l.variable,
      accessMode: l.accessMode,
      usedIn: l.usedIn,
      isOrigin: l.usedIn === 'origin',
    })),
    collectionLinks: parts.collectionLinks,
    navigations: parts.navigations
      .flatMap((n) => {
        const targetScreen = parts.screens.get(n.targetId);
        return targetScreen ? [{ id: n.id, targetScreen, description: n.description }] : [];
      })
      .sort((a, b) => a.targetScreen.name.localeCompare(b.targetScreen.name) || a.id - b.id),
  };
};

const byId = <T extends { id: number }>(rows: T[]): Map<number, T> => new Map(rows.map((r) => [r.id, r]));

/**
 * Reads one screen with its template, components (and their uses), links and navigations.
 *
 * One nested `select` would make Prisma send the statements of every relation at once on the connection, and inside a
 * transaction that is one connection: `pg` queues them (deprecated, a failure in pg 9) and the transaction stays open
 * longer. So each part is a flat read awaited before the next, in the same order and with the same `ORDER BY` as the
 * nested form had.
 */
export async function findScreenById(
  client: Pick<ScreensClient, 'screen' | 'component' | 'screenVariable' | 'screenCollection' | 'dependency'> &
    Pick<PrismaClient, 'variable' | 'collection'>,
  id: number,
): Promise<ScreenView | null> {
  const row = await client.screen.findUnique({ where: { id }, select: SCREEN_SELECT });
  if (!row) return null;

  const components = await client.component.findMany({
    where: { screenId: id },
    select: { id: true, name: true, type: true, onSelect: true, description: true },
    orderBy: [{ name: 'asc' }, { id: 'asc' }],
  });
  const uses =
    components.length === 0
      ? []
      : await client.dependency.findMany({
          where: { sourceId: { in: components.map((c) => c.id) }, relationType: 'USES' },
          select: { id: true, sourceId: true, targetId: true, targetType: true, description: true },
          orderBy: { id: 'asc' },
        });
  const useTargets = [...new Set(uses.map((u) => u.targetId))];
  const variables =
    useTargets.length === 0
      ? []
      : await client.variable.findMany({ where: { id: { in: useTargets } }, select: { id: true, name: true } });
  const collections =
    useTargets.length === 0
      ? []
      : await client.collection.findMany({ where: { id: { in: useTargets } }, select: { id: true, name: true } });

  const variableLinks = await client.screenVariable.findMany({
    where: { screenId: id },
    select: { id: true, accessMode: true, usedIn: true, variable: REF_SELECT },
    orderBy: [{ variable: { name: 'asc' } }, { usedIn: 'asc' }, { id: 'asc' }],
  });
  const collectionLinks = await client.screenCollection.findMany({
    where: { screenId: id },
    select: { id: true, accessMode: true, usedIn: true, collection: REF_SELECT },
    orderBy: [{ collection: { name: 'asc' } }, { usedIn: 'asc' }, { id: 'asc' }],
  });

  const navigations = await client.dependency.findMany({
    where: { sourceId: id, relationType: 'NAVIGATES_TO' },
    select: { id: true, targetId: true, description: true },
    orderBy: { id: 'asc' },
  });
  const targets = [...new Set(navigations.map((n) => n.targetId))];
  const screens =
    targets.length === 0
      ? []
      : await client.screen.findMany({ where: { id: { in: targets } }, select: { id: true, name: true } });

  return toDetail(row, {
    components,
    uses,
    variables: byId(variables),
    collections: byId(collections),
    variableLinks,
    collectionLinks,
    navigations,
    screens: byId(screens),
  });
}

/** What a write needs to know about a locked screen. */
export type LockedScreen = {
  id: number;
  applicationId: number;
  name: string;
  isAppContext: boolean;
  documentationStatus: DocumentationStatus;
};

/** Locks the screen row until the end of the transaction (PUT, DELETE), so the ETag and the items read are current. */
export async function lockScreenForUpdate(
  client: Pick<ScreensClient, '$queryRaw'>,
  id: number,
): Promise<LockedScreen | null> {
  const rows = await client.$queryRaw<
    {
      id: number;
      application_id: number;
      name: string;
      is_app_context: boolean;
      documentation_status: DocumentationStatus;
    }[]
  >`SELECT id, application_id, name, is_app_context, documentation_status FROM screen WHERE id = ${id} FOR UPDATE`;
  const row = rows[0];
  return row
    ? {
        id: row.id,
        applicationId: row.application_id,
        name: row.name,
        isAppContext: row.is_app_context,
        documentationStatus: row.documentation_status,
      }
    : null;
}

/** Whether another screen of the application already has the name (SDD Table 30). */
export async function nameIsTaken(
  client: Pick<ScreensClient, 'screen'>,
  key: { applicationId: number; name: string },
  exceptId: number | undefined,
): Promise<boolean> {
  const found = await client.screen.findFirst({
    where: {
      applicationId: key.applicationId,
      name: key.name,
      ...(exceptId === undefined ? {} : { id: { not: exceptId } }),
    },
    select: { id: true },
  });
  return found !== null;
}

/** Inserts the element and the screen row; returns the id. */
export async function createScreenRow(
  client: Pick<ScreensClient, 'documentedElement'>,
  applicationId: number,
  authorId: number,
  data: ScreenData,
): Promise<number> {
  const element = await client.documentedElement.create({
    data: { type: 'SCREEN', applicationId, screen: { create: { ...data, authorId } } },
    select: { id: true },
  });
  return element.id;
}

/** Writes only the given columns (`updated_at` follows by `@updatedAt`). */
export async function updateScreenColumns(
  client: Pick<ScreensClient, 'screen'>,
  id: number,
  changes: Partial<ScreenData>,
): Promise<void> {
  await client.screen.update({ where: { id }, data: changes });
}

/** Touches `updated_at` of the screen, so a change of its nested arrays changes its ETag (D-62). */
export async function touchScreen(client: Pick<ScreensClient, 'screen'>, id: number): Promise<void> {
  await client.screen.update({ where: { id }, data: { updatedAt: new Date() } });
}

/** Business events of the review (D-30, D-88): the names are the ones the contract documents. */
export type ReviewEventName = 'DOCUMENTATION_APPROVED' | 'DOCUMENTATION_RETURNED';

/**
 * Records a review decision as a business event through `log_business_event`, the only way `docs_app` writes to
 * `audit_log`. The actor is the user of the transaction (`app.user_id`); `entity_type` is `screen`, the same the audit
 * trigger uses for the table.
 */
export async function logReviewEvent(
  client: Pick<ScreensClient, '$executeRaw'>,
  event: {
    name: ReviewEventName;
    screen: { id: number; name: string; applicationId: number };
    payload: { from: DocumentationStatus; to: DocumentationStatus; commentId: number | null };
  },
): Promise<void> {
  const payload = JSON.stringify(event.payload);
  await client.$executeRaw`SELECT log_business_event(${event.name}, 'screen', ${String(event.screen.id)}, ${event.screen.name}, ${payload}::jsonb, ${event.screen.applicationId}::int)`;
}

/** Deletes the screen; the database cascades components, links, dependencies, comments and tickets. */
export async function deleteScreenRow(client: Pick<ScreensClient, 'screen'>, id: number): Promise<void> {
  await client.screen.delete({ where: { id } });
}

/** Inserts a component (element + subtype); returns its id. */
export async function createComponent(
  client: Pick<ScreensClient, 'documentedElement'>,
  applicationId: number,
  screenId: number,
  data: ComponentData,
): Promise<number> {
  const element = await client.documentedElement.create({
    data: { type: 'COMPONENT', applicationId, component: { create: { screenId, ...data } } },
    select: { id: true },
  });
  return element.id;
}

/** Writes the given columns of a component. */
export async function updateComponent(
  client: Pick<ScreensClient, 'component'>,
  id: number,
  data: Partial<ComponentData>,
): Promise<void> {
  await client.component.update({ where: { id }, data });
}

/** Deletes components by id (the database removes their elements and dependencies). */
export async function deleteComponents(client: Pick<ScreensClient, 'component'>, ids: number[]): Promise<void> {
  await client.component.deleteMany({ where: { id: { in: ids } } });
}

/** Inserts links to variables. */
export async function createVariableLinks(
  client: Pick<ScreensClient, 'screenVariable'>,
  screenId: number,
  links: readonly VariableLinkData[],
): Promise<void> {
  if (links.length > 0) await client.screenVariable.createMany({ data: links.map((l) => ({ screenId, ...l })) });
}

/** Writes the given columns of a link to a variable. */
export async function updateVariableLink(
  client: Pick<ScreensClient, 'screenVariable'>,
  id: number,
  data: Partial<VariableLinkData>,
): Promise<void> {
  await client.screenVariable.update({ where: { id }, data });
}

/** Deletes links to variables by id. */
export async function deleteVariableLinks(client: Pick<ScreensClient, 'screenVariable'>, ids: number[]): Promise<void> {
  await client.screenVariable.deleteMany({ where: { id: { in: ids } } });
}

/** Inserts links to collections. */
export async function createCollectionLinks(
  client: Pick<ScreensClient, 'screenCollection'>,
  screenId: number,
  links: readonly CollectionLinkData[],
): Promise<void> {
  if (links.length > 0) await client.screenCollection.createMany({ data: links.map((l) => ({ screenId, ...l })) });
}

/** Writes the given columns of a link to a collection. */
export async function updateCollectionLink(
  client: Pick<ScreensClient, 'screenCollection'>,
  id: number,
  data: Partial<CollectionLinkData>,
): Promise<void> {
  await client.screenCollection.update({ where: { id }, data });
}

/** Deletes links to collections by id. */
export async function deleteCollectionLinks(
  client: Pick<ScreensClient, 'screenCollection'>,
  ids: number[],
): Promise<void> {
  await client.screenCollection.deleteMany({ where: { id: { in: ids } } });
}

/** Inserts one dependency from a component (USES) or from the screen (NAVIGATES_TO). */
export async function createDependency(
  client: Pick<ScreensClient, 'dependency'>,
  source: { id: number; type: 'COMPONENT' | 'SCREEN' },
  relationType: 'USES' | 'NAVIGATES_TO',
  data: DependencyData,
): Promise<void> {
  await client.dependency.create({
    data: {
      sourceId: source.id,
      sourceType: source.type,
      targetId: data.targetId,
      targetType: data.targetType,
      relationType,
      description: data.description,
    },
  });
}

/** Writes the target and description of a dependency, keeping its row. */
export async function updateDependency(
  client: Pick<ScreensClient, 'dependency'>,
  id: number,
  data: Partial<DependencyData>,
): Promise<void> {
  await client.dependency.update({ where: { id }, data });
}

/** Deletes dependencies by id. */
export async function deleteDependencies(client: Pick<ScreensClient, 'dependency'>, ids: number[]): Promise<void> {
  await client.dependency.deleteMany({ where: { id: { in: ids } } });
}
