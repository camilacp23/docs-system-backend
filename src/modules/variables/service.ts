/**
 * Variable rules (FR-05, FR-06, FR-07; SDD Table 48, D-04, D-14, D-62, D-70). The service never sees req/res.
 *
 * @module modules/variables/service
 */
import type { Database } from '../../db/prisma.js';
import type { DataType, Environment, VariableScope } from '../../generated/prisma/client.js';
import { INT32_MAX, assertIdInRange } from '../../http/ids.js';
import { E } from '../../security/errors.js';
import type { ApplicationService } from '../applications/service.js';
import * as repo from './repository.js';

/** Noun of the resource in messages. */
const ELEMENT = 'variable';

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

/** The variables service. */
export type VariableService = {
  list(input: ListVariablesInput): Promise<{ data: repo.VariableSummaryView[]; total: number }>;
  get(id: number): Promise<repo.VariableView>;
  dependencies(id: number): Promise<repo.VariableDependenciesView>;
};

/**
 * Creates the variables service.
 *
 * @param db - Database connected as docs_app.
 * @param applications - Applications service (the parent of a listing must exist).
 */
export function createVariableService(
  db: Pick<Database, 'base' | 'prisma' | 'auditedTransaction'>,
  applications: Pick<ApplicationService, 'get'>,
): VariableService {
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
  };
}
