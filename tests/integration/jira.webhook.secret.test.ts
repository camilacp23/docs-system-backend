/**
 * Module 4, POST /integrations/jira/webhook without JIRA_WEBHOOK_SECRET (D-96): every delivery is 401
 * INVALID_SIGNATURE and the warn names no value. Its own file because each application configures the security module
 * of the process, so two applications cannot be alive at the same time.
 */
import '../helpers/env.js';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { bodyOf } from '../helpers/app.js';
import { startJiraApp, type JiraApp } from '../helpers/jiraApp.js';
import { signWebhookBody } from '../helpers/jiraSimulator.js';
import { arrange, post, postSigned, updatedBody } from '../helpers/jiraWebhook.js';

describe('POST /integrations/jira/webhook: secret not configured', () => {
  let off: JiraApp;
  before(async () => {
    off = await startJiraApp({ env: { JIRA_WEBHOOK_SECRET: undefined } });
  });
  after(async () => {
    await off.closeAll();
  });

  it('every delivery is 401 INVALID_SIGNATURE, even a correctly signed one, and a warn names no value', async () => {
    const a = await arrange(off, 1);
    const body = updatedBody(a.subtasks[0]!, { summary: 'Nope' }, Date.now() + 1000);
    const signed = await postSigned(off, body);
    assert.equal(signed.status, 401);
    assert.equal(bodyOf(signed).code, 'INVALID_SIGNATURE');
    assert.equal((await post(off, body)).status, 401);
    const lines = off.logs.map((l) => JSON.parse(l) as Record<string, unknown>);
    assert.equal(lines.filter((l) => l['reason'] === 'SECRET_NOT_CONFIGURED' && l['level'] === 40).length, 2);
    const text = off.logs.join('\n');
    assert.ok(!text.includes(off.sim.webhookSecret));
    assert.ok(!text.includes(signWebhookBody(body, off.sim.webhookSecret)));
  });
});
