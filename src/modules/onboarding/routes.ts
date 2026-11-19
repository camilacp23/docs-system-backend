/**
 * Routes of the onboarding module (Module 11): binds each operationId of the contract to its handler. Roles are not
 * declared here; the contract (x-roles) is the only source of authorization (D-39).
 *
 * @module modules/onboarding/routes
 */
import type { Database } from '../../db/prisma.js';
import type { OperationHandlers } from '../../http/operations.js';
import type { JiraClient } from '../../integrations/jira/index.js';
import { createDashboardModuleService } from '../dashboard/routes.js';
import { createDependenciesModuleService } from '../dependencies/routes.js';
import { createOnboardingController } from './controller.js';
import { createOnboardingRepository, type OnboardingHooks } from './repository.js';
import { createOnboardingService, type OnboardingService } from './service.js';

/**
 * The onboarding service, for the tests that need it without HTTP.
 *
 * @param db - Database connected as docs_app.
 * @param deps - The Jira client (the dashboard service needs it for its own endpoint; the summary never uses it).
 * @param hooks - Test hooks of the repository; production passes none.
 */
export function createOnboardingModuleService(
  db: Pick<Database, 'base' | 'auditedTransaction'>,
  deps: { jira: Pick<JiraClient, 'jiraAvailable'> },
  hooks?: OnboardingHooks,
): OnboardingService {
  return createOnboardingService(
    createOnboardingRepository(db, hooks),
    createDashboardModuleService(db, deps),
    createDependenciesModuleService(db),
    db,
  );
}

/**
 * Handlers of the /onboarding operations (the summary and the progress of the user).
 *
 * @param db - Database connected as docs_app.
 * @param deps - The Jira client (see `createOnboardingModuleService`).
 * @param hooks - Test hooks of the repository; production passes none.
 */
export function onboardingHandlers(
  db: Pick<Database, 'base' | 'auditedTransaction'>,
  deps: { jira: Pick<JiraClient, 'jiraAvailable'> },
  hooks?: OnboardingHooks,
): OperationHandlers {
  const controller = createOnboardingController(createOnboardingModuleService(db, deps, hooks));
  return {
    getOnboardingSummary: controller.summary,
    getOnboardingProgress: controller.progress,
    completeOnboardingStep: controller.completeStep,
    resetOnboardingProgress: controller.resetProgress,
  };
}
