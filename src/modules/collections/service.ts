/**
 * Collection rules (FR-08, FR-09; SDD Table 49, D-14, D-26, D-29, D-47, D-62 to D-65, D-70, D-74 to D-76). The
 * service never sees req/res.
 *
 * Every write runs in one `auditedTransaction` and answers errors in this order:
 * 400 (repeated values in the payload, a collection derived from itself) -> 404 (collection, application, nested ids,
 * variable, screen, source of a derivation) -> 422 APPLICATION_ARCHIVED -> 412 (PUT; `If-Match` is always verified) ->
 * 422 business rules (CROSS_APPLICATION, SCOPE_MISMATCH, CONTEXT_SCREEN_MISMATCH, rule by rule over the payload) ->
 * 409 DUPLICATE_NAME -> the write. The rules and the duplicate are checked here, BEFORE writing, because the context
 * rule is a trigger deferred to COMMIT and the unique index would fire first and invert the order; the constraints and
 * triggers of the database stay as a backstop (translated by the errorHandler).
 *
 * `PUT` replaces the whole editable representation: an array left out of the body is an empty array. The nested
 * arrays are reconciled by id (D-26, `db/reconcile`), so an updated item keeps its row and its audit history; only
 * what changes is written, and a change in any nested array also moves `updated_at` of the collection (D-62).
 *
 * @module modules/collections/service
 */
import { reconcile } from '../../db/reconcile.js';
import type { Database } from '../../db/prisma.js';
import type { AssignmentFunction, DataType, Environment } from '../../generated/prisma/client.js';
import { etagOf } from '../../http/etag.js';
import { INT32_MAX, assertIdInRange } from '../../http/ids.js';
import { repeatedFields } from '../../http/repeats.js';
import { E, type FieldError } from '../../security/errors.js';
import { type ApplicationService } from '../applications/service.js';
import type { ScreenLookup } from '../screens/service.js';
import type { VariableService } from '../variables/service.js';
import * as repo from './repository.js';

/** Noun of the resource in messages. */
const ELEMENT = 'collection';

/** Prefix of the temporary values that break a swap (see `db/reconcile`). */
const PARK_PREFIX = '~swap~';

/** Throws the 412 when the supplied `If-Match` differs from the ETag read inside the transaction. */
export type PreconditionCheck = (currentETag: string) => void;

/** Filters of the listing, already parsed by the controller. */
export type ListCollectionsInput = {
  applicationId: number;
  q?: string | undefined;
  environment?: Environment | undefined;
  undocumented?: boolean | undefined;
  sort: repo.CollectionListQuery['sort'];
  skip: number;
  take: number;
};

/** A field in the body (contract schema `CollectionFieldWrite`). */
export type FieldInput = {
  id?: number | undefined;
  name: string;
  dataType: DataType;
  description?: string | null | undefined;
  position?: number | undefined;
};

/** An assignment in the body (contract schema `VariableAssignmentWrite`). */
export type AssignmentInput = {
  id?: number | undefined;
  variableId: number;
  screenId: number;
  assignmentFunction: AssignmentFunction;
  tableFunction?: string | null | undefined;
  usedIn: string;
};

/** Editable representation of a collection (contract schema `CollectionWrite`). */
export type CollectionInput = {
  name: string;
  creationCondition?: string | null | undefined;
  description?: string | null | undefined;
  environments: { environment: Environment; notes?: string | null | undefined }[];
  fields?: FieldInput[] | undefined;
  variableAssignments?: AssignmentInput[] | undefined;
  derivedFrom?: number[] | undefined;
};

/** Body of `POST /collections` (contract schema `CollectionCreate`). */
export type CreateCollectionInput = CollectionInput & { applicationId: number };

/** The collections service. */
export type CollectionService = {
  list(input: ListCollectionsInput): Promise<{ data: repo.CollectionSummaryView[]; total: number }>;
  get(id: number): Promise<repo.CollectionView>;
  listFields(id: number, skip: number, take: number): Promise<{ data: repo.FieldView[]; total: number }>;
  create(input: CreateCollectionInput): Promise<repo.CollectionView>;
  update(id: number, input: CollectionInput, assertCurrent: PreconditionCheck): Promise<repo.CollectionView>;
  remove(id: number): Promise<void>;
};

type Tx = Parameters<Parameters<Database['auditedTransaction']>[0]>[0];

/** A stored or wanted assignment, flat. */
type AssignmentRow = {
  id?: number | undefined;
  variableId: number;
  screenId: number;
  assignmentFunction: AssignmentFunction;
  tableFunction: string | null;
  usedIn: string;
};
type StoredAssignment = AssignmentRow & { id: number };
type WantedField = repo.FieldData & { id?: number | undefined };

type VariableRef = NonNullable<Awaited<ReturnType<VariableService['findRef']>>>;

/** What the payload points at, resolved against the database (404 if any is missing). */
type Refs = {
  variables: Map<number, VariableRef>;
  screens: Map<number, { id: number; name: string; applicationId: number }>;
  derived: Map<number, repo.CollectionRef>;
};

const assignmentKey = (a: Pick<AssignmentRow, 'variableId' | 'screenId' | 'usedIn'>): string =>
  JSON.stringify([a.variableId, a.screenId, a.usedIn]);

/** D-65, D-74: repeated values in one payload and a collection derived from itself, each with its position. */
function assertPayload(input: CollectionInput, selfId: number | undefined): void {
  const fields: FieldError[] = [
    ...repeatedFields(
      input.environments,
      (e) => e.environment,
      (i) => `environments[${i}].environment`,
    ),
    ...repeatedFields(
      input.fields ?? [],
      (f) => f.name,
      (i) => `fields[${i}].name`,
    ),
    ...repeatedFields(
      input.fields ?? [],
      (f) => (f.id === undefined ? undefined : String(f.id)),
      (i) => `fields[${i}].id`,
    ),
    ...repeatedFields(input.variableAssignments ?? [], assignmentKey, (i) => `variableAssignments[${i}].usedIn`),
    ...repeatedFields(
      input.variableAssignments ?? [],
      (a) => (a.id === undefined ? undefined : String(a.id)),
      (i) => `variableAssignments[${i}].id`,
    ),
    ...repeatedFields(
      input.derivedFrom ?? [],
      (id) => String(id),
      (i) => `derivedFrom[${i}]`,
    ),
  ];
  (input.derivedFrom ?? []).forEach((id, i) => {
    if (id === selfId) {
      fields.push({ field: `derivedFrom[${i}]`, rule: 'self', message: 'A collection cannot derive from itself.' });
    }
  });
  if (fields.length > 0) throw E.validation(fields);
}

const toColumns = (input: CollectionInput): repo.CollectionData => ({
  name: input.name,
  creationCondition: input.creationCondition ?? null,
  description: input.description ?? null,
});

const toEnvironments = (input: CollectionInput): repo.EnvironmentInput[] =>
  [...input.environments]
    .map((e) => ({ environment: e.environment, notes: e.notes ?? null }))
    .sort((a, b) => a.environment.localeCompare(b.environment));

/** `position` defaults to the order of the array (contract). */
const toWantedFields = (input: CollectionInput): WantedField[] =>
  (input.fields ?? []).map((f, index) => ({
    ...(f.id === undefined ? {} : { id: f.id }),
    name: f.name,
    dataType: f.dataType,
    description: f.description ?? null,
    position: f.position ?? index,
  }));

const toWantedAssignments = (input: CollectionInput): AssignmentRow[] =>
  (input.variableAssignments ?? []).map((a) => ({
    ...(a.id === undefined ? {} : { id: a.id }),
    variableId: a.variableId,
    screenId: a.screenId,
    assignmentFunction: a.assignmentFunction,
    tableFunction: a.tableFunction ?? null,
    usedIn: a.usedIn,
  }));

/**
 * Creates the collections service.
 *
 * @param db - Database connected as docs_app.
 * @param applications - Applications service (existence, name and the archived-application guard).
 * @param screens - Screens service (existence and application of the screens of the assignments).
 * @param variables - Variables service (scope, application and origin of the assigned variables).
 */
export function createCollectionService(
  db: Pick<Database, 'base' | 'prisma' | 'auditedTransaction'>,
  applications: Pick<ApplicationService, 'get' | 'assertApplicationActive'>,
  screens: ScreenLookup,
  variables: Pick<VariableService, 'findRef'>,
): CollectionService {
  /** 404 for everything the payload points at that does not exist (D-75: with the position of the id). */
  const resolveRefs = async (tx: Tx, input: CollectionInput, current: repo.CollectionView | null): Promise<Refs> => {
    if (current !== null) {
      const fieldIds = new Set(current.fields.map((f) => f.id));
      (input.fields ?? []).forEach((f, i) => {
        if (f.id !== undefined && !fieldIds.has(f.id)) throw E.notFound('collection field', f.id, `fields[${i}].id`);
      });
      const assignmentIds = new Set(current.variableAssignments.map((a) => a.id));
      (input.variableAssignments ?? []).forEach((a, i) => {
        if (a.id !== undefined && !assignmentIds.has(a.id)) {
          throw E.notFound('variable assignment', a.id, `variableAssignments[${i}].id`);
        }
      });
    }
    const refs: Refs = { variables: new Map(), screens: new Map(), derived: new Map() };
    const assignments = input.variableAssignments ?? [];
    for (const [i, a] of assignments.entries()) {
      if (!refs.variables.has(a.variableId)) {
        const variable = await variables.findRef(tx, a.variableId);
        if (!variable) throw E.notFound('variable', a.variableId, `variableAssignments[${i}].variableId`);
        refs.variables.set(a.variableId, variable);
      }
      if (!refs.screens.has(a.screenId)) {
        const screen = await screens.findRef(tx, a.screenId);
        if (!screen) throw E.notFound('screen', a.screenId, `variableAssignments[${i}].screenId`);
        refs.screens.set(a.screenId, screen);
      }
    }
    for (const [i, id] of (input.derivedFrom ?? []).entries()) {
      const source = id > INT32_MAX ? null : await repo.findCollectionRef(tx, id);
      if (!source) throw E.notFound(ELEMENT, id, `derivedFrom[${i}]`);
      refs.derived.set(id, source);
    }
    return refs;
  };

  /**
   * The 422 rules of the payload, rule by rule and each one over the array in order (D-76): CROSS_APPLICATION, then
   * SCOPE_MISMATCH, then CONTEXT_SCREEN_MISMATCH. The first item that fails is reported with its position.
   */
  const assertRules = (applicationId: number, input: CollectionInput, refs: Refs): void => {
    const assignments = input.variableAssignments ?? [];
    assignments.forEach((a, i) => {
      if (refs.variables.get(a.variableId)!.applicationId !== applicationId) {
        throw E.crossApplication(`variableAssignments[${i}].variableId`);
      }
      if (refs.screens.get(a.screenId)!.applicationId !== applicationId) {
        throw E.crossApplication(`variableAssignments[${i}].screenId`);
      }
    });
    (input.derivedFrom ?? []).forEach((id, i) => {
      if (refs.derived.get(id)!.applicationId !== applicationId) throw E.crossApplication(`derivedFrom[${i}]`);
    });
    // The scope is the one the database has for the variable, never the client's.
    assignments.forEach((a, i) => {
      const expected: AssignmentFunction =
        refs.variables.get(a.variableId)!.scope === 'GLOBAL' ? 'SET' : 'UPDATE_CONTEXT';
      if (a.assignmentFunction !== expected) {
        throw E.scopeMismatch(`variableAssignments[${i}].assignmentFunction`);
      }
    });
    assignments.forEach((a, i) => {
      const variable = refs.variables.get(a.variableId)!;
      if (variable.scope !== 'CONTEXT') return;
      const origin = variable.originScreen;
      if (origin !== null && origin.id === a.screenId) return;
      throw E.contextScreenMismatch({
        variableId: variable.id,
        variable: variable.name,
        originScreenId: origin?.id ?? null,
        originScreen: origin?.name ?? null,
        screenId: a.screenId,
        targetScreen: refs.screens.get(a.screenId)!.name,
        field: `variableAssignments[${i}].screenId`,
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

  /** Fields: reconciled by id; the temporary name of a swap respects VARCHAR(150) and is never blank. */
  const reconcileFields = (tx: Tx, collectionId: number, current: repo.FieldView[], wanted: WantedField[]) =>
    reconcile<repo.FieldView, WantedField>(current, wanted, {
      keyOf: (f) => f.name,
      isSame: (c, w) =>
        c.name === w.name && c.dataType === w.dataType && c.description === w.description && c.position === w.position,
      remove: (ids) => repo.deleteFields(tx, ids),
      update: (c, w) =>
        repo.updateField(tx, c.id, {
          name: w.name,
          dataType: w.dataType,
          description: w.description,
          position: w.position,
        }),
      create: (w) =>
        repo.createField(tx, collectionId, {
          name: w.name,
          dataType: w.dataType,
          description: w.description,
          position: w.position,
        }),
      park: (c, taken) => {
        let n = 1;
        let name = `${PARK_PREFIX}${c.id}~${n}`;
        while (taken.has(name)) name = `${PARK_PREFIX}${c.id}~${(n += 1)}`;
        return { key: name, write: () => repo.updateField(tx, c.id, { name }) };
      },
    });

  /** Assignments: reconciled by id; the temporary `usedIn` respects VARCHAR(200) and is never blank. */
  const reconcileAssignments = (
    tx: Tx,
    collectionId: number,
    current: StoredAssignment[],
    wanted: AssignmentRow[],
    refs: Refs,
  ) => {
    const data = (w: AssignmentRow): repo.AssignmentData => ({
      variableId: w.variableId,
      variableScope: refs.variables.get(w.variableId)!.scope,
      screenId: w.screenId,
      assignmentFunction: w.assignmentFunction,
      tableFunction: w.tableFunction,
      usedIn: w.usedIn,
    });
    return reconcile<StoredAssignment, AssignmentRow>(current, wanted, {
      keyOf: assignmentKey,
      isSame: (c, w) =>
        c.variableId === w.variableId &&
        c.screenId === w.screenId &&
        c.assignmentFunction === w.assignmentFunction &&
        c.tableFunction === w.tableFunction &&
        c.usedIn === w.usedIn,
      remove: (ids) => repo.deleteAssignments(tx, ids),
      update: (c, w) => repo.updateAssignment(tx, c.id, data(w)),
      create: (w) => repo.createAssignment(tx, collectionId, data(w)),
      park: (c, taken) => {
        let n = 1;
        let usedIn = `${PARK_PREFIX}${c.id}~${n}`;
        while (taken.has(assignmentKey({ ...c, usedIn }))) usedIn = `${PARK_PREFIX}${c.id}~${(n += 1)}`;
        return { key: assignmentKey({ ...c, usedIn }), write: () => repo.updateAssignment(tx, c.id, { usedIn }) };
      },
    });
  };

  /** Derivations (D-74): a set of target collections, reconciled by difference. Returns whether something changed. */
  const reconcileDerivations = async (
    tx: Tx,
    collectionId: number,
    current: number[],
    wanted: number[],
  ): Promise<boolean> => {
    const gone = current.filter((id) => !wanted.includes(id));
    const added = wanted.filter((id) => !current.includes(id));
    if (gone.length > 0) await repo.deleteDerivations(tx, collectionId, gone);
    for (const id of added) await repo.createDerivation(tx, collectionId, id);
    return gone.length + added.length > 0;
  };

  return {
    async list(input) {
      // D-70: the parent application must exist (404).
      assertIdInRange(input.applicationId, 'application');
      await applications.get(input.applicationId);
      const [data, total] = await repo.listCollections(db.base, input);
      return { data, total };
    },

    async get(id) {
      const collection = await repo.findCollectionById(db.base, id);
      if (!collection) throw E.notFound(ELEMENT, id);
      return collection;
    },

    async listFields(id, skip, take) {
      if (!(await repo.findCollectionRef(db.base, id))) throw E.notFound(ELEMENT, id);
      const [data, total] = await repo.listFields(db.base, id, skip, take);
      return { data, total };
    },

    async create(input) {
      assertPayload(input, undefined);
      assertIdInRange(input.applicationId, 'application');
      const application = await applications.get(input.applicationId);
      const columns = toColumns(input);
      return db.auditedTransaction(async (tx) => {
        const refs = await resolveRefs(tx, input, null);
        await applications.assertApplicationActive(tx, application.id);
        assertRules(application.id, input, refs);
        await assertNameFree(tx, application, columns.name, undefined);
        const assignments = toWantedAssignments(input).map((a) => ({
          variableId: a.variableId,
          variableScope: refs.variables.get(a.variableId)!.scope,
          screenId: a.screenId,
          assignmentFunction: a.assignmentFunction,
          tableFunction: a.tableFunction,
          usedIn: a.usedIn,
        }));
        const id = await repo.createCollection(
          tx,
          application.id,
          columns,
          toEnvironments(input),
          toWantedFields(input).map(({ id: _id, ...field }) => field),
          assignments,
          input.derivedFrom ?? [],
        );
        const created = await repo.findCollectionById(tx, id);
        if (!created) throw new Error(`collection ${id} vanished inside its own transaction`);
        return created;
      });
    },

    async update(id, input, assertCurrent) {
      assertPayload(input, id);
      const columns = toColumns(input);
      return db.auditedTransaction(async (tx) => {
        await repo.lockCollectionForUpdate(tx, id);
        const current = await repo.findCollectionById(tx, id);
        if (!current) throw E.notFound(ELEMENT, id);
        const application = await applications.get(current.applicationId);
        const refs = await resolveRefs(tx, input, current);
        await applications.assertApplicationActive(tx, current.applicationId);
        assertCurrent(etagOf(current));
        assertRules(current.applicationId, input, refs);

        const changes: Partial<repo.CollectionData> = {};
        if (columns.name !== current.name) changes.name = columns.name;
        if (columns.creationCondition !== current.creationCondition)
          changes.creationCondition = columns.creationCondition;
        if (columns.description !== current.description) changes.description = columns.description;
        if (changes.name !== undefined) await assertNameFree(tx, application, columns.name, id);

        // From here on, writes. Nothing that does not change is written.
        if (Object.keys(changes).length > 0) await repo.updateCollectionColumns(tx, id, changes);

        const wantedEnvironments = toEnvironments(input);
        const present = current.environmentDetails;
        const environmentsChanged =
          wantedEnvironments.length !== present.length ||
          wantedEnvironments.some((w) => !present.some((p) => p.environment === w.environment && p.notes === w.notes));
        if (environmentsChanged) await repo.replaceEnvironments(tx, id, present, wantedEnvironments);

        const fields = await reconcileFields(tx, id, current.fields, toWantedFields(input));
        const stored: StoredAssignment[] = current.variableAssignments.map((a) => ({
          id: a.id,
          variableId: a.variable.id,
          screenId: a.screen.id,
          assignmentFunction: a.assignmentFunction,
          tableFunction: a.tableFunction,
          usedIn: a.usedIn,
        }));
        const assignments = await reconcileAssignments(tx, id, stored, toWantedAssignments(input), refs);
        const derivationsChanged = await reconcileDerivations(
          tx,
          id,
          current.derivedFrom.map((d) => d.id),
          input.derivedFrom ?? [],
        );

        const nestedChanged =
          environmentsChanged ||
          derivationsChanged ||
          [fields, assignments].some((r) => r.deleted + r.updated + r.created > 0);
        if (Object.keys(changes).length === 0 && !nestedChanged) return current; // nothing was written
        if (Object.keys(changes).length === 0) await repo.touchCollection(tx, id);
        const updated = await repo.findCollectionById(tx, id);
        if (!updated) throw new Error(`collection ${id} vanished inside its own transaction`);
        return updated;
      });
    },

    async remove(id) {
      await db.auditedTransaction(async (tx) => {
        await repo.lockCollectionForUpdate(tx, id);
        const current = await repo.findCollectionRef(tx, id);
        if (!current) throw E.notFound(ELEMENT, id);
        await applications.assertApplicationActive(tx, current.applicationId);
        await repo.deleteCollection(tx, id);
      });
    },
  };
}
