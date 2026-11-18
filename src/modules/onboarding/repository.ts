/**
 * Queries of the onboarding summary (FR-25, D-124), which are read only, and of the progress of a user (D-133), which are
 * plain functions on the client they receive.
 *
 * One read is one snapshot: a `REPEATABLE READ` transaction opened `READ ONLY`, one statement after the other on the
 * connection of the transaction (never in parallel). The counts and the graph are NOT read here: the dashboard and the
 * dependency map read them, through their services, on the client of this snapshot, so the onboarding and those two
 * use the same definitions. This repository reads only what neither of them holds: the name of the application, the
 * seven template fields of App (OnStart) and the data type of the chosen variables. Each is a small statement by
 * primary key.
 *
 * The progress (`onboarding_progress`, one row per completed step of a user in an application) is read and written
 * by the functions at the end of this file: the service gives them the client of an `auditedTransaction`.
 *
 * @module modules/onboarding/repository
 */
import { Prisma, type PrismaClient } from '../../generated/prisma/client.js';
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

/**
 * The steps a user completed in an application, ascending, in ONE statement (so the application and the steps are
 * read at the same instant).
 *
 * @param client - Transaction client or plain client.
 * @param userId - The user.
 * @param applicationId - The application.
 * @returns The completed steps, or `null` when the application does not exist.
 */
export async function readCompletedSteps(
  client: Pick<PrismaClient, '$queryRaw'>,
  userId: number,
  applicationId: number,
): Promise<number[] | null> {
  const rows = await client.$queryRaw<{ steps: number[] }[]>`
    SELECT COALESCE(
             (SELECT array_agg(p.step::int ORDER BY p.step)
                FROM onboarding_progress p
               WHERE p.user_id = ${userId} AND p.application_id = ${applicationId}),
             '{}'::int[]) AS steps
      FROM application a
     WHERE a.id = ${applicationId}`;
  return rows[0]?.steps ?? null;
}

/**
 * Marks a step as completed. A step that is already completed is left as it is (it keeps its `completed_at`), so
 * repeating the call is harmless, also when two requests arrive at the same time.
 *
 * @param client - Transaction client of `auditedTransaction`.
 * @param userId - The user.
 * @param applicationId - The application (it must exist: the foreign key rejects it otherwise).
 * @param step - The step, 1 to 5 (the table has a CHECK).
 */
export async function insertCompletedStep(
  client: Pick<PrismaClient, '$executeRaw'>,
  userId: number,
  applicationId: number,
  step: number,
): Promise<void> {
  await client.$executeRaw`
    INSERT INTO onboarding_progress (user_id, application_id, step)
    VALUES (${userId}, ${applicationId}, ${step})
    ON CONFLICT (user_id, application_id, step) DO NOTHING`;
}

/**
 * Deletes every completed step of a user in an application.
 *
 * @param client - Transaction client of `auditedTransaction`.
 * @param userId - The user.
 * @param applicationId - The application.
 */
export async function deleteCompletedSteps(
  client: Pick<PrismaClient, '$executeRaw'>,
  userId: number,
  applicationId: number,
): Promise<void> {
  await client.$executeRaw`
    DELETE FROM onboarding_progress WHERE user_id = ${userId} AND application_id = ${applicationId}`;
}
