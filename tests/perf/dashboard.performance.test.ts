/**
 * Module 7, department scale (NFR-10, FR-19). Run it with `npm run test:perf`; it is not part of `npm test` or of the
 * CI, because it took 12 s in one run and 27 s in another on the development machine (more than the 15 s after which a
 * check leaves `npm test`); the light version of this check is `tests/integration/dashboard.scale.test.ts`.
 *
 * One application with about 500 screens, 1000 variables, 300 collections, 2000 Jira tickets and 5000 audit records.
 * It prints the median, minimum and maximum of the endpoint for an Administrator and for a Reader, the same for one
 * statement against five in the same snapshot, and a summary of the plan PostgreSQL chooses. It asserts no time
 * threshold (a threshold would make it flaky on a busy machine); it asserts the exact figures and the contract.
 */
import '../helpers/env.js';
import { after, before, describe, it } from 'node:test';
import { startTestApp, type TestApp } from '../helpers/app.js';
import { FULL_SCALE, loadDashboardData, measureDashboard, type DashboardTruth } from '../helpers/dashboardScale.js';
import { insertApplication } from '../helpers/fixtures.js';

describe('dashboard: department scale', () => {
  let t: TestApp;
  let applicationId: number;
  let truth: DashboardTruth;

  before(async () => {
    t = await startTestApp();
    try {
      applicationId = (await insertApplication(t, { name: 'Dashboard performance' })).id;
      truth = await loadDashboardData(t, applicationId, FULL_SCALE);
    } catch (error) {
      await t.close();
      throw error;
    }
  });
  after(async () => {
    await t.close();
  });

  it('exact figures and times with the figures of a department', async () => {
    await measureDashboard(t, applicationId, truth, 20, 'PERF dashboard');
  });
});
