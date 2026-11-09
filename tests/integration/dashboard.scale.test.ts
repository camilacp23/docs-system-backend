/**
 * Module 7, a light version of the scale check (NFR-10): a few hundred rows instead of the thousands of the department
 * (the full check is `tests/perf/dashboard.performance.test.ts`, run with `npm run test:perf`). It checks that the
 * figures are exact with that much data and that every role conforms to the contract; the times are printed, never
 * asserted.
 */
import '../helpers/env.js';
import { after, before, describe, it } from 'node:test';
import { startTestApp, type TestApp } from '../helpers/app.js';
import { LIGHT_SCALE, loadDashboardData, measureDashboard, type DashboardTruth } from '../helpers/dashboardScale.js';
import { insertApplication } from '../helpers/fixtures.js';

describe('dashboard: light scale', () => {
  let t: TestApp;
  let applicationId: number;
  let truth: DashboardTruth;

  before(async () => {
    t = await startTestApp();
    try {
      applicationId = (await insertApplication(t, { name: 'Dashboard light scale' })).id;
      truth = await loadDashboardData(t, applicationId, LIGHT_SCALE);
    } catch (error) {
      await t.close();
      throw error;
    }
  });
  after(async () => {
    await t.close();
  });

  it('exact figures with a few hundred rows, for the three roles', async () => {
    await measureDashboard(t, applicationId, truth, 5, 'PERF dashboard (light)');
  });
});
