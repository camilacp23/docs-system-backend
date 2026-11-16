/**
 * Queries of the onboarding summary (FR-25, D-124). Read only: nothing here writes.
 *
 * One read is one snapshot: a `REPEATABLE READ` transaction opened `READ ONLY`, one statement after the other on the
 * connection of the transaction (never in parallel). The counts and the graph are NOT read here: the dashboard and the
 * dependency map read them, through their services, on the client of this snapshot, so the onboarding and those two
 * use the same definitions. This repository reads only what neither of them holds: the name of the application, the
 * seven template fields of App (OnStart) and the data type of the chosen variables. Each is a small statement by
 * primary key.
 *
 * @module modules/onboarding/repository
 */
import { Prisma } from '../../generated/prisma/client.js';
import type { Database } from '../../db/prisma.js';
import type { IndicatorsClient } from '../dashboard/repository.js';
import type { GraphClient } from '../dependencies/repository.js';

/** The client of the snapshot: what the dashboard and the dependency map need to read on it. */
export type OnboardingClient = GraphClient & IndicatorsClient;

/** The seven fields of the screen template (a field never written is `null`). */
export type TemplateFields = {
  onStart: string | null;
  workingProcess: string | null;
  architecture: string | null;
  dataModel: string | null;
  requirements: string | null;
  knownIssues: string | null;
  risks: string | null;
};

/** What a snapshot lets the service do. */
export type OnboardingSnapshot = {
  /** The client of the transaction, handed to the dashboard and dependencies services. */
  client: OnboardingClient;
  /** `{ id, name }` of the application, or `null` when it does not exist. */
  application(applicationId: number): Promise<{ id: number; name: string } | null>;
  /** The template of a screen. */
  template(screenId: number): Promise<TemplateFields>;
  /** The data type of each variable, by id. */
  dataTypes(variableIds: readonly number[]): Promise<Map<number, string>>;
};

/** Hooks of the repository; production passes none. */
export type OnboardingHooks = {
  /** Runs inside the snapshot, right after the application was read and before the other reads (tests only). */
  afterApplication?: () => Promise<void>;
};

/** The reads of the onboarding summary. */
export type OnboardingRepository = {
  /** Runs `work` in one snapshot: `REPEATABLE READ`, `READ ONLY`. */
  inSnapshot<T>(work: (snapshot: OnboardingSnapshot) => Promise<T>): Promise<T>;
};

/**
 * Creates the repository.
 *
 * @param db - Database connected as docs_app (only the plain client is used).
 * @param hooks - Test hooks; omit in production.
 */
export function createOnboardingRepository(
  db: Pick<Database, 'base'>,
  hooks: OnboardingHooks = {},
): OnboardingRepository {
  return {
    inSnapshot: (work) =>
      db.base.$transaction(
        async (tx) => {
          await tx.$executeRaw`SET TRANSACTION READ ONLY`;
          return work({
            client: tx,
            application: async (applicationId) => {
              const rows = await tx.$queryRaw<{ id: number; name: string }[]>`
                SELECT id, name FROM application WHERE id = ${applicationId}`;
              await hooks.afterApplication?.();
              return rows[0] ?? null;
            },
            template: async (screenId) => {
              const rows = await tx.$queryRaw<TemplateFields[]>`
                SELECT on_start AS "onStart", working_process AS "workingProcess", architecture,
                       data_model AS "dataModel", requirements, known_issues AS "knownIssues", risks
                  FROM screen WHERE id = ${screenId}`;
              const row = rows[0];
              if (row === undefined) throw new Error(`the App (OnStart) screen ${screenId} has no row`);
              return row;
            },
            dataTypes: async (variableIds) => {
              if (variableIds.length === 0) return new Map();
              const rows = await tx.$queryRaw<{ id: number; dataType: string }[]>`
                SELECT id, data_type::text AS "dataType" FROM variable WHERE id = ANY(${[...variableIds]}::int[])`;
              return new Map(rows.map((row) => [row.id, row.dataType]));
            },
          });
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
      ),
  };
}
