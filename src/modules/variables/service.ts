/**
 * Variable rules (FR-05, FR-06, FR-07; SDD Table 48, D-04, D-47, D-52, D-62 to D-65, D-68 to D-71). The service never
 * sees req/res.
 *
 * Every write runs in one `auditedTransaction` and answers errors in this order:
 * 400 (repeated environment) -> 404 (variable, application, origin screen) -> 422 APPLICATION_ARCHIVED -> 412
 * (PUT; `If-Match` is always verified) -> 422 business rules (INVALID_ORIGIN_SCREEN, SCOPE_CONFLICT,
 * CONTEXT_SCREEN_MISMATCH) -> 409 DUPLICATE_NAME -> the write. The rules and the duplicate are checked here, BEFORE
 * writing, because CONTEXT_SCREEN_MISMATCH is a trigger deferred to COMMIT and the unique index would fire first and
 * invert the order; the constraints and triggers of the database stay as a backstop (translated by the errorHandler).
 *
 * @module modules/variables/service
 */
import type { Database } from '../../db/prisma.js';
import type { DataType, Environment, VariableScope } from '../../generated/prisma/client.js';
import { etagOf } from '../../http/etag.js';
import { INT32_MAX, assertIdInRange } from '../../http/ids.js';
import { repeatedFields } from '../../http/repeats.js';
import { E } from '../../security/errors.js';
import { type ApplicationService } from '../applications/service.js';
import type { ScreenService } from '../screens/service.js';
import * as repo from './repository.js';

/** Noun of the resource in messages. */
const ELEMENT = 'variable';

/** Throws the 412 when the supplied `If-Match` differs from the ETag read inside the transaction. */
export type PreconditionCheck = (currentETag: string) => void;

/** Filters of the listing, already parsed by the controller. */
export type ListVariablesInput = {
  applicationId: number;
  q?: string | undefined;
  scope?: VariableScope | undefined;
  dataType?: DataType | undefined;
  environment?: Environment | undefined;
  originScreenId?: number | undefined;
  untraced?: boolean | undefined;
  sort: repo.VariableListQuery['sort'];
  skip: number;
  take: number;
};

/** Editable representation of a variable (contract schema `VariableWrite`). */
export type VariableInput = {
  name: string;
  dataType: DataType;
  scope: VariableScope;
  description?: string | null;
  originScreenId?: number | null;
  environments: { environment: Environment; notes?: string | null }[];
};

/** Body of `POST /variables` (contract schema `VariableCreate`). */
export type CreateVariableInput = VariableInput & { applicationId: number };

/** The variables service. */
export type VariableService = {
  list(input: ListVariablesInput): Promise<{ data: repo.VariableSummaryView[]; total: number }>;
  get(id: number): Promise<repo.VariableView>;
  dependencies(id: number): Promise<repo.VariableDependenciesView>;
  create(input: CreateVariableInput): Promise<repo.VariableView>;
  update(id: number, input: VariableInput, assertCurrent: PreconditionCheck): Promise<repo.VariableView>;
  remove(id: number): Promise<void>;
  /**
   * The variable a client points at (scope, application and origin), or `null` when it does not exist or its id cannot
   * exist. Locks the row FOR SHARE: for modules that write links to a variable inside their own transaction.
   */
  findRef(client: Pick<repo.VariablesClient, '$queryRaw'>, id: number): Promise<repo.VariableRef | null>;
};

type Tx = Parameters<Parameters<Database['auditedTransaction']>[0]>[0];

/** Where the final state of the variable must be unique, for the DUPLICATE_NAME message (D-63, D-69). */
type Target = { applicationId: number; applicationName: string; origin: { id: number; name: string } | null };

/** D-65: the same environment twice in one payload is a 400 that names the position of each repetition. */
function assertDistinctEnvironments(environments: readonly { environment: Environment }[]): void {
  const fields = repeatedFields(
    environments,
    (e) => e.environment,
    (index) => `environments[${index}].environment`,
  );
  if (fields.length > 0) throw E.validation(fields);
}

const toColumns = (input: VariableInput): repo.VariableData => ({
  name: input.name,
  dataType: input.dataType,
  scope: input.scope,
  description: input.description ?? null,
  originScreenId: input.originScreenId ?? null,
});

const toEnvironments = (input: VariableInput): repo.EnvironmentInput[] =>
  [...input.environments]
    .map((e) => ({ environment: e.environment, notes: e.notes ?? null }))
    .sort((a, b) => a.environment.localeCompare(b.environment));

/**
 * Creates the variables service.
 *
 * @param db - Database connected as docs_app.
 * @param applications - Applications service (existence, name and the archived-application guard).
 * @param screens - Screens service (existence and application of the origin screen).
 */
export function createVariableService(
  db: Pick<Database, 'base' | 'prisma' | 'auditedTransaction'>,
  applications: Pick<ApplicationService, 'get' | 'assertApplicationActive'>,
  screens: Pick<ScreenService, 'findRef'>,
): VariableService {
  /** 404 `screen` when the origin screen does not exist (or cannot); `null` when the variable has none. */
  const findOrigin = async (tx: Tx, originScreenId: number | null) => {
    if (originScreenId === null) return null;
    assertIdInRange(originScreenId, 'screen');
    const origin = await screens.findRef(tx, originScreenId);
    if (!origin) throw E.notFound('screen', originScreenId);
    return origin;
  };

  /** INVALID_ORIGIN_SCREEN (D-68): the first case is checked first because it names the screen the user picked. */
  const assertValidOrigin = (
    origin: Awaited<ReturnType<typeof findOrigin>>,
    scope: VariableScope,
    applicationId: number,
    applicationName: string,
  ): void => {
    if (origin === null) return;
    if (origin.applicationId !== applicationId) {
      throw E.invalidOriginScreenOtherApplication(origin.id, origin.name, applicationName);
    }
    if (scope === 'CONTEXT' && origin.isAppContext) throw E.invalidOriginScreen();
  };

  /** DUPLICATE_NAME (D-63, D-69). Serializes the writers of nameless context variables of the application. */
  const assertNameFree = async (
    tx: Tx,
    target: Target,
    columns: repo.VariableData,
    exceptId: number | undefined,
  ): Promise<void> => {
    if (columns.scope === 'CONTEXT' && target.origin === null) {
      await repo.lockNamelessContextNames(tx, target.applicationId);
    }
    const taken = await repo.nameIsTaken(
      tx,
      {
        applicationId: target.applicationId,
        name: columns.name,
        scope: columns.scope,
        originScreenId: target.origin?.id ?? null,
      },
      exceptId,
    );
    if (!taken) return;
    if (columns.scope === 'GLOBAL') {
      throw E.duplicateName('global variable', columns.name, target.applicationName, 'application');
    }
    throw target.origin === null
      ? E.duplicateName('context variable', columns.name, target.applicationName, 'application')
      : E.duplicateName('context variable', columns.name, target.origin.name, 'screen');
  };

  return {
    async list(input) {
      // D-70: the parent application must exist (404); an id used as a filter that cannot match gives an empty page.
      assertIdInRange(input.applicationId, 'application');
      await applications.get(input.applicationId);
      if (input.originScreenId !== undefined && input.originScreenId > INT32_MAX) return { data: [], total: 0 };
      const [data, total] = await repo.listVariables(db.base, input);
      return { data, total };
    },

    async get(id) {
      const variable = await repo.findVariableById(db.base, id);
      if (!variable) throw E.notFound(ELEMENT, id);
      return variable;
    },

    async dependencies(id) {
      const dependencies = await repo.findVariableDependencies(db.base, id);
      if (!dependencies) throw E.notFound(ELEMENT, id);
      return dependencies;
    },

    async create(input) {
      assertDistinctEnvironments(input.environments);
      assertIdInRange(input.applicationId, 'application');
      const application = await applications.get(input.applicationId);
      const columns = toColumns(input);
      return db.auditedTransaction(async (tx) => {
        const origin = await findOrigin(tx, columns.originScreenId);
        await applications.assertApplicationActive(tx, application.id);
        assertValidOrigin(origin, columns.scope, application.id, application.name);
        await assertNameFree(
          tx,
          {
            applicationId: application.id,
            applicationName: application.name,
            origin: origin && { id: origin.id, name: origin.name },
          },
          columns,
          undefined,
        );
        const id = await repo.createVariable(tx, application.id, columns, toEnvironments(input));
        const created = await repo.findVariableById(tx, id);
        if (!created) throw new Error(`variable ${id} vanished inside its own transaction`);
        return created;
      });
    },

    async update(id, input, assertCurrent) {
      assertDistinctEnvironments(input.environments);
      const columns = toColumns(input);
      return db.auditedTransaction(async (tx) => {
        await repo.lockVariableForUpdate(tx, id);
        const current = await repo.findVariableById(tx, id);
        if (!current) throw E.notFound(ELEMENT, id);
        const application = await applications.get(current.applicationId);
        const origin = await findOrigin(tx, columns.originScreenId);
        await applications.assertApplicationActive(tx, current.applicationId);
        assertCurrent(etagOf(current));

        // Business rules, in the order of D-71.
        assertValidOrigin(origin, columns.scope, current.applicationId, application.name);
        const scopeChanged = columns.scope !== current.scope;
        const originChanged = columns.originScreenId !== (current.originScreen?.id ?? null);
        if (scopeChanged) {
          const incompatible = columns.scope === 'CONTEXT' ? 'SET' : 'UPDATE_CONTEXT';
          if (await repo.hasAssignmentsWith(tx, id, incompatible)) {
            throw E.scopeConflict(incompatible === 'SET' ? 'Set' : 'UpdateContext');
          }
        }
        if (columns.scope === 'CONTEXT' && (scopeChanged || originChanged)) {
          const link = await repo.findForbiddenContextLink(tx, id, columns.originScreenId);
          if (link) {
            throw E.contextScreenMismatch({
              variableId: id,
              variable: columns.name,
              originScreenId: origin?.id ?? null,
              originScreen: origin?.name ?? null,
              screenId: link.screenId,
              targetScreen: link.screenName,
            });
          }
        }

        const changes: Partial<repo.VariableData> = {};
        if (columns.name !== current.name) changes.name = columns.name;
        if (columns.dataType !== current.dataType) changes.dataType = columns.dataType;
        if (scopeChanged) changes.scope = columns.scope;
        if (columns.description !== current.description) changes.description = columns.description;
        if (originChanged) changes.originScreenId = columns.originScreenId;

        const wanted = toEnvironments(input);
        const present = current.environmentDetails;
        const environmentsChanged =
          wanted.length !== present.length ||
          wanted.some((w) => !present.some((p) => p.environment === w.environment && p.notes === w.notes));
        if (Object.keys(changes).length === 0 && !environmentsChanged) return current; // D-71: nothing to write

        // The name must be free where the variable ends up; unchanged identity cannot collide with anyone.
        if (changes.name !== undefined || scopeChanged || originChanged) {
          await assertNameFree(
            tx,
            {
              applicationId: current.applicationId,
              applicationName: application.name,
              origin: origin && { id: origin.id, name: origin.name },
            },
            columns,
            id,
          );
        }

        if (Object.keys(changes).length > 0) await repo.updateVariableColumns(tx, id, changes);
        if (environmentsChanged) {
          await repo.replaceEnvironments(tx, id, present, wanted);
          if (Object.keys(changes).length === 0) await repo.touchVariable(tx, id);
        }
        const updated = await repo.findVariableById(tx, id);
        if (!updated) throw new Error(`variable ${id} vanished inside its own transaction`);
        return updated;
      });
    },

    findRef: (client, id) => (id > INT32_MAX ? Promise.resolve(null) : repo.findVariableRefShared(client, id)),

    async remove(id) {
      await db.auditedTransaction(async (tx) => {
        await repo.lockVariableForUpdate(tx, id);
        const current = await repo.findVariableById(tx, id);
        if (!current) throw E.notFound(ELEMENT, id);
        await applications.assertApplicationActive(tx, current.applicationId);
        await repo.deleteVariable(tx, id);
      });
    },
  };
}
