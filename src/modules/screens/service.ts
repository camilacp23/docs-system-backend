/**
 * Screen rules (FR-10, FR-11, FR-13, FR-14, FR-19; SDD Table 50, D-14, D-26, D-29, D-52, D-53, D-62 to D-65, D-70,
 * D-71, D-75, D-80 to D-87). The service never sees req/res. It also lets other modules validate a reference to a
 * screen without touching this module's tables (D-42, D-80).
 *
 * Every write runs in one `auditedTransaction` and answers errors in this order:
 * 400 (repeated values in the payload, a screen navigating to itself) -> 404 (screen, application, nested ids,
 * variables, collections and target screens) -> 422 APPLICATION_ARCHIVED -> 412 (PUT; `If-Match` is always verified)
 * -> 422 business rules, rule by rule (PUT: APP_CONTEXT_PROTECTED on rename, SCREEN_IN_REVIEW; then CROSS_APPLICATION
 * and CONTEXT_SCREEN_MISMATCH) -> 409 DUPLICATE_NAME -> the write. DELETE: 404 -> APPLICATION_ARCHIVED ->
 * APP_CONTEXT_PROTECTED -> SCREEN_IN_REVIEW. STATUS (D-88): 404 -> APPLICATION_ARCHIVED -> 412 -> INVALID_TRANSITION ->
 * TEMPLATE_INCOMPLETE, with the row locked FOR UPDATE. The rules are checked here, BEFORE writing, because the context rule is a
 * trigger deferred to COMMIT; the constraints and triggers of the database stay as a backstop.
 *
 * `PUT` replaces the whole editable representation. The nested arrays are reconciled by id (D-26, `db/reconcile`), so
 * an updated item keeps its row and its audit history; only what changes is written, and a change in any nested array
 * also moves `updated_at` of the screen (D-62). The `origin` links belong to the variables module: they are never read
 * as editable, updated or deleted here (D-84).
 *
 * @module modules/screens/service
 */
import { reconcile } from '../../db/reconcile.js';
import type { Database } from '../../db/prisma.js';
import type { AccessMode, DocumentationStatus } from '../../generated/prisma/client.js';
import { etagOf } from '../../http/etag.js';
import { INT32_MAX, assertIdInRange } from '../../http/ids.js';
import { repeatedFields } from '../../http/repeats.js';
import { E, type FieldError } from '../../security/errors.js';
import type { ApplicationService } from '../applications/service.js';
import type { CollectionService } from '../collections/service.js';
import type { VariableService } from '../variables/service.js';
import {
  assertEditable,
  initialStatus,
  planStatusChange,
  statusAfterEdit,
  TEMPLATE_FIELDS,
} from './documentationWorkflow.js';
import type { Role, TemplateContent } from './documentationWorkflow.js';
import * as repo from './repository.js';

/** Noun of the resource in messages. */
const ELEMENT = 'screen';

/** Roles of `x-roles` of `changeScreenStatus`; the contract gate already refused the others. */
const STATUS_ROLES = ['ADMINISTRATOR', 'DEVELOPER'];

/** Prefix of the temporary values that break a swap (see `db/reconcile`). */
const PARK_PREFIX = '~swap~';

/** Throws the 412 when the supplied `If-Match` differs from the ETag read inside the transaction. */
export type PreconditionCheck = (currentETag: string) => void;

/** Filters of the listing, already parsed by the controller. */
export type ListScreensInput = {
  applicationId: number;
  q?: string | undefined;
  documentationStatus?: DocumentationStatus | undefined;
  authorId?: number | undefined;
  sort: repo.ScreenListQuery['sort'];
  skip: number;
  take: number;
};

/** A use of a variable or collection in the body (contract schema `ComponentUseWrite`). */
export type UseInput = {
  id?: number | undefined;
  targetType: 'VARIABLE' | 'COLLECTION';
  targetId: number;
  description?: string | null | undefined;
};

/** A component in the body (contract schema `ComponentWrite`). */
export type ComponentInput = {
  id?: number | undefined;
  name: string;
  type: string;
  onSelect?: string | null | undefined;
  description?: string | null | undefined;
  uses?: UseInput[] | undefined;
};

/** A link to a variable in the body (contract schema `VariableLinkWrite`). */
export type VariableLinkInput = { id?: number | undefined; variableId: number; accessMode: AccessMode; usedIn: string };

/** A link to a collection in the body (contract schema `CollectionLinkWrite`). */
export type CollectionLinkInput = {
  id?: number | undefined;
  collectionId: number;
  accessMode: AccessMode;
  usedIn: string;
};

/** A navigation in the body (contract schema `NavigationWrite`). */
export type NavigationInput = {
  id?: number | undefined;
  targetScreenId: number;
  description?: string | null | undefined;
};

/** Editable representation of a screen (contract schema `ScreenWrite`). */
export type ScreenInput = {
  name: string;
  miroLink?: string | null | undefined;
  template: TemplateContent;
  components: ComponentInput[];
  variableLinks: VariableLinkInput[];
  collectionLinks: CollectionLinkInput[];
  navigations: NavigationInput[];
};

/** Body of `POST /screens` (contract schema `ScreenCreate`). */
export type CreateScreenInput = ScreenInput & { applicationId: number };

/**
 * The read-only lookup other modules use to validate a reference to a screen (D-80). It is separate from the full
 * service so Variables and Collections can be built before it without a circular dependency.
 */
export type ScreenLookup = {
  /** The screen a client points at, or `null` when it does not exist or its id cannot exist. */
  findRef(client: Pick<repo.ScreensClient, 'screen'>, id: number): Promise<repo.ScreenRef | null>;
};

/** The screens service. */
export type ScreenService = ScreenLookup & {
  list(input: ListScreensInput): Promise<{ data: repo.ScreenSummaryView[]; total: number }>;
  get(id: number): Promise<repo.ScreenView>;
  create(actorId: number, input: CreateScreenInput): Promise<repo.ScreenView>;
  update(id: number, input: ScreenInput, assertCurrent: PreconditionCheck): Promise<repo.ScreenView>;
  remove(id: number): Promise<void>;
  /** `PUT /screens/{id}/status` (D-88). */
  changeStatus(
    actor: Actor,
    id: number,
    status: RequestedStatus,
    assertCurrent: PreconditionCheck,
  ): Promise<repo.ScreenView>;
};

/** Who asks: the id and the role the authentication chain read from the database. */
export type Actor = { id: number; role: string };

/** A status a caller can ask for through `/status`: APPROVED is reached only through the review. */
export type RequestedStatus = Exclude<DocumentationStatus, 'APPROVED'>;

/** Creates the read-only screen lookup (D-80): it never writes and needs no database handle of its own. */
export function createScreenLookup(): ScreenLookup {
  return { findRef: (client, id) => (id > INT32_MAX ? Promise.resolve(null) : repo.findScreenRef(client, id)) };
}

type Tx = Parameters<Parameters<Database['auditedTransaction']>[0]>[0];
type VariableRef = NonNullable<Awaited<ReturnType<VariableService['findRef']>>>;
type CollectionRef = NonNullable<Awaited<ReturnType<CollectionService['findRef']>>>;

/** What the payload points at, resolved against the database (404 if any is missing). */
type Refs = {
  variables: Map<number, VariableRef>;
  collections: Map<number, CollectionRef>;
  screens: Map<number, repo.ScreenRef>;
};

type StoredVariableLink = { id: number; variableId: number; accessMode: AccessMode; usedIn: string };
type StoredCollectionLink = { id: number; collectionId: number; accessMode: AccessMode; usedIn: string };
type StoredDependency = { id: number; targetId: number; description: string | null };
type WantedDependency = {
  id?: number | undefined;
  targetId: number;
  targetType: repo.DependencyData['targetType'];
  description: string | null;
};
type WantedComponent = repo.ComponentData & { id?: number | undefined; uses: WantedDependency[] };

const linkKey = (elementId: number, usedIn: string): string => JSON.stringify([elementId, usedIn]);

/** D-84: repeated values in one payload and a screen navigating to itself, each with its position. */
function assertPayload(input: ScreenInput, selfId: number | undefined): void {
  const fields: FieldError[] = [
    ...repeatedFields(
      input.components,
      (c) => c.name,
      (i) => `components[${i}].name`,
    ),
    ...repeatedFields(
      input.components,
      (c) => (c.id === undefined ? undefined : String(c.id)),
      (i) => `components[${i}].id`,
    ),
  ];
  input.components.forEach((c, i) => {
    fields.push(
      ...repeatedFields(
        c.uses ?? [],
        (u) => String(u.targetId),
        (j) => `components[${i}].uses[${j}].targetId`,
      ),
      ...repeatedFields(
        c.uses ?? [],
        (u) => (u.id === undefined ? undefined : String(u.id)),
        (j) => `components[${i}].uses[${j}].id`,
      ),
    );
  });
  fields.push(
    ...repeatedFields(
      input.variableLinks,
      (l) => linkKey(l.variableId, l.usedIn),
      (i) => `variableLinks[${i}].usedIn`,
    ),
    ...repeatedFields(
      input.variableLinks,
      (l) => (l.id === undefined ? undefined : String(l.id)),
      (i) => `variableLinks[${i}].id`,
    ),
    ...repeatedFields(
      input.collectionLinks,
      (l) => linkKey(l.collectionId, l.usedIn),
      (i) => `collectionLinks[${i}].usedIn`,
    ),
    ...repeatedFields(
      input.collectionLinks,
      (l) => (l.id === undefined ? undefined : String(l.id)),
      (i) => `collectionLinks[${i}].id`,
    ),
    ...repeatedFields(
      input.navigations,
      (n) => String(n.targetScreenId),
      (i) => `navigations[${i}].targetScreenId`,
    ),
    ...repeatedFields(
      input.navigations,
      (n) => (n.id === undefined ? undefined : String(n.id)),
      (i) => `navigations[${i}].id`,
    ),
  );
  input.navigations.forEach((n, i) => {
    if (n.targetScreenId === selfId) {
      fields.push({
        field: `navigations[${i}].targetScreenId`,
        rule: 'self',
        message: 'A screen cannot navigate to itself.',
      });
    }
  });
  if (fields.length > 0) throw E.validation(fields);
}

const toData = (input: ScreenInput, documentationStatus: DocumentationStatus): repo.ScreenData => ({
  name: input.name,
  miroLink: input.miroLink ?? null,
  documentationStatus,
  ...(Object.fromEntries(TEMPLATE_FIELDS.map((f) => [f, input.template[f] ?? null])) as TemplateContent),
});

const toWantedComponents = (input: ScreenInput): WantedComponent[] =>
  input.components.map((c) => ({
    ...(c.id === undefined ? {} : { id: c.id }),
    name: c.name,
    type: c.type,
    onSelect: c.onSelect ?? null,
    description: c.description ?? null,
    uses: (c.uses ?? []).map((u) => ({
      ...(u.id === undefined ? {} : { id: u.id }),
      targetId: u.targetId,
      targetType: u.targetType,
      description: u.description ?? null,
    })),
  }));

const toWantedNavigations = (input: ScreenInput): WantedDependency[] =>
  input.navigations.map((n) => ({
    ...(n.id === undefined ? {} : { id: n.id }),
    targetId: n.targetScreenId,
    targetType: 'SCREEN' as const,
    description: n.description ?? null,
  }));

/**
 * Creates the screens service.
 *
 * @param db - Database connected as docs_app.
 * @param applications - Applications service (existence, name and the archived-application guard).
 * @param variables - Variables service (scope, application and origin of the linked variables).
 * @param collections - Collections service (application of the linked collections).
 */
export function createScreenService(
  db: Pick<Database, 'base' | 'prisma' | 'auditedTransaction'>,
  applications: Pick<ApplicationService, 'get' | 'assertApplicationActive'>,
  variables: Pick<VariableService, 'findRef'>,
  collections: Pick<CollectionService, 'findRef'>,
): ScreenService {
  const lookup = createScreenLookup();

  /** 404 for every nested id of the body that is not an editable row of this screen (D-75, D-84). */
  const assertNestedIds = (input: ScreenInput, current: repo.ScreenView): void => {
    const components = new Map(current.components.map((c) => [c.id, c]));
    input.components.forEach((c, i) => {
      if (c.id !== undefined && !components.has(c.id)) throw E.notFound('component', c.id, `components[${i}].id`);
    });
    input.components.forEach((c, i) => {
      const own = c.id === undefined ? undefined : components.get(c.id);
      (c.uses ?? []).forEach((u, j) => {
        if (u.id !== undefined && !own?.uses.some((x) => x.id === u.id)) {
          throw E.notFound('component use', u.id, `components[${i}].uses[${j}].id`);
        }
      });
    });
    const variableLinks = new Set(current.variableLinks.filter((l) => !l.isOrigin).map((l) => l.id));
    input.variableLinks.forEach((l, i) => {
      if (l.id !== undefined && !variableLinks.has(l.id))
        throw E.notFound('variable link', l.id, `variableLinks[${i}].id`);
    });
    const collectionLinks = new Set(current.collectionLinks.map((l) => l.id));
    input.collectionLinks.forEach((l, i) => {
      if (l.id !== undefined && !collectionLinks.has(l.id)) {
        throw E.notFound('collection link', l.id, `collectionLinks[${i}].id`);
      }
    });
    const navigations = new Set(current.navigations.map((n) => n.id));
    input.navigations.forEach((n, i) => {
      if (n.id !== undefined && !navigations.has(n.id)) throw E.notFound('navigation', n.id, `navigations[${i}].id`);
    });
  };

  /** 404 for everything the payload points at that does not exist; reads the variables and collections FOR SHARE. */
  const resolveRefs = async (tx: Tx, input: ScreenInput, current: repo.ScreenView | null): Promise<Refs> => {
    if (current !== null) assertNestedIds(input, current);
    const refs: Refs = { variables: new Map(), collections: new Map(), screens: new Map() };
    const variable = async (id: number, field: string): Promise<void> => {
      if (refs.variables.has(id)) return;
      const found = await variables.findRef(tx, id);
      if (!found) throw E.notFound('variable', id, field);
      refs.variables.set(id, found);
    };
    const collection = async (id: number, field: string): Promise<void> => {
      if (refs.collections.has(id)) return;
      const found = await collections.findRef(tx, id);
      if (!found) throw E.notFound('collection', id, field);
      refs.collections.set(id, found);
    };
    for (const [i, l] of input.variableLinks.entries()) await variable(l.variableId, `variableLinks[${i}].variableId`);
    for (const [i, l] of input.collectionLinks.entries()) {
      await collection(l.collectionId, `collectionLinks[${i}].collectionId`);
    }
    for (const [i, c] of input.components.entries()) {
      for (const [j, u] of (c.uses ?? []).entries()) {
        const field = `components[${i}].uses[${j}].targetId`;
        await (u.targetType === 'VARIABLE' ? variable(u.targetId, field) : collection(u.targetId, field));
      }
    }
    for (const [i, n] of input.navigations.entries()) {
      if (refs.screens.has(n.targetScreenId)) continue;
      const found = await lookup.findRef(tx, n.targetScreenId);
      if (!found) throw E.notFound(ELEMENT, n.targetScreenId, `navigations[${i}].targetScreenId`);
      refs.screens.set(n.targetScreenId, found);
    }
    return refs;
  };

  /** Indexes of the links the rules must judge (D-85): all on create, only new or modified ones on update. */
  const changedLinks = <T extends { id?: number | undefined }, S extends { id: number }>(
    wanted: readonly T[],
    stored: readonly S[],
    same: (w: T, s: S) => boolean,
  ): Set<number> => {
    const byId = new Map(stored.map((s) => [s.id, s]));
    const changed = new Set<number>();
    wanted.forEach((w, i) => {
      const before = w.id === undefined ? undefined : byId.get(w.id);
      if (before === undefined || !same(w, before)) changed.add(i);
    });
    return changed;
  };

  /** CROSS_APPLICATION, then CONTEXT_SCREEN_MISMATCH, rule by rule over the payload (D-84, D-85). */
  const assertLinkRules = (
    scope: { applicationId: number; screenId: number | null; screenName: string },
    input: ScreenInput,
    refs: Refs,
    current: repo.ScreenView | null,
  ): void => {
    const stored = current?.variableLinks.filter((l) => !l.isOrigin) ?? [];
    const changedVariables = changedLinks(
      input.variableLinks,
      stored.map((l) => ({ id: l.id, variableId: l.variable.id, accessMode: l.accessMode, usedIn: l.usedIn })),
      (w, s) => w.variableId === s.variableId && w.accessMode === s.accessMode && w.usedIn === s.usedIn,
    );
    const changedCollections = changedLinks(
      input.collectionLinks,
      (current?.collectionLinks ?? []).map((l) => ({
        id: l.id,
        collectionId: l.collection.id,
        accessMode: l.accessMode,
        usedIn: l.usedIn,
      })),
      (w, s) => w.collectionId === s.collectionId && w.accessMode === s.accessMode && w.usedIn === s.usedIn,
    );

    input.variableLinks.forEach((l, i) => {
      if (changedVariables.has(i) && refs.variables.get(l.variableId)!.applicationId !== scope.applicationId) {
        throw E.crossApplication(`variableLinks[${i}].variableId`);
      }
    });
    input.collectionLinks.forEach((l, i) => {
      if (changedCollections.has(i) && refs.collections.get(l.collectionId)!.applicationId !== scope.applicationId) {
        throw E.crossApplication(`collectionLinks[${i}].collectionId`);
      }
    });
    input.navigations.forEach((n, i) => {
      if (refs.screens.get(n.targetScreenId)!.applicationId !== scope.applicationId) {
        throw E.crossApplication(`navigations[${i}].targetScreenId`);
      }
    });
    input.components.forEach((c, i) => {
      (c.uses ?? []).forEach((u, j) => {
        const target = u.targetType === 'VARIABLE' ? refs.variables.get(u.targetId) : refs.collections.get(u.targetId);
        if (target!.applicationId !== scope.applicationId)
          throw E.crossApplication(`components[${i}].uses[${j}].targetId`);
      });
    });

    // A context variable belongs to its origin screen: elsewhere it only admits WRITE (D-52, D-64).
    input.variableLinks.forEach((l, i) => {
      if (!changedVariables.has(i)) return;
      const variable = refs.variables.get(l.variableId)!;
      if (variable.scope !== 'CONTEXT') return;
      const origin = variable.originScreen;
      if (origin !== null && (origin.id === scope.screenId || l.accessMode === 'WRITE')) return;
      throw E.contextScreenMismatch({
        variableId: variable.id,
        variable: variable.name,
        originScreenId: origin?.id ?? null,
        originScreen: origin?.name ?? null,
        screenId: scope.screenId,
        targetScreen: scope.screenName,
        field: `variableLinks[${i}].variableId`,
      });
    });
  };

  /** DUPLICATE_NAME (D-63): the name must be free in the application. */
  const assertNameFree = async (
    tx: Tx,
    application: { id: number; name: string },
    name: string,
    exceptId: number | undefined,
  ): Promise<void> => {
    if (await repo.nameIsTaken(tx, { applicationId: application.id, name }, exceptId)) {
      throw E.duplicateName(ELEMENT, name, application.name, 'application');
    }
  };

  /** Dependencies (uses, navigations): reconciled by id; a swap of targets re-creates ONE row (D-86). */
  const reconcileDependencies = (
    tx: Tx,
    source: { id: number; type: 'COMPONENT' | 'SCREEN' },
    relation: 'USES' | 'NAVIGATES_TO',
    current: StoredDependency[],
    wanted: WantedDependency[],
  ) => {
    const data = (w: WantedDependency): repo.DependencyData => ({
      targetId: w.targetId,
      targetType: w.targetType,
      description: w.description,
    });
    const deletedWhileParking = new Set<number>();
    return reconcile<StoredDependency, WantedDependency>(current, wanted, {
      keyOf: (d) => String(d.targetId),
      isSame: (c, w) => c.targetId === w.targetId && c.description === w.description,
      remove: (ids) => repo.deleteDependencies(tx, ids),
      update: (c, w) =>
        deletedWhileParking.has(c.id)
          ? repo.createDependency(tx, source, relation, data(w))
          : repo.updateDependency(tx, c.id, data(w)),
      create: (w) => repo.createDependency(tx, source, relation, data(w)),
      // A target has no valid temporary value: the parked row is deleted and re-created later (D-86).
      park: (c) => ({
        key: `${PARK_PREFIX}${c.id}`,
        write: async () => {
          deletedWhileParking.add(c.id);
          await repo.deleteDependencies(tx, [c.id]);
        },
      }),
    });
  };

  const createComponentWithUses = async (
    tx: Tx,
    screen: { id: number; applicationId: number },
    w: WantedComponent,
  ): Promise<number> => {
    const id = await repo.createComponent(tx, screen.applicationId, screen.id, {
      name: w.name,
      type: w.type,
      onSelect: w.onSelect,
      description: w.description,
    });
    for (const use of w.uses) {
      await repo.createDependency(tx, { id, type: 'COMPONENT' }, 'USES', {
        targetId: use.targetId,
        targetType: use.targetType,
        description: use.description,
      });
    }
    return id;
  };

  /** Components: reconciled by id; the temporary name of a swap respects VARCHAR(150) and is never blank. */
  const reconcileComponents = (
    tx: Tx,
    screen: { id: number; applicationId: number },
    current: repo.ComponentView[],
    wanted: WantedComponent[],
  ) =>
    reconcile<repo.ComponentView, WantedComponent>(current, wanted, {
      keyOf: (c) => c.name,
      isSame: (c, w) =>
        c.name === w.name && c.type === w.type && c.onSelect === w.onSelect && c.description === w.description,
      remove: (ids) => repo.deleteComponents(tx, ids),
      update: (c, w) =>
        repo.updateComponent(tx, c.id, {
          name: w.name,
          type: w.type,
          onSelect: w.onSelect,
          description: w.description,
        }),
      create: async (w) => {
        await createComponentWithUses(tx, screen, w);
      },
      park: (c, taken) => {
        let n = 1;
        let name = `${PARK_PREFIX}${c.id}~${n}`;
        while (taken.has(name)) name = `${PARK_PREFIX}${c.id}~${(n += 1)}`;
        return { key: name, write: () => repo.updateComponent(tx, c.id, { name }) };
      },
    });

  /** Links to variables (never the `origin` rows): reconciled by id; the temporary `usedIn` is never blank. */
  const reconcileVariableLinks = (tx: Tx, screenId: number, current: StoredVariableLink[], input: ScreenInput) =>
    reconcile<StoredVariableLink, VariableLinkInput>(current, input.variableLinks, {
      keyOf: (l) => linkKey(l.variableId, l.usedIn),
      isSame: (c, w) => c.variableId === w.variableId && c.accessMode === w.accessMode && c.usedIn === w.usedIn,
      remove: (ids) => repo.deleteVariableLinks(tx, ids),
      update: (c, w) =>
        repo.updateVariableLink(tx, c.id, { variableId: w.variableId, accessMode: w.accessMode, usedIn: w.usedIn }),
      create: (w) =>
        repo.createVariableLinks(tx, screenId, [
          { variableId: w.variableId, accessMode: w.accessMode, usedIn: w.usedIn },
        ]),
      park: (c, taken) => {
        let n = 1;
        let usedIn = `${PARK_PREFIX}${c.id}~${n}`;
        while (taken.has(linkKey(c.variableId, usedIn))) usedIn = `${PARK_PREFIX}${c.id}~${(n += 1)}`;
        return { key: linkKey(c.variableId, usedIn), write: () => repo.updateVariableLink(tx, c.id, { usedIn }) };
      },
    });

  const reconcileCollectionLinks = (tx: Tx, screenId: number, current: StoredCollectionLink[], input: ScreenInput) =>
    reconcile<StoredCollectionLink, CollectionLinkInput>(current, input.collectionLinks, {
      keyOf: (l) => linkKey(l.collectionId, l.usedIn),
      isSame: (c, w) => c.collectionId === w.collectionId && c.accessMode === w.accessMode && c.usedIn === w.usedIn,
      remove: (ids) => repo.deleteCollectionLinks(tx, ids),
      update: (c, w) =>
        repo.updateCollectionLink(tx, c.id, {
          collectionId: w.collectionId,
          accessMode: w.accessMode,
          usedIn: w.usedIn,
        }),
      create: (w) =>
        repo.createCollectionLinks(tx, screenId, [
          { collectionId: w.collectionId, accessMode: w.accessMode, usedIn: w.usedIn },
        ]),
      park: (c, taken) => {
        let n = 1;
        let usedIn = `${PARK_PREFIX}${c.id}~${n}`;
        while (taken.has(linkKey(c.collectionId, usedIn))) usedIn = `${PARK_PREFIX}${c.id}~${(n += 1)}`;
        return { key: linkKey(c.collectionId, usedIn), write: () => repo.updateCollectionLink(tx, c.id, { usedIn }) };
      },
    });

  return {
    async list(input) {
      // D-70: the parent application must exist (404); an id used as a filter that cannot match gives an empty page.
      assertIdInRange(input.applicationId, 'application');
      await applications.get(input.applicationId);
      if (input.authorId !== undefined && input.authorId > INT32_MAX) return { data: [], total: 0 };
      const [data, total] = await repo.listScreens(db.base, input);
      return { data, total };
    },

    findRef: (client, id) => lookup.findRef(client, id),

    async get(id) {
      const screen = await repo.findScreenById(db.base, id);
      if (!screen) throw E.notFound(ELEMENT, id);
      return screen;
    },

    async create(actorId, input) {
      assertPayload(input, undefined);
      assertIdInRange(input.applicationId, 'application');
      const application = await applications.get(input.applicationId);
      return db.auditedTransaction(async (tx) => {
        const refs = await resolveRefs(tx, input, null);
        await applications.assertApplicationActive(tx, application.id);
        assertLinkRules({ applicationId: application.id, screenId: null, screenName: input.name }, input, refs, null);
        await assertNameFree(tx, application, input.name, undefined);

        const id = await repo.createScreenRow(
          tx,
          application.id,
          actorId,
          toData(input, initialStatus(input.template)),
        );
        for (const component of toWantedComponents(input)) {
          await createComponentWithUses(tx, { id, applicationId: application.id }, component);
        }
        await repo.createVariableLinks(
          tx,
          id,
          input.variableLinks.map((l) => ({ variableId: l.variableId, accessMode: l.accessMode, usedIn: l.usedIn })),
        );
        await repo.createCollectionLinks(
          tx,
          id,
          input.collectionLinks.map((l) => ({
            collectionId: l.collectionId,
            accessMode: l.accessMode,
            usedIn: l.usedIn,
          })),
        );
        for (const navigation of toWantedNavigations(input)) {
          await repo.createDependency(tx, { id, type: 'SCREEN' }, 'NAVIGATES_TO', {
            targetId: navigation.targetId,
            targetType: 'SCREEN',
            description: navigation.description,
          });
        }
        const created = await repo.findScreenById(tx, id);
        if (!created) throw new Error(`screen ${id} vanished inside its own transaction`);
        return created;
      });
    },

    async update(id, input, assertCurrent) {
      assertPayload(input, id);
      return db.auditedTransaction(async (tx) => {
        if (!(await repo.lockScreenForUpdate(tx, id))) throw E.notFound(ELEMENT, id);
        const current = await repo.findScreenById(tx, id);
        if (!current) throw E.notFound(ELEMENT, id);
        const application = await applications.get(current.applicationId);
        const refs = await resolveRefs(tx, input, current);
        await applications.assertApplicationActive(tx, current.applicationId);
        assertCurrent(etagOf(current));

        // Business rules, in the order of D-84 and D-87.
        if (current.isAppContext && input.name !== current.name) throw E.appContextProtected('rename');
        assertEditable(current.documentationStatus);
        assertLinkRules(
          { applicationId: current.applicationId, screenId: id, screenName: input.name },
          input,
          refs,
          current,
        );

        const wanted = toData(input, current.documentationStatus);
        const changes: Partial<repo.ScreenData> = {};
        if (wanted.name !== current.name) changes.name = wanted.name;
        if (wanted.miroLink !== current.miroLink) changes.miroLink = wanted.miroLink;
        for (const field of TEMPLATE_FIELDS) {
          if (wanted[field] !== current.template[field]) changes[field] = wanted[field];
        }
        if (changes.name !== undefined) await assertNameFree(tx, application, wanted.name, id);

        // From here on, writes. Nothing that does not change is written.
        const screen = { id, applicationId: current.applicationId };
        const wantedComponents = toWantedComponents(input);
        const results = [await reconcileComponents(tx, screen, current.components, wantedComponents)];
        for (const w of wantedComponents) {
          const own = w.id === undefined ? undefined : current.components.find((c) => c.id === w.id);
          if (own === undefined) continue;
          results.push(
            await reconcileDependencies(
              tx,
              { id: own.id, type: 'COMPONENT' },
              'USES',
              own.uses.map((u) => ({ id: u.id, targetId: u.target.id, description: u.description })),
              w.uses,
            ),
          );
        }
        results.push(
          await reconcileVariableLinks(
            tx,
            id,
            current.variableLinks
              .filter((l) => !l.isOrigin)
              .map((l) => ({ id: l.id, variableId: l.variable.id, accessMode: l.accessMode, usedIn: l.usedIn })),
            input,
          ),
          await reconcileCollectionLinks(
            tx,
            id,
            current.collectionLinks.map((l) => ({
              id: l.id,
              collectionId: l.collection.id,
              accessMode: l.accessMode,
              usedIn: l.usedIn,
            })),
            input,
          ),
          await reconcileDependencies(
            tx,
            { id, type: 'SCREEN' },
            'NAVIGATES_TO',
            current.navigations.map((n) => ({ id: n.id, targetId: n.targetScreen.id, description: n.description })),
            toWantedNavigations(input),
          ),
        );

        const nestedChanged = results.some((r) => r.deleted + r.updated + r.created > 0);
        const changed = Object.keys(changes).length > 0 || nestedChanged;
        if (!changed) return current; // D-71: nothing was written
        const status = statusAfterEdit(current.documentationStatus, {
          before: current.template,
          after: input.template,
          changed,
        });
        if (status !== current.documentationStatus) changes.documentationStatus = status;
        if (Object.keys(changes).length > 0) await repo.updateScreenColumns(tx, id, changes);
        else await repo.touchScreen(tx, id);
        const updated = await repo.findScreenById(tx, id);
        if (!updated) throw new Error(`screen ${id} vanished inside its own transaction`);
        return updated;
      });
    },

    async remove(id) {
      await db.auditedTransaction(async (tx) => {
        const current = await repo.lockScreenForUpdate(tx, id);
        if (!current) throw E.notFound(ELEMENT, id);
        await applications.assertApplicationActive(tx, current.applicationId);
        if (current.isAppContext) throw E.appContextProtected();
        assertEditable(current.documentationStatus); // D-82
        await repo.deleteScreenRow(tx, id);
      });
    },

    async changeStatus(actor, id, status, assertCurrent) {
      return db.auditedTransaction(async (tx) => {
        if (!(await repo.lockScreenForUpdate(tx, id))) throw E.notFound(ELEMENT, id);
        const current = await repo.findScreenById(tx, id);
        if (!current) throw E.notFound(ELEMENT, id);
        await applications.assertApplicationActive(tx, current.applicationId);
        assertCurrent(etagOf(current));

        const outcome = planStatusChange(current.documentationStatus, status, actor.role as Role, current.template);
        if (!outcome.ok) {
          if (outcome.code === 'TEMPLATE_INCOMPLETE') throw E.templateIncomplete(outcome.fields);
          if (outcome.code === 'FORBIDDEN') throw E.forbidden(STATUS_ROLES);
          throw E.invalidTransition(current.documentationStatus, status);
        }
        await repo.updateScreenColumns(tx, id, { documentationStatus: outcome.to });
        const updated = await repo.findScreenById(tx, id);
        if (!updated) throw new Error(`screen ${id} vanished inside its own transaction`);
        return updated;
      });
    },
  };
}
