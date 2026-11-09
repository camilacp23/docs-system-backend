/**
 * Module 4, POST /screens/{id}/jira-ticket when Jira cannot be used at all (NFR-14; D-45, D-89, D-92): not configured,
 * not configured for creating, and the circuit breaker open. Each case starts its own application, so each one lives in
 * its own describe: the security keys are process-wide and the last application started owns them.
 */
import '../helpers/env.js';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { bodyOf, startTestApp, type TestApp } from '../helpers/app.js';
import { insertApplication, insertScreen } from '../helpers/fixtures.js';
import { startJiraApp, type JiraApp } from '../helpers/jiraApp.js';
import { asUser } from '../helpers/users.js';

const MESSAGE = "Jira isn't responding. The to-do wasn't created. Try again in a few minutes.";
const newBody = () => ({ newStory: { summary: 'Story' }, subtask: { summary: 'Subtask' } });

describe('Jira not configured at all', () => {
  let t: TestApp;
  before(async () => {
    t = await startTestApp();
  });
  after(async () => {
    await t.close();
  });

  it('JIRA_UNAVAILABLE, and the rest of the API keeps working (NFR-14)', async () => {
    const application = await insertApplication(t);
    const screen = await insertScreen(t, application.id);
    const api = asUser(t, t.users.developer.token);
    const res = await api.post(`/screens/${screen.id}/jira-ticket`, newBody());
    assert.equal(res.status, 502);
    assert.equal(bodyOf(res).code, 'JIRA_UNAVAILABLE');
    assert.equal(bodyOf(res).message, MESSAGE);
    assert.equal(bodyOf(res).details, null);
    assert.equal((await api.get(`/screens/${screen.id}`)).status, 200);
    const created = await t.owner.query(`SELECT 1 FROM jira_ticket WHERE screen_id = $1`, [screen.id]);
    assert.equal(created.rowCount, 0);
  });
});

describe('Jira configured for reading but not for creating', () => {
  let t: JiraApp;
  before(async () => {
    t = await startJiraApp({ env: { JIRA_PROJECT_KEY: undefined } });
  });
  after(async () => {
    await t.closeAll();
  });

  it('JIRA_UNAVAILABLE without any call to Jira', async () => {
    const application = await insertApplication(t);
    const screen = await insertScreen(t, application.id);
    const res = await asUser(t, t.users.developer.token).post(`/screens/${screen.id}/jira-ticket`, newBody());
    assert.equal(res.status, 502);
    assert.equal(bodyOf(res).code, 'JIRA_UNAVAILABLE');
    assert.equal((await t.simState()).calls.length, 0);
  });
});

describe('JIRA_UNAVAILABLE with the circuit breaker open', () => {
  let breaker: JiraApp;
  before(async () => {
    breaker = await startJiraApp({ client: { breakerFailureThreshold: 1, timeoutMs: 400 } });
  });
  after(async () => {
    await breaker.closeAll();
  });

  it('after a failure that opens it, the next request fails at once without calling Jira', async () => {
    const application = await insertApplication(breaker);
    const screen = await insertScreen(breaker, application.id);
    const api = asUser(breaker, breaker.users.developer.token);
    await breaker.control('/__sim/faults', { kind: '500', appliesTo: 'create', count: 1 });
    assert.equal((await api.post(`/screens/${screen.id}/jira-ticket`, newBody())).status, 502);
    assert.equal(breaker.jira.jiraAvailable, false);
    const calls = (await breaker.simState()).calls.length;
    const res = await api.post(`/screens/${screen.id}/jira-ticket`, newBody());
    assert.equal(res.status, 502);
    assert.equal(bodyOf(res).code, 'JIRA_UNAVAILABLE');
    assert.equal((await breaker.simState()).calls.length, calls, 'no call reached Jira');
    assert.equal((await breaker.ticketsOf(screen.id)).length, 0);
  });
});
