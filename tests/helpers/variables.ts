/**
 * Helpers of the variables tests: the contract's response shapes and typed readers of the responses.
 * Everything runs on the disposable database of `startTestApp`.
 */

/** A reference to another resource. */
export type RefBody = { id: number; name: string };

/** A variable as the listing returns it. */
export type VariableSummaryBody = {
  id: number;
  applicationId: number;
  name: string;
  dataType: string;
  scope: 'GLOBAL' | 'CONTEXT';
  originScreen: RefBody | null;
  fullTraceability: boolean;
  environments: string[];
  createdAt: string;
  updatedAt: string;
};

/** A variable as GET, POST and PUT return it. */
export type VariableBody = VariableSummaryBody & {
  description: string | null;
  environmentDetails: { environment: string; notes: string | null }[];
};

/** The body of `GET /variables/{id}/dependencies`. */
export type DependenciesBody = {
  variable: RefBody;
  originScreen: RefBody | null;
  screens: { screen: RefBody; accessMode: string; usedIn: string }[];
  collections: {
    id: number;
    variable: RefBody;
    collection: RefBody;
    screen: RefBody;
    assignmentFunction: string;
    tableFunction: string | null;
    usedIn: string;
  }[];
  components: { component: RefBody; screen: RefBody; description: string | null }[];
};

/** Typed view of a single-variable response. */
export const variableOf = (res: { body: unknown }): VariableBody => (res.body as { data: VariableBody }).data;

/** Typed view of the variables page. */
export const variablesPageOf = (res: { body: unknown }) =>
  res.body as { data: VariableSummaryBody[]; page: number; pageSize: number; total: number };

/** Names of the variables of a page, in order. */
export const variableNames = (res: { body: unknown }): string[] => variablesPageOf(res).data.map((v) => v.name);

/** Typed view of a dependencies response. */
export const dependenciesOf = (res: { body: unknown }): DependenciesBody =>
  (res.body as { data: DependenciesBody }).data;
