/**
 * Rules of the onboarding summary (FR-25; D-124). Read only. The service never sees req/res.
 *
 * Everything is read in ONE snapshot, one statement after the other: the application (404 when it does not exist,
 * D-70), the figures from the dashboard service (`indicatorsOn`: the counts and the approved percentage, with its
 * rounding), the graph from the dependencies service (`graphOn`: the same nodes and edges as the map), and then the
 * two small reads that neither holds (the template of App (OnStart) and the data type of the chosen variables). The
 * lists are derived from that graph by the pure rules of `summary.ts`. An archived application is read like any other.
 *
 * @module modules/onboarding/service
 */
import { assertIdInRange } from '../../http/ids.js';
import { E } from '../../security/errors.js';
import type { DashboardService } from '../dashboard/service.js';
import type { DependenciesService } from '../dependencies/service.js';
import type { OnboardingRepository, TemplateFields } from './repository.js';
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

/** The onboarding service. */
export type OnboardingService = {
  /** `GET /onboarding/summary`: the same for every role. */
  summary(applicationId: number): Promise<OnboardingSummary>;
};

/**
 * Creates the onboarding service.
 *
 * @param repository - Read-only queries of the module.
 * @param dashboard - The dashboard service (the counts and the percentage are read through it).
 * @param dependencies - The dependencies service (the graph is read through it).
 */
export function createOnboardingService(
  repository: OnboardingRepository,
  dashboard: Pick<DashboardService, 'indicatorsOn'>,
  dependencies: Pick<DependenciesService, 'graphOn'>,
): OnboardingService {
  return {
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
