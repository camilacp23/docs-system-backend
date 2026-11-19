/**
 * Queries of the dependency map (Module 5: FR-15, FR-16; SDD Table 6, Table 63). Read only: nothing here writes.
 *
 * One read is one snapshot. It runs in a `REPEATABLE READ` transaction opened `READ ONLY`, so the statements below see
 * the same committed data and every edge points to a node of the same response, even if another request writes in
 * between. The graph itself is the constant text of `graph.sql`, run with the application id as the only (bound)
 * parameter; nothing is ever concatenated into the SQL.
 *
 * @module modules/dependencies/repository
 */
import { readFileSync } from 'node:fs';
import { Prisma } from '../../generated/prisma/client.js';
import type { Database } from '../../db/prisma.js';
import type { NodeType, RawGraph } from './graph.js';

/** The query of the graph (ESM: resolved next to this file; `npm run build` copies it to `dist/`). */
const GRAPH_SQL = readFileSync(new URL('./graph.sql', import.meta.url), 'utf8');

/** What one snapshot read returns for an application. */
export type GraphSnapshot = {
  applicationId: number;
  graph: RawGraph;
  /** Keys (`variable:7`) of the variables and collections present in the requested environment, if one was asked. */
  inEnvironment: Set<string> | undefined;
};

/** Hooks of the repository; production passes none. */
export type DependenciesHooks = {
  /** Runs inside the snapshot, after the graph was read and before the environment keys are (tests only). */
  afterGraph?: () => Promise<void>;
};

/** The reads of the dependency map. */
export type DependenciesRepository = {
  /** The graph of an application, or `null` when it does not exist. */
  readApplicationGraph(applicationId: number, environment?: string): Promise<GraphSnapshot | null>;
  /** The graph of the application that owns the element `type:id`, or `null` when the element does not exist. */
  readElementGraph(type: NodeType, id: number): Promise<GraphSnapshot | null>;
  /**
   * The graph of an application read on `client`, the transaction of the caller (the same statements the endpoint runs
   * in its own snapshot), or `null` when the application does not exist. The caller owns the snapshot.
   */
  readApplicationGraphOn(client: GraphClient, applicationId: number): Promise<GraphSnapshot | null>;
};

type Tx = Prisma.TransactionClient;

/** The client the graph is read on: the transaction of the caller (the module's own snapshot, or another module's). */
export type GraphClient = Pick<Tx, '$queryRaw' | '$queryRawUnsafe'>;

/** The document of `graph.sql` for one application. */
async function readGraph(tx: GraphClient, applicationId: number): Promise<RawGraph> {
  const rows = await tx.$queryRawUnsafe<{ graph: RawGraph | string }[]>(GRAPH_SQL, applicationId);
  const graph = rows[0]?.graph;
  if (graph === undefined) throw new Error('the graph query returned no row');
  return typeof graph === 'string' ? (JSON.parse(graph) as RawGraph) : graph;
}

/** Keys of the variables and collections of the application that exist in `environment`. */
async function readEnvironmentKeys(tx: GraphClient, applicationId: number, environment: string): Promise<Set<string>> {
  const rows = await tx.$queryRaw<{ id: number; type: string }[]>`
    SELECT ee.element_id AS id, ee.element_type::text AS type
      FROM element_environment ee
      JOIN documented_element e ON e.id = ee.element_id
     WHERE e.application_id = ${applicationId} AND ee.environment = ${environment}::environment`;
  return new Set(rows.map((row) => `${row.type.toLowerCase()}:${row.id}`));
}

/** The id of the application if it exists, else `null`. */
async function findApplication(tx: GraphClient, applicationId: number): Promise<number | null> {
  const rows = await tx.$queryRaw<{ id: number }[]>`SELECT id FROM application WHERE id = ${applicationId}`;
  return rows[0]?.id ?? null;
}

/**
 * Creates the repository.
 *
 * @param db - Database connected as docs_app (only the plain client is used).
 * @param hooks - Test hooks; omit in production.
 */
export function createDependenciesRepository(
  db: Pick<Database, 'base'>,
  hooks: DependenciesHooks = {},
): DependenciesRepository {
  /** One snapshot: `resolve` finds the application, then the graph (and the environment keys) are read from it. */
  const snapshot = (
    resolve: (tx: Tx) => Promise<number | null>,
    environment: string | undefined,
  ): Promise<GraphSnapshot | null> =>
    db.base.$transaction(
      async (tx) => {
        await tx.$executeRaw`SET TRANSACTION READ ONLY`;
        const applicationId = await resolve(tx);
        if (applicationId === null) return null;
        const graph = await readGraph(tx, applicationId);
        await hooks.afterGraph?.();
        const inEnvironment =
          environment === undefined ? undefined : await readEnvironmentKeys(tx, applicationId, environment);
        return { applicationId, graph, inEnvironment };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );

  return {
    readApplicationGraph: (applicationId, environment) =>
      snapshot((tx) => findApplication(tx, applicationId), environment),

    readApplicationGraphOn: async (client, applicationId) => {
      const found = await findApplication(client, applicationId);
      return found === null
        ? null
        : { applicationId: found, graph: await readGraph(client, found), inEnvironment: undefined };
    },

    readElementGraph: (type, id) =>
      snapshot(async (tx) => {
        const rows = await tx.$queryRaw<{ applicationId: number }[]>`
          SELECT application_id AS "applicationId" FROM documented_element WHERE id = ${id} AND type = ${type}::element_type`;
        return rows[0]?.applicationId ?? null;
      }, undefined),
  };
}
