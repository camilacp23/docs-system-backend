/**
 * Rules of the onboarding summary (FR-25; D-124), which is read only, and of the progress of the user (D-149). The
 * service never sees req/res.
 *
 * Everything is read in ONE snapshot, one statement after the other: the application (404 when it does not exist,
 * D-70), the figures from the dashboard service (`indicatorsOn`: the counts and the approved percentage, with its
 * rounding), the graph from the dependencies service (`graphOn`: the same nodes and edges as the map), and then the
 * two small reads that neither holds (the template of App (OnStart) and the data type of the chosen variables). The
 * lists are derived from that graph by the pure rules of `summary.ts`. An archived application is read like any other.
 *
 * The progress is the set of steps (1 to 5) that the user of the request completed in an application. It is personal:
 * every operation reads or writes only the rows of that user, who comes from the token and never from the request. It
 * is not documentation, so an archived application accepts it (D-47 does not apply); an application that does not exist
 * is a 404. Every write runs in one `auditedTransaction` (R-2: it is raw SQL); the table has no audit trigger (D-149).
 *
 * @module modules/onboarding/service
 */
import type { Database } from '../../db/prisma.js';
import { assertIdInRange } from '../../http/ids.js';
import { E } from '../../security/errors.js';
import type { DashboardService } from '../dashboard/service.js';
import type { DependenciesService } from '../dependencies/service.js';
import {
  deleteCompletedSteps,
  insertCompletedStep,
  readCompletedSteps,
  type OnboardingRepository,
  type TemplateFields,
} from './repository.js';
import { summarizeGraph, type KeyScreen, type Ref, type TopComponent } from './summary.js';

/** `data` of the response (contract `OnboardingEnvelope`). */
export type OnboardingSummary = {
  application: Ref;
  counts: { screens: number; variables: number; collections: number; components: number };
  approvedPercent: number;
  appContextScreen: {
    id: number;
    name: string;
    documentationStatus: string;
    miroLink: string | null;
    template: TemplateFields;
  };
  keyScreens: KeyScreen[];
  globalVariables: { variable: Ref; dataType: string; originScreen: Ref | null; usedByScreens: number }[];
  topComponents: TopComponent[];
};

/** Number of steps of the onboarding (SDD Section 7.3); the table, the contract and this constant agree. */
export const ONBOARDING_STEPS = 5;

/** `data` of the progress responses (contract `OnboardingProgress`). */
export type OnboardingProgress = {
  applicationId: number;
  /** Always {@link ONBOARDING_STEPS}. */
  totalSteps: number;
  /** The steps the user completed in the application, ascending and without repeats. */
  completedSteps: number[];
};

/** The onboarding service. */
export type OnboardingService = {
  /** `GET /onboarding/summary`: the same for every role. */
  summary(applicationId: number): Promise<OnboardingSummary>;
  /** `GET /onboarding/progress`: the progress of `userId` in the application. */
  progress(userId: number, applicationId: number): Promise<OnboardingProgress>;
  /** `PUT /onboarding/progress/steps/{step}`: marks the step as completed (idempotent) and returns the progress. */
  completeStep(userId: number, applicationId: number, step: number): Promise<OnboardingProgress>;
  /** `DELETE /onboarding/progress`: forgets every completed step of `userId` in the application (idempotent). */
  resetProgress(userId: number, applicationId: number): Promise<void>;
};

const toProgress = (applicationId: number, completedSteps: number[]): OnboardingProgress => ({
  applicationId,
  totalSteps: ONBOARDING_STEPS,
  completedSteps,
});

/**
 * Creates the onboarding service.
 *
 * @param repository - Read-only queries of the module.
 * @param dashboard - The dashboard service (the counts and the percentage are read through it).
 * @param dependencies - The dependencies service (the graph is read through it).
 * @param db - Database connected as docs_app: the progress is read with the plain client and written in an audited
 *   transaction.
 */
export function createOnboardingService(
  repository: OnboardingRepository,
  dashboard: Pick<DashboardService, 'indicatorsOn'>,
  dependencies: Pick<DependenciesService, 'graphOn'>,
  db: Pick<Database, 'base' | 'auditedTransaction'>,
): OnboardingService {
  return {
    async progress(userId, applicationId) {
      assertIdInRange(applicationId, 'application');
      const steps = await readCompletedSteps(db.base, userId, applicationId);
      if (steps === null) throw E.notFound('application', applicationId);
      return toProgress(applicationId, steps);
    },

    async completeStep(userId, applicationId, step) {
      assertIdInRange(applicationId, 'application');
      if (!Number.isInteger(step) || step < 1 || step > ONBOARDING_STEPS) {
        throw new RangeError(`onboarding step ${step} is outside 1..${ONBOARDING_STEPS} (the contract validates it)`);
      }
      return db.auditedTransaction(async (tx) => {
        if ((await readCompletedSteps(tx, userId, applicationId)) === null) {
          throw E.notFound('application', applicationId);
        }
        await insertCompletedStep(tx, userId, applicationId, step);
        const steps = await readCompletedSteps(tx, userId, applicationId);
        return toProgress(applicationId, steps ?? []);
      });
    },

    async resetProgress(userId, applicationId) {
      assertIdInRange(applicationId, 'application');
      await db.auditedTransaction(async (tx) => {
        if ((await readCompletedSteps(tx, userId, applicationId)) === null) {
          throw E.notFound('application', applicationId);
        }
        await deleteCompletedSteps(tx, userId, applicationId);
      });
    },

    async summary(applicationId) {
      assertIdInRange(applicationId, 'application');
      const read = await repository.inSnapshot(async (snapshot) => {
        const application = await snapshot.application(applicationId);
        if (application === null) return null;
        const { documentation, variables, collections } = await dashboard.indicatorsOn(snapshot.client, applicationId);
        const graph = await dependencies.graphOn(snapshot.client, applicationId);
        const parts = summarizeGraph(graph);
        const template = await snapshot.template(parts.appContext.id);
        const dataTypes = await snapshot.dataTypes(parts.globalVariables.map((v) => v.variable.id));
        return { application, documentation, variables, collections, parts, template, dataTypes };
      });
      if (read === null) throw E.notFound('application', applicationId);

      const { application, documentation, variables, collections, parts, template, dataTypes } = read;
      return {
        application: { id: application.id, name: application.name },
        counts: {
          screens: documentation.totalScreens,
          variables: variables.total,
          collections: collections.total,
          components: parts.componentCount,
        },
        approvedPercent: documentation.approvedPercent,
        appContextScreen: { ...parts.appContext, template },
        keyScreens: parts.keyScreens,
        globalVariables: parts.globalVariables.map((candidate) => {
          const dataType = dataTypes.get(candidate.variable.id);
          if (dataType === undefined) throw new Error(`variable ${candidate.variable.id} has no data type`);
          return { ...candidate, dataType };
        }),
        topComponents: parts.topComponents,
      };
    },
  };
}
